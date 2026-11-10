//constant folding. any part of an expression that does not depend on a row is
//worked out once, while planning, instead of once for every row. it is done by
//compiling and running the expression the way the executor would, so a folded
//value is always the value the query would have computed.

import { compileExpr } from '../../exec/expression.js';
import { childrenOf, mapChildren } from '../expressions.js';
import { mapExpressions, mapInputs } from '../nodes.js';

const KEPT = new Set(['literal', 'column', 'aggregate']);

function fold(expr) {
  const folded = mapChildren(expr, fold);
  if (KEPT.has(folded.type)) return folded;
  if (!childrenOf(folded).every((child) => child.type === 'literal')) return folded;
  try {
    return { type: 'literal', value: compileExpr(folded)([]) };
  } catch {
    //something like 1 + 'a'. it is left alone, so that the error is reported
    //only if a row actually reaches it, as it would be without this rule.
    return folded;
  }
}

export function foldConstants(plan) {
  return mapExpressions(mapInputs(plan, foldConstants), fold);
}
