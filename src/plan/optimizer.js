//the optimiser: a list of rewrites, each taking a plan and returning one that
//gives the same rows for less work. every rule can be switched off on its own,
//which is how the benchmarks measure what each is worth and how the tests
//check that none of them changes an answer.

import { foldConstants } from './rules/fold.js';
import { pushDownPredicates } from './rules/pushdown.js';

const RULES = { foldConstants, pushDownPredicates };

//rewrites a plan. switches names the rules to leave out, as { rule: false },
//or is false to leave the plan exactly as the binder built it.
export function optimize(plan, switches = {}) {
  if (switches === false) return plan;
  for (const name of Object.keys(switches)) {
    if (!(name in RULES)) throw new Error(`there is no optimiser rule called ${name}`);
  }
  return Object.entries(RULES).reduce(
    (current, [name, rule]) => (switches[name] === false ? current : rule(current)),
    plan,
  );
}
