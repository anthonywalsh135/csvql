//finds the name someone probably meant, so that an error about a table, column
//or function that does not exist can offer the one that does.

//the number of slips that turn one string into the other, where a slip is a
//letter added, dropped or changed, or two neighbouring letters swapped. the
//table is filled a row at a time and only the last three rows are ever held.
function editDistance(a, b) {
  let twoBack = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const change = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let best = Math.min(previous[j] + 1, current[j - 1] + 1, change);
      //swapped letters are the most common typo, so "nmae" is one slip from
      //"name" rather than two
      const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
      if (swapped) best = Math.min(best, twoBack[j - 2] + 1);
      current[j] = best;
    }
    twoBack = previous;
    previous = current;
  }
  return previous[b.length];
}

//the candidate nearest to the name, or null when nothing is near enough for a
//suggestion to be more help than noise
export function closestMatch(name, candidates) {
  const target = name.toLowerCase();
  let best = null;
  let bestDistance = Math.max(1, Math.floor(target.length / 3)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

//the end of an error message: '; did you mean "x"?', or nothing
export function didYouMean(name, candidates) {
  const match = closestMatch(name, candidates);
  return match === null ? '' : `; did you mean "${match}"?`;
}
