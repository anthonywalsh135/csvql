//helpers for taking expression trees apart and putting them back together.
//the binder and every optimiser rule are written in terms of these, so none of
//them needs to know the shape of each kind of node.

//rebuilds a node with each of its children replaced by fn(child)
export function mapChildren(expr, fn) {
  const optional = (child) => (child === null ? null : fn(child));
  switch (expr.type) {
    case 'unary':
    case 'is_null':
    case 'cast':
      return { ...expr, operand: fn(expr.operand) };
    case 'binary':
      return { ...expr, left: fn(expr.left), right: fn(expr.right) };
    case 'in':
      return { ...expr, operand: fn(expr.operand), list: expr.list.map(fn) };
    case 'between':
      return { ...expr, operand: fn(expr.operand), low: fn(expr.low), high: fn(expr.high) };
    case 'like':
      return { ...expr, operand: fn(expr.operand), pattern: fn(expr.pattern) };
    case 'case':
      return {
        ...expr,
        operand: optional(expr.operand),
        branches: expr.branches.map(({ when, then }) => ({ when: fn(when), then: fn(then) })),
        otherwise: optional(expr.otherwise),
      };
    case 'call':
      return { ...expr, args: expr.args.map(fn) };
    case 'aggregate':
      return { ...expr, arg: optional(expr.arg) };
    default:
      return expr;
  }
}

export function childrenOf(expr) {
  const children = [];
  mapChildren(expr, (child) => {
    children.push(child);
    return child;
  });
  return children;
}

//the ids of every column an expression reads
export function columnsIn(expr, ids = new Set()) {
  if (expr.type === 'column') ids.add(expr.id);
  for (const child of childrenOf(expr)) columnsIn(child, ids);
  return ids;
}

export function containsAggregate(expr) {
  return expr.type === 'aggregate' || childrenOf(expr).some(containsAggregate);
}

//splits "a AND b AND c" into [a, b, c]. each part can then be placed in the
//plan on its own.
export function conjuncts(expr) {
  if (expr === null) return [];
  if (expr.type !== 'binary' || expr.op !== 'AND') return [expr];
  return [...conjuncts(expr.left), ...conjuncts(expr.right)];
}

//joins predicates back together with AND. no predicates at all is null.
export function conjoin(predicates) {
  return predicates.reduce(
    (left, right) => (left === null ? right : { type: 'binary', op: 'AND', left, right }),
    null,
  );
}
