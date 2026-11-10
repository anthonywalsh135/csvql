//the logical plan is a tree of relational operators, each reading rows from
//the nodes beneath it:
//
//  scan       reads the columns it is asked for from one file
//  one-row    a single empty row, for a query with no FROM
//  filter     keeps the rows its predicate is true for
//  join       pairs rows of its left and right inputs
//  aggregate  groups rows and computes aggregates for each group
//  sort       orders rows by a list of keys
//  top-n      a sort that only keeps the first few rows
//  project    computes the expressions of the select list
//  distinct   drops repeated rows
//  limit      skips an offset and stops after a count
//
//a column is known by a number given to it when the query is bound, never by
//its position. that is what lets the optimiser move operators around without
//renumbering anything. positions are only worked out when the plan runs.

export function inputsOf(node) {
  if (node.type === 'join') return [node.left, node.right];
  return node.input === undefined ? [] : [node.input];
}

//a copy of the node with each of its inputs replaced by fn(input)
export function mapInputs(node, fn) {
  if (node.type === 'join') return { ...node, left: fn(node.left), right: fn(node.right) };
  return node.input === undefined ? node : { ...node, input: fn(node.input) };
}

//the ids of the columns in a node's rows, in the order the rows carry them
export function outputColumns(node) {
  switch (node.type) {
    case 'scan':
      return node.columns.map((column) => column.id);
    case 'one-row':
      return [];
    case 'join':
      return [...outputColumns(node.left), ...outputColumns(node.right)];
    case 'aggregate':
      return [...node.groups, ...node.aggregates].map((column) => column.id);
    case 'project':
      return node.items.map((item) => item.id);
    default:
      return outputColumns(node.input);
  }
}
