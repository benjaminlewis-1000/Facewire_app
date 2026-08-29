// Pure helpers for the group-based labeling queue. Extracted from App.js
// so the index arithmetic (which has bitten us more than once) is unit
// testable without React / network in the loop.

/**
 * First faceIds index settleGroup should check.
 *   inclusive  -> re-check `startWithin` itself (resume where we were)
 *   !inclusive -> start at `startWithin + 1` (advance past the current)
 */
export function firstCheckIndex(startWithin, inclusive) {
  return inclusive ? startWithin : startWithin + 1;
}

/**
 * After walking a group and collecting which face *indices* were resolved
 * elsewhere (and which index is the open target, or -1), produce the
 * pruned faceIds list and the target's index within it.
 *
 * @param {number[]} faceIds
 * @param {Iterable<number>} resolvedIndices - indices into `faceIds`
 * @param {number} targetIndex - index of the open face, or -1 / not found
 * @returns {{ pruned:number[], finalIndex:number, done:boolean }}
 */
export function pruneAndLocate(faceIds, resolvedIndices, targetIndex) {
  const resolvedFids = new Set();
  for (const i of resolvedIndices) resolvedFids.add(faceIds[i]);

  const pruned = resolvedFids.size
    ? faceIds.filter((id) => !resolvedFids.has(id))
    : faceIds.slice();

  const targetFid = targetIndex >= 0 ? faceIds[targetIndex] : null;
  const finalIndex = targetFid != null ? pruned.indexOf(targetFid) : -1;

  return { pruned, finalIndex, done: pruned.length === 0 || finalIndex < 0 };
}

/**
 * Where the frontier lands after removing the face at `removeIndex`
 * (skip / reset / none-of-the-above). Removing a face *before* the
 * frontier shifts it down one; removing the frontier face itself leaves
 * it in place (the next face slides in). Clamped to the new length
 * (== length => the person is finished).
 */
export function frontierAfterRemoval(frontierIndex, removeIndex, newLength) {
  const shifted = frontierIndex > removeIndex ? frontierIndex - 1 : frontierIndex;
  return Math.min(shifted, newLength);
}
