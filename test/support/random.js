//a small seeded random number generator (mulberry32). the property tests draw
//everything from one of these, so a failure can be replayed from its seed.

export function createRandom(seed) {
  let state = seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  //a whole number from min to max, both included
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => items[int(0, items.length - 1)],
  };
}
