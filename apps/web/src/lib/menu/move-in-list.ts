/**
 * The list with the entry at `idx` moved `delta` places (-1 = up, 1 = down).
 * Out of range returns the same array, so a press on the first row's "up"
 * is a no-op rather than an error.
 */
export function moveInList<T>(list: readonly T[], idx: number, delta: number): T[] {
  const to = idx + delta;
  if (idx < 0 || idx >= list.length || to < 0 || to >= list.length) {
    return list as T[];
  }
  const next = [...list];
  const [moved] = next.splice(idx, 1);
  next.splice(to, 0, moved as T);
  return next;
}
