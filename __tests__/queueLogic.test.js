import {
  firstCheckIndex,
  pruneAndLocate,
  frontierAfterRemoval,
} from '../queueLogic';

describe('firstCheckIndex', () => {
  // The "N left decremented by 2" bug: advanceAfterAction passed
  // frontierIndex+1 AND the walk added another +1.
  test('inclusive resumes at the given index', () => {
    expect(firstCheckIndex(5, true)).toBe(5);
    expect(firstCheckIndex(0, true)).toBe(0);
  });
  test('non-inclusive advances exactly one past', () => {
    expect(firstCheckIndex(5, false)).toBe(6);
    expect(firstCheckIndex(0, false)).toBe(1);
  });
});

describe('pruneAndLocate', () => {
  const ids = [10, 11, 12, 13, 14];

  test('no resolves: target index unchanged', () => {
    const r = pruneAndLocate(ids, [], 2);
    expect(r.pruned).toEqual(ids);
    expect(r.finalIndex).toBe(2);
    expect(r.done).toBe(false);
  });

  test('resolves before the target shift its index down', () => {
    // indices 0 and 1 resolved, target was index 3 (id 13)
    const r = pruneAndLocate(ids, [0, 1], 3);
    expect(r.pruned).toEqual([12, 13, 14]);
    expect(r.finalIndex).toBe(1); // id 13 now at index 1
    expect(r.done).toBe(false);
  });

  test('resolves after the target do not move it', () => {
    const r = pruneAndLocate(ids, [3, 4], 1);
    expect(r.pruned).toEqual([10, 11, 12]);
    expect(r.finalIndex).toBe(1);
  });

  test('no open target -> done', () => {
    const r = pruneAndLocate(ids, [0, 1], -1);
    expect(r.done).toBe(true);
    expect(r.finalIndex).toBe(-1);
  });

  test('everything resolved -> done, empty list', () => {
    const r = pruneAndLocate(ids, [0, 1, 2, 3, 4], -1);
    expect(r.pruned).toEqual([]);
    expect(r.done).toBe(true);
  });

  test('does not mutate the input', () => {
    const copy = ids.slice();
    pruneAndLocate(ids, [0], 2);
    expect(ids).toEqual(copy);
  });
});

describe('frontierAfterRemoval', () => {
  test('skip the frontier face: frontier stays, next slides in', () => {
    // list length 5, frontier at 3, remove index 3 -> new length 4
    expect(frontierAfterRemoval(3, 3, 4)).toBe(3);
  });
  test('skip the LAST face: frontier clamps to new length (person done)', () => {
    // length 4, frontier 3 (last), remove 3 -> new length 3
    expect(frontierAfterRemoval(3, 3, 3)).toBe(3);
  });
  test('reset a past face: frontier shifts down one', () => {
    // frontier 5, remove a face at index 2 -> new length 6
    expect(frontierAfterRemoval(5, 2, 6)).toBe(4);
  });
  test('reset the very first past face', () => {
    expect(frontierAfterRemoval(1, 0, 3)).toBe(0);
  });
});
