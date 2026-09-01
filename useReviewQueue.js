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
 * Returns { faces, excluded, toggle, loading, busy, cooldown, error, submit,
 * reload, setError }. `submit` returns true once the write landed (so
 * callers with their own running totals only advance them on success).
 */
const SUBMIT_COOLDOWN_MS = 500;

export default function useReviewQueue({
  visible,
  fetchPage,
  buildBody,
  submitUrl,
  onPage,
  pageSize = PAGE_LIMIT,
  cooldownMs = SUBMIT_COOLDOWN_MS, // overridable in tests
}) {
  const page = Math.max(3, pageSize || PAGE_LIMIT);
  const [faces, setFaces] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true); // nothing to show yet
  const [busy, setBusy] = useState(false); // a submit is in flight
  // Briefly true right after a new page appears, so a fast double-tap
  // that lands the submit button doesn't also fire it on the next
  // (different) screenful.
  const [cooldown, setCooldown] = useState(false);
  const [error, setError] = useState('');

  const seen = useRef(new Set());
  const bufferRef = useRef([]);
  const inFlightRef = useRef(null);
  const submitLockRef = useRef(false);
  const cooldownTimerRef = useRef(null);

  const armCooldown = useCallback(() => {
    if (cooldownMs <= 0) return;
    setCooldown(true);
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = setTimeout(() => setCooldown(false), cooldownMs);
  }, [cooldownMs]);

  useEffect(() => () => clearTimeout(cooldownTimerRef.current), []);

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
    setFaces(bufferRef.current.slice(0, page));
    setExcluded(new Set());
    armCooldown();
  }, [page, armCooldown]);

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
    await fill(page * 2);
    showWindow();
    setLoading(false);
  }, [fill, showWindow, page]);

  useEffect(() => {
    if (visible) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // The grid remeasured (device chrome) -> re-window and top up if short.
  useEffect(() => {
    if (loading) return;
    setFaces(bufferRef.current.slice(0, page));
    if (bufferRef.current.length < page * 2) fill(page * 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const toggle = useCallback((id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Optimistic: fire the PATCH and advance to the next (buffered) page
  // immediately -- don't wait for the write. A failed write surfaces a
  // dismissible banner; the already-shown faces are in `seen` so they
  // won't cycle back. Returns true once the advance has kicked off.
  const submit = useCallback(async () => {
    if (submitLockRef.current || loading || cooldown || faces.length === 0) return false;
    submitLockRef.current = true;
    try {
      const keep = faces.filter((f) => !excluded.has(f.id)).map((f) => f.id);
      const flag = faces.filter((f) => excluded.has(f.id)).map((f) => f.id);
      const consumed = faces.length;

      authedFetch(submitUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(keep, flag)),
      })
        .then((resp) => {
          if (!resp.ok) setError("Couldn't save that batch — it may need redoing.");
        })
        .catch((e) => {
          console.warn('review submit failed:', e);
          setError("Couldn't save that batch — it may need redoing.");
        });

      bufferRef.current = bufferRef.current.slice(consumed);
      if (bufferRef.current.length === 0) {
        // Nothing buffered (e.g. moved past this person) -> must fetch.
        setBusy(true);
        await fill(page);
        showWindow();
        setBusy(false);
      } else {
        showWindow(); // instant
        if (bufferRef.current.length < page * 2) fill(page * 2); // bg top-up
      }
      return true;
    } finally {
      submitLockRef.current = false;
    }
  }, [loading, cooldown, faces, excluded, buildBody, submitUrl, fill, showWindow, page]);

  return {
    faces,
    excluded,
    toggle,
    loading,
    busy,
    cooldown,
    error,
    submit,
    reload: load,
    setError,
  };
}
