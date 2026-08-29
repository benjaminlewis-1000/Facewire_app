import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Image } from 'react-native';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';

/**
 * Verify faces already declared `.ignore` but not human-checked. Untapped
 * chips are confirmed as `.ignore`; tapped chips (a real person the
 * classifier wrongly ignored) go back to the unassigned pool for
 * reprocessing. Committed on button press. Backend returns a fresh random
 * sample each load, so `seen` keeps the same face from cycling back.
 */
const VerifyIgnoreScreen = ({ visible, onClose }) => {
  const [faces, setFaces] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const seenRef = useRef(new Set());
  const emptyStreakRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setExcluded(new Set());
    try {
      // Over-fetch so we can drop already-seen faces and still fill a page.
      const resp = await authedFetch(
        `${API_BASE}/mobile/verify_ignore_candidates/?limit=${PAGE_LIMIT * 3}`
      );
      if (resp.networkError) throw new Error('network');
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      const all = Array.isArray(data.faces) ? data.faces : [];
      let fresh = all.filter((f) => !seenRef.current.has(f.id));
      // Everything came back seen but the pool clearly isn't empty -> we've
      // reviewed the reachable sample; start over rather than dead-end.
      if (fresh.length === 0 && all.length > 0) {
        emptyStreakRef.current += 1;
        if (emptyStreakRef.current < 2) {
          seenRef.current = new Set();
          fresh = all;
        }
      } else {
        emptyStreakRef.current = 0;
      }
      const page = fresh.slice(0, PAGE_LIMIT);
      page.forEach((f) => {
        seenRef.current.add(f.id);
        Image.prefetch(f.face_img_url);
      });
      setFaces(page);
    } catch (e) {
      console.warn('verify_ignore_candidates load failed:', e);
      setError(
        e.message === 'network'
          ? 'No connection — check your network, then reopen this screen.'
          : 'Could not load ignored faces. Reopen to try again.'
      );
      setFaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) {
      seenRef.current = new Set();
      emptyStreakRef.current = 0;
      load();
    }
  }, [visible, load]);

  const toggle = (id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (loading || faces.length === 0) return;
    const verify_ids = faces.filter((f) => !excluded.has(f.id)).map((f) => f.id);
    const reset_ids = faces.filter((f) => excluded.has(f.id)).map((f) => f.id);

    authedFetch(`${API_BASE}/mobile/bulk_verify/`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verify_ids, reset_ids }),
    })
      .then((resp) => {
        if (!resp.ok) setError("Couldn't save that batch — reopen to retry.");
      })
      .catch((e) => {
        console.warn('bulk_verify failed:', e);
        setError("Couldn't save that batch — reopen to retry.");
      });

    load();
  };

  const verifyCount = faces.filter((f) => !excluded.has(f.id)).length;
  const resetCount = faces.length - verifyCount;
  const submitLabel =
    verifyCount > 0
      ? `Keep ignored ${verifyCount}` + (resetCount ? `  ·  reset ${resetCount}` : '')
      : `Reset ${resetCount}`;

  return (
    <ReviewGrid
      visible={visible}
      onClose={onClose}
      title="Verify ignored"
      hint="Tap any face that's actually a real person — it goes back to the unassigned pool. The rest stay ignored."
      faces={faces}
      excluded={excluded}
      onToggle={toggle}
      loading={loading}
      error={error}
      emptyBody={error || 'No unverified ignored faces left.'}
      submitLabel={submitLabel}
      onSubmit={submit}
      accent="#00695C"
    />
  );
};

export default VerifyIgnoreScreen;
