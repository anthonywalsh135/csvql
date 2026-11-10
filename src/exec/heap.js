//a bounded heap. it can be offered any number of items and keeps only the
//smallest few of them. the items are held as a binary max-heap in an array, so
//the largest one being kept, which is the one a newcomer has to beat, is
//always at the front.

export class BoundedHeap {
  constructor(capacity, compare) {
    this.capacity = capacity;
    this.compare = compare;
    this.items = [];
  }

  //keeps the item if there is room, or if it is smaller than the largest item
  //kept so far, which it then replaces
  offer(item) {
    const { items } = this;
    if (items.length < this.capacity) {
      items.push(item);
      this.siftUp(items.length - 1);
    } else if (items.length > 0 && this.compare(item, items[0]) < 0) {
      items[0] = item;
      this.siftDown(0);
    }
  }

  siftUp(index) {
    const { items, compare } = this;
    const item = items[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compare(item, items[parent]) <= 0) break;
      items[index] = items[parent];
      index = parent;
    }
    items[index] = item;
  }

  siftDown(index) {
    const { items, compare } = this;
    const item = items[index];
    //nodes in the second half of the array have no children
    const firstLeaf = items.length >> 1;
    while (index < firstLeaf) {
      let child = 2 * index + 1;
      if (child + 1 < items.length && compare(items[child + 1], items[child]) > 0) child += 1;
      if (compare(items[child], item) <= 0) break;
      items[index] = items[child];
      index = child;
    }
    items[index] = item;
  }

  //the items that were kept, smallest first
  sorted() {
    return this.items.toSorted(this.compare);
  }
}
