import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../ReviewGrid', () => ({ PAGE_LIMIT: 6 }));
jest.mock('../auth', () => ({ authedFetch: jest.fn() }));

import { authedFetch } from '../auth';
import { Image } from 'react-native';
import useReviewQueue from '../useReviewQueue';

const mkFaces = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ({
    id: from + i,
    face_img_url: `u${from + i}`,
  }));

// Render the hook in a throwaway host and expose its latest return value.
let latest;
function Host(props) {
  latest = useReviewQueue(props);
  return null;
}

const mount = async (props) => {
  let tr;
  await act(async () => {
    tr = TestRenderer.create(<Host {...props} />);
  });
  return tr;
};

const flush = () => act(async () => { await Promise.resolve(); });

const baseProps = (over = {}) => ({
  visible: true,
  submitUrl: 'https://x/api/mobile/bulk_verify/',
  buildBody: (verify_ids, reset_ids) => ({ verify_ids, reset_ids }),
  fetchPage: jest.fn(async () => ({ faces: mkFaces(20) })),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  if (!Image.prefetch) Image.prefetch = jest.fn();
  jest.spyOn(Image, 'prefetch').mockResolvedValue(true);
  authedFetch.mockResolvedValue({ ok: true, status: 200 });
});

test('initial load windows the buffer down to one screenful', async () => {
  await mount(baseProps());
  expect(latest.loading).toBe(false);
  expect(latest.faces.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
});

test('toggle adds then removes an id from the excluded set', async () => {
  await mount(baseProps());
  await act(async () => latest.toggle(3));
  expect([...latest.excluded]).toEqual([3]);
  await act(async () => latest.toggle(3));
  expect([...latest.excluded]).toEqual([]);
});

test('submit sends untapped faces as keep, tapped faces as flag', async () => {
  await mount(baseProps());
  await act(async () => {
    latest.toggle(2);
    latest.toggle(5);
  });
  await act(async () => {
    await latest.submit();
  });

  const patch = authedFetch.mock.calls.find(
    ([, opts]) => opts && opts.method === 'PATCH'
  );
  expect(patch[0]).toBe('https://x/api/mobile/bulk_verify/');
  expect(JSON.parse(patch[1].body)).toEqual({
    verify_ids: [1, 3, 4, 6],
    reset_ids: [2, 5],
  });
});

test('submit advances to the next buffered page with no extra fetch', async () => {
  const props = baseProps();
  await mount(props);
  props.fetchPage.mockClear();

  await act(async () => {
    await latest.submit();
  });

  expect(latest.faces.map((f) => f.id)).toEqual([7, 8, 9, 10, 11, 12]);
  expect(latest.loading).toBe(false);
  // Buffer still had 14 left -> no refetch, only the PATCH.
  expect(props.fetchPage).not.toHaveBeenCalled();
});

test('submit clears the excluded set for the new page', async () => {
  await mount(baseProps());
  await act(async () => latest.toggle(1));
  await act(async () => { await latest.submit(); });
  expect([...latest.excluded]).toEqual([]);
});

test('submit refetches when the buffer runs dry', async () => {
  const props = baseProps({
    fetchPage: jest
      .fn()
      .mockResolvedValueOnce({ faces: mkFaces(6, 1) })
      .mockResolvedValue({ faces: mkFaces(6, 100) }),
  });
  await mount(props);
  expect(latest.faces.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);

  await act(async () => { await latest.submit(); });

  expect(props.fetchPage.mock.calls.length).toBeGreaterThan(1);
  expect(latest.faces.map((f) => f.id)).toEqual([100, 101, 102, 103, 104, 105]);
});

test('a network error from fetchPage surfaces as `error`', async () => {
  await mount(
    baseProps({
      fetchPage: jest.fn(async () => {
        throw new Error('network');
      }),
    })
  );
  expect(latest.faces).toEqual([]);
  expect(latest.error).toMatch(/connection/i);
});

test('a failed PATCH still advances but sets an error banner', async () => {
  authedFetch.mockResolvedValue({ ok: false, status: 500 });
  await mount(baseProps());
  await act(async () => { await latest.submit(); });
  await flush();
  expect(latest.faces.map((f) => f.id)).toEqual([7, 8, 9, 10, 11, 12]); // advanced
  expect(latest.error).toMatch(/save/i);
});

test('faces already shown are not served again (seen dedupe)', async () => {
  const seenSeen = [];
  const props = baseProps({
    fetchPage: jest.fn(async (seen) => {
      seenSeen.push([...seen]);
      // Always returns ids 1..10; the hook must drop the ones already buffered.
      return { faces: mkFaces(10) };
    }),
  });
  await mount(props);
  // Buffer filled from the first batch; a follow-up fill sees them in `seen`.
  await act(async () => { await latest.reload(); });
  const lastSeen = seenSeen[seenSeen.length - 1];
  expect(lastSeen).toEqual(expect.arrayContaining([1, 2, 3]));
});

test('pageSize change re-windows the visible faces', async () => {
  const tr = await mount(baseProps({ pageSize: 6 }));
  expect(latest.faces.length).toBe(6);
  await act(async () => {
    tr.update(<Host {...baseProps({ pageSize: 9 })} />);
  });
  await flush();
  expect(latest.faces.length).toBe(9);
});
