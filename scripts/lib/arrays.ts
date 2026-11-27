/**
 * Scripts — appending to and measuring large arrays
 *
 * This module deals with arrays too long to spread into one call. A
 * spread passes every element as an argument on the call stack, so
 * `target.push(...items)` or `Math.max(...items)` throws "Maximum call
 * stack size exceeded" once `items` holds more than about 120,000
 * elements. A plan of 60,000 rows builds twice as many statements, so
 * the scripts never spread a list of read rows or built statements into
 * a call; they use these helpers instead.
 *
 * `appendAll(target, items)` pushes each item onto `target`, in order,
 * and returns `target`, as `target.push(...items)` would leave it.
 * `maxOf(items)` gives what `Math.max(...items)` gives: -Infinity for
 * no items, NaN when any item is NaN. An array literal spread
 * (`[...a, ...b]`) builds the array without passing arguments, so it
 * needs no helper.
 *
 * @version v0.9.0
 */

/** Pushes each item onto `target`, in order, one call at a time. */
export function appendAll<T>(target: T[], items: Iterable<T>): T[] {
  for (const item of items) target.push(item);
  return target;
}

/** The largest of `items`, as `Math.max(...items)` gives it. */
export function maxOf(items: Iterable<number>): number {
  let max = -Infinity;
  for (const item of items) {
    if (Number.isNaN(item)) return NaN;
    max = Math.max(max, item);
  }
  return max;
}

// @version v0.9.0
