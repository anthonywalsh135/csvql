//the binder. takes the parser's tree and a description of each file it names,
//and produces a logical plan. every name is tied to one column of one table,
//stars are expanded, aggregates are pulled out of the expressions around them,
//and the query is checked against the rules sql has about grouping.

import { BindError } from '../errors.js';
import { AGGREGATES } from '../exec/aggregates.js';
import { FUNCTIONS } from '../exec/functions.js';
import { formatExpr } from '../sql/format.js';
import { didYouMean } from '../suggest.js';
import { containsAggregate, mapChildren } from './expressions.js';

//two expressions with the same key compute the same thing. columns are written
//by id, so the same name from two different tables does not collide.
const keyOf = (expr) => formatExpr(expr, (column) => `#${column.id}`);

const columnRef = ({ id, name, label }, pos) => ({ type: 'column', id, name, label, pos });

function arityOf({ min, max }) {
  if (max === Infinity) return `at least ${min}`;
  return min === max ? String(min) : `${min} to ${max}`;
}

class Binder {
  constructor(tableCount) {
    this.nextId = 0;
    this.relations = [];
    //with a single table a bare column name cannot be misread, and plans are
    //easier to follow without the table in front of every column
    this.qualify = tableCount > 1;
  }

  addRelation(ref, table) {
    const alias = ref.alias ?? table.name;
    const key = alias.toLowerCase();
    if (this.relations.some((relation) => relation.key === key)) {
      const message = `the name "${alias}" is used for two tables; give one of them an alias`;
      throw new BindError(message, ref.pos);
    }
    const columns = table.columns.map(({ name, type }, index) => ({
      id: this.nextId++,
      name,
      type,
      index,
      label: this.qualify ? `${alias}.${name}` : name,
    }));
    this.relations.push({ alias, key, columns });
    return { type: 'scan', table, alias, columns };
  }

  bindFrom(select, tables) {
    if (select.from === null) return { type: 'one-row' };
    let plan = this.addRelation(select.from, tables[0]);
    select.joins.forEach((join, index) => {
      const right = this.addRelation(join.table, tables[index + 1]);
      //ON sees the tables joined so far, but not the ones that come after it
      const context = { scope: [...this.relations], clause: 'ON', aggregates: false };
      const condition = join.on === null ? null : this.bindExpr(join.on, context);
      plan = { type: 'join', kind: join.kind, left: plan, right, condition };
    });
    return plan;
  }

  resolveColumn(node, context) {
    const wanted = node.name.toLowerCase();
    let relations = context.scope;
    if (node.table !== null) {
      relations = relations.filter((relation) => relation.key === node.table.toLowerCase());
      if (relations.length === 0) {
        const tables = context.scope.map((relation) => relation.alias);
        const hint = didYouMean(node.table, tables);
        throw new BindError(
          `there is no table called "${node.table}" in this query${hint}`,
          node.pos,
        );
      }
    }
    const found = relations.flatMap((relation) =>
      relation.columns.filter((column) => column.name.toLowerCase() === wanted),
    );

    //ORDER BY prefers the name of an output column, as the standard says.
    //everywhere else a real column wins and an alias is the fallback.
    const alias = node.table === null ? context.aliases?.get(wanted) : undefined;
    if (alias !== undefined && (context.aliasFirst || found.length === 0)) return alias;

    if (found.length === 0) {
      const names = context.scope.flatMap((relation) => relation.columns.map(({ name }) => name));
      throw new BindError(`unknown column "${node.name}"${didYouMean(node.name, names)}`, node.pos);
    }
    if (found.length > 1) {
      const choices = found.map((column) => column.label).join(' or ');
      const message = `column "${node.name}" is in more than one table; write ${choices}`;
      throw new BindError(message, node.pos);
    }
    return columnRef(found[0], node.pos);
  }

  bindCall(node, context) {
    const { name, args, pos } = node;
    if (AGGREGATES.has(name)) return this.bindAggregate(node, context);

    const fn = FUNCTIONS.get(name);
    if (fn === undefined) {
      const known = [...FUNCTIONS.keys(), ...AGGREGATES.keys()];
      throw new BindError(`unknown function ${name}${didYouMean(name, known)}`, pos);
    }
    if (node.star || node.distinct) {
      throw new BindError(`${name} is not an aggregate, so it cannot take * or DISTINCT`, pos);
    }
    if (args.length < fn.min || args.length > fn.max) {
      const message = `${name} takes ${arityOf(fn)} arguments but was given ${args.length}`;
      throw new BindError(message, pos);
    }
    return { type: 'call', name, args: args.map((arg) => this.bindExpr(arg, context)) };
  }

  bindAggregate(node, context) {
    const { name, args, pos } = node;
    if (!context.aggregates) {
      const advice = context.clause === 'WHERE' ? '; to filter on an aggregate, use HAVING' : '';
      throw new BindError(`${name} cannot be used in ${context.clause}${advice}`, pos);
    }
    if (node.star && name !== 'COUNT') throw new BindError(`only COUNT can take *`, pos);
    if (!node.star && args.length !== 1) {
      throw new BindError(`${name} takes 1 argument but was given ${args.length}`, pos);
    }
    //an aggregate cannot contain another, so its argument is bound with them off
    const inside = { ...context, aggregates: false, clause: `the argument of ${name}` };
    const arg = node.star ? null : this.bindExpr(args[0], inside);
    return { type: 'aggregate', func: name, arg, distinct: node.distinct, pos };
  }

  bindExpr(node, context) {
    if (node.type === 'column') return this.resolveColumn(node, context);
    if (node.type === 'call') return this.bindCall(node, context);
    return mapChildren(node, (child) => this.bindExpr(child, context));
  }

  //a term of GROUP BY or ORDER BY, which may be the position of a select item
  //instead of an expression: ORDER BY 2 sorts by the second column
  bindTerm(node, items, context) {
    if (node.type !== 'literal' || !Number.isInteger(node.value)) {
      return this.bindExpr(node, context);
    }
    const item = items[node.value - 1];
    if (item === undefined) {
      const message = `${context.clause} position ${node.value} is not in the select list, which has ${items.length}`;
      throw new BindError(message);
    }
    return item.expr;
  }

  bindSelectList(select, scope) {
    const items = [];
    for (const column of select.columns) {
      if (column.type === 'expr') {
        const expr = this.bindExpr(column.expr, { scope, clause: 'SELECT', aggregates: true });
        //an unnamed column is headed by its own name, or else by what was typed
        const name = column.alias ?? (expr.type === 'column' ? expr.name : column.text);
        items.push({ expr, name, alias: column.alias });
        continue;
      }
      const wanted = column.table?.toLowerCase();
      const relations = scope.filter((relation) => wanted === undefined || relation.key === wanted);
      if (relations.length === 0) {
        const message =
          wanted === undefined
            ? 'SELECT * needs a FROM clause'
            : `there is no table called "${column.table}" in this query`;
        throw new BindError(message, column.pos);
      }
      for (const relation of relations) {
        for (const found of relation.columns) {
          items.push({ expr: columnRef(found, column.pos), name: found.name, alias: null });
        }
      }
    }
    return items;
  }

  //splits the query at the point where grouping happens. below it go the
  //group keys and the aggregates; above it, every expression is rewritten to
  //read their results. a column that is neither grouped nor aggregated has no
  //single value for a group, which is the error sql is strict about.
  bindGrouping(plan, groupExprs, clauses) {
    const groups = [];
    for (const expr of groupExprs) {
      const key = keyOf(expr);
      if (containsAggregate(expr)) throw new BindError('GROUP BY cannot contain an aggregate');
      if (groups.every((group) => group.key !== key)) {
        groups.push({ id: this.nextId++, expr, label: formatExpr(expr), key });
      }
    }

    const aggregates = [];
    const lift = (expr) => {
      const key = keyOf(expr);
      let source = groups.find((group) => group.key === key);
      if (source === undefined && expr.type === 'aggregate') {
        source = aggregates.find((aggregate) => aggregate.key === key);
        if (source === undefined) {
          const { func, arg, distinct } = expr;
          source = { id: this.nextId++, func, arg, distinct, label: formatExpr(expr), key };
          aggregates.push(source);
        }
      }
      if (source !== undefined) return { type: 'column', id: source.id, label: source.label };
      if (expr.type === 'column') {
        const message = `column "${expr.label}" must appear in GROUP BY or be used inside an aggregate`;
        throw new BindError(message, expr.pos);
      }
      return mapChildren(expr, lift);
    };

    const lifted = {
      items: clauses.items.map((item) => ({ ...item, expr: lift(item.expr) })),
      having: clauses.having === null ? null : lift(clauses.having),
      orderKeys: clauses.orderKeys.map((key) => ({ ...key, expr: lift(key.expr) })),
    };
    let grouped = { type: 'aggregate', input: plan, groups, aggregates };
    if (lifted.having !== null) {
      grouped = { type: 'filter', input: grouped, predicate: lifted.having };
    }
    return { plan: grouped, ...lifted };
  }

  bind(select, tables) {
    let plan = this.bindFrom(select, tables);
    const scope = this.relations;
    if (select.where !== null) {
      const predicate = this.bindExpr(select.where, { scope, clause: 'WHERE', aggregates: false });
      plan = { type: 'filter', input: plan, predicate };
    }

    let items = this.bindSelectList(select, scope);
    const aliases = new Map();
    for (const { alias, expr } of items) {
      if (alias !== null && !aliases.has(alias.toLowerCase())) {
        aliases.set(alias.toLowerCase(), expr);
      }
    }

    const grouping = { scope, aliases, clause: 'GROUP BY', aggregates: false };
    const groupExprs = select.groupBy.map((node) => this.bindTerm(node, items, grouping));
    const filtering = { scope, aliases, clause: 'HAVING', aggregates: true };
    const having = select.having === null ? null : this.bindExpr(select.having, filtering);
    const ordering = { scope, aliases, clause: 'ORDER BY', aggregates: true, aliasFirst: true };
    let orderKeys = select.orderBy.map(({ expr, descending }) => ({
      expr: this.bindTerm(expr, items, ordering),
      descending,
    }));

    const isGrouped =
      groupExprs.length > 0 ||
      having !== null ||
      [...items, ...orderKeys].some(({ expr }) => containsAggregate(expr));
    if (isGrouped) {
      ({ plan, items, orderKeys } = this.bindGrouping(plan, groupExprs, {
        items,
        having,
        orderKeys,
      }));
    }

    const projected = items.map(({ expr, name }) => ({ id: this.nextId++, name, expr }));
    if (select.distinct) {
      //duplicates are judged on the output columns, so the sort comes after
      //them and can only use what is still there to sort by
      plan = { type: 'distinct', input: { type: 'project', input: plan, items: projected } };
      const keys = orderKeys.map(({ expr, descending }) => {
        const item = projected.find((candidate) => keyOf(candidate.expr) === keyOf(expr));
        if (item === undefined) {
          const message =
            'with SELECT DISTINCT, ORDER BY can only use expressions from the select list';
          throw new BindError(message);
        }
        return { expr: { type: 'column', id: item.id, label: item.name }, descending };
      });
      if (keys.length > 0) plan = { type: 'sort', input: plan, keys };
    } else {
      //sorting first means ORDER BY can use columns that are not selected
      if (orderKeys.length > 0) plan = { type: 'sort', input: plan, keys: orderKeys };
      plan = { type: 'project', input: plan, items: projected };
    }

    if (select.limit !== null) {
      plan = { type: 'limit', input: plan, limit: select.limit, offset: select.offset };
    }
    return { plan, columns: projected.map((item) => item.name) };
  }
}

//binds a parsed SELECT against its tables, given in the order the query names
//them. returns the logical plan and the headings of the result columns.
export function bind(select, tables) {
  return new Binder(tables.length).bind(select, tables);
}
