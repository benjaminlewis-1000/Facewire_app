import React, { useCallback } from 'react';
import { Image } from 'react-native';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';

const MAX_FETCH = 120; // backend cap

/**
 * Review unlabeled faces whose top classifier guess is `.ignore`.
 * Untapped chips are confirmed as `.ignore`; tapped chips are hidden from
 * this grid (mobile_review_hidden) without otherwise touching the face.
 * The PATCH runs in the background while the next screenful comes up.
 *
 * The backend returns a fresh random sample each call and ignores offset,
 * so paging is just: fetch a batch, drop faces already seen this session,
 * show a screenful, warm the images for the rest. `pagesToCache` controls
 * how many extra screenfuls of images to prefetch ahead.
 */
const IgnoreReviewScreen = ({ visible, onClose, pagesToCache = 1 }) => {
  const fetchPage = useCallback(
    async (seen) => {
      const want = Math.min(MAX_FETCH, PAGE_LIMIT * (2 + Math.max(0, pagesToCache)));
      const resp = await authedFetch(
        `${API_BASE}/mobile/ignore_candidates/?limit=${want}`
      );
      if (resp.networkError) throw new Error('network');
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      const all = Array.isArray(data.faces) ? data.faces : [];
      const fresh = all.filter((f) => !seen.has(f.id));
      // All already seen but the pool clearly isn't empty -> we've worked
      // through the reachable sample; start fresh rather than dead-end.
      const pool = fresh.length > 0 || all.length === 0 ? fresh : all;
      // Warm images for the lookahead beyond this screenful.
      pool.slice(PAGE_LIMIT).forEach((f) => Image.prefetch(f.face_img_url));
      return { faces: pool.slice(0, PAGE_LIMIT) };
    },
    [pagesToCache]
  );

  const q = useReviewQueue({
    visible,
    fetchPage,
    submitUrl: `${API_BASE}/mobile/bulk_confirm_ignore/`,
    buildBody: (confirm_ids, hide_ids) => ({ confirm_ids, hide_ids }),
  });

  const hideCount = q.faces.filter((f) => q.excluded.has(f.id)).length;
  const confirmCount = q.faces.length - hideCount;
  const submitLabel =
    confirmCount > 0
      ? `Ignore ${confirmCount}` + (hideCount ? `  ·  hide ${hideCount}` : '')
      : `Hide ${hideCount}`;

  return (
    <ReviewGrid
      visible={visible}
      onClose={onClose}
      title="Confirming ignored faces"
      hint="Faces guessed as “ignore”. Tap any you don't want to decide on — it stays a proposed ignore but won't show here again."
      faces={q.faces}
      excluded={q.excluded}
      onToggle={q.toggle}
      loading={q.loading}
      error={q.error}
      emptyBody={q.error || 'No faces are currently guessed as “ignore”.'}
      submitLabel={submitLabel}
      onSubmit={q.submit}
      accent="#C0392B"
    />
  );
};

export default IgnoreReviewScreen;
