import { useState, useEffect, useCallback, useRef } from 'react';
import { Image } from 'react-native';

import { authedFetch } from './auth';

/**
 * Shared state machine for the tap-to-flag review grids (confirm ignored,
 * verify people, verify ignored). The screen supplies:
 *
 *   fetchPage(seen)  async -> { faces: [{id, face_img_url}], meta? }
 *                    `seen` is the Set of ids already shown this session;
 *                    the screen decides how (or whether) to use it.
 *                    Throw `new Error('network')` for a connectivity failure.
 *   buildBody(keepIds, flagIds) -> object  PATCH body for submitUrl
 *   submitUrl        the bulk-action endpoint
 *
 * Returns { faces, excluded, toggle, loading, error, submit, reload, setError }.
 * `submit` awaits the PATCH, then reloads -- so the next page (and any
 * server-computed counts on it) reflect the write. `reload()` resolves to
 * the page's `meta`.
 *
 * `onPage(meta)` (optional) runs after every successful load, so screens
 * with per-page context (e.g. "verify people" shows one person at a time)
 * can react without threading the return value through every call site.
 */
export default function useReviewQueue({ visible, fetchPage, buildBody, submitUrl, onPage }) {
  const [faces, setFaces] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const seen = useRef(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setExcluded(new Set());
    try {
      const { faces: page = [], meta = null } = await fetchPage(seen.current);
      page.forEach((f) => {
        seen.current.add(f.id);
        Image.prefetch(f.face_img_url);
      });
      setFaces(page);
      if (onPage) onPage(meta);
      return meta;
    } catch (e) {
      console.warn('useReviewQueue load failed:', e);
      setError(
        e.message === 'network'
          ? 'No connection — check your network, then reopen this screen.'
          : 'Could not load. Reopen to try again.'
      );
      setFaces([]);
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetchPage, onPage]);

  useEffect(() => {
    if (visible) {
      seen.current = new Set();
      load();
    }
  }, [visible, load]);

  const toggle = useCallback((id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (loading || faces.length === 0) return;
    const keep = faces.filter((f) => !excluded.has(f.id)).map((f) => f.id);
    const flag = faces.filter((f) => excluded.has(f.id)).map((f) => f.id);

    setLoading(true);
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
      setLoading(false);
      return;
    }
    // Write landed -> the reload's page + counts now reflect it.
    load();
  }, [faces, excluded, loading, buildBody, submitUrl, load]);

  return { faces, excluded, toggle, loading, error, submit, reload: load, setError };
}
