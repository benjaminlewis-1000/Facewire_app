import { useState, useEffect, useCallback, useRef } from 'react';
import { Image } from 'react-native';

import { authedFetch } from './auth';
import { PAGE_LIMIT } from './ReviewGrid';

/**
 * Shared state machine for the tap-to-flag review grids (confirm ignored,
 * verify people, verify ignored).
 *
 * It keeps a BUFFER of fetched faces so advancing to the next screenful
 * after a submit is instant (a local slice, no spinner) as long as the
 * buffer is stocked; it tops the buffer up in the background whenever it
 * runs low. A spinner only shows on the very first load or when the
 * buffer genuinely empties (e.g. moving to the next person).
 *
 * The screen supplies:
 *   fetchPage(seen)  async -> { faces: [{id, face_img_url}], meta? }
 *                    Return as many faces as you like -- the hook windows
 *                    them to one screenful. `seen` is every id shown this
 *                    session. Throw `new Error('network')` on connectivity
 *                    failure.
 *   buildBody(keepIds, flagIds) -> object   PATCH body for submitUrl
 *   submitUrl        the bulk-action endpoint
 *   onPage(meta)     optional; runs after each fetch with that fetch's meta
 *
 * Returns { faces, excluded, toggle, loading, busy, error, submit, reload,
 * setError }. `submit` returns true once the write landed (so callers with
 * their own running totals only advance them on success).
 */
export default function useReviewQueue({ visible, fetchPage, buildBody, submitUrl, onPage }) {
  const [faces, setFaces] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true); // nothing to show yet
  const [busy, setBusy] = useState(false); // a submit is in flight
  const [error, setError] = useState('');

  const seen = useRef(new Set());
  const bufferRef = useRef([]);
  const inFlightRef = useRef(null);

  // Pull one batch from the screen and append the genuinely-new faces to
  // the buffer. Returns how many were added.
  const topUp = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    inFlightRef.current = (async () => {
      try {
        const { faces: batch = [], meta = null } = await fetchPage(seen.current);
        const have = new Set(bufferRef.current.map((f) => f.id));
        const fresh = batch.filter((f) => !have.has(f.id));
        fresh.forEach((f) => {
          seen.current.add(f.id);
          Image.prefetch(f.face_img_url);
        });
        bufferRef.current = bufferRef.current.concat(fresh);
        if (onPage) onPage(meta);
        return fresh.length;
      } catch (e) {
        console.warn('useReviewQueue topUp failed:', e);
        setError(
          e.message === 'network'
            ? 'No connection — check your network, then reopen this screen.'
            : 'Could not load. Reopen to try again.'
        );
        return 0;
      } finally {
        inFlightRef.current = null;
      }
    })();
    return inFlightRef.current;
  }, [fetchPage, onPage]);

  const showWindow = useCallback(() => {
    setFaces(bufferRef.current.slice(0, PAGE_LIMIT));
    setExcluded(new Set());
  }, []);

  // Keep fetching until the buffer holds `want` faces or the source dries
  // up. One extra try after a no-progress fetch covers the case where the
  // screen just switched context (e.g. pinned person exhausted -> next).
  const fill = useCallback(
    async (want) => {
      for (let i = 0; i < 8 && bufferRef.current.length < want; i++) {
        const before = bufferRef.current.length;
        await topUp();
        if (bufferRef.current.length === before) {
          await topUp();
          if (bufferRef.current.length === before) break;
        }
      }
    },
    [topUp]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    bufferRef.current = [];
    seen.current = new Set();
    await fill(PAGE_LIMIT * 2);
    showWindow();
    setLoading(false);
  }, [fill, showWindow]);

  useEffect(() => {
    if (visible) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toggle = useCallback((id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (busy || loading || faces.length === 0) return false;
    const keep = faces.filter((f) => !excluded.has(f.id)).map((f) => f.id);
    const flag = faces.filter((f) => excluded.has(f.id)).map((f) => f.id);
    const consumed = faces.length;

    setBusy(true);
    let ok = false;
    try {
      const resp = await authedFetch(submitUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(keep, flag)),
      });
      ok = resp.ok;
    } catch (e) {
      console.warn('review submit failed:', e);
    }
    if (!ok) {
      setError("Couldn't save that batch — try again.");
      setBusy(false);
      return false;
    }

    bufferRef.current = bufferRef.current.slice(consumed);
    if (bufferRef.current.length === 0) {
      // Nothing buffered (e.g. moved past this person) -> real fetch.
      setLoading(true);
      await fill(PAGE_LIMIT);
      showWindow();
      setLoading(false);
    } else {
      showWindow(); // instant
      if (bufferRef.current.length < PAGE_LIMIT * 2) fill(PAGE_LIMIT * 2); // bg
    }
    setBusy(false);
    return true;
  }, [busy, loading, faces, excluded, buildBody, submitUrl, fill, showWindow]);

  return { faces, excluded, toggle, loading, busy, error, submit, reload: load, setError };
}
