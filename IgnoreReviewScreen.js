import React, { useCallback } from 'react';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';

/**
 * Review unlabeled faces whose top classifier guess is `.ignore`.
 * Untapped chips are confirmed as `.ignore`; tapped chips are hidden from
 * this grid (mobile_review_hidden) without otherwise touching the face.
 * useReviewQueue buffers the batch so the next screenful is instant.
 */
const IgnoreReviewScreen = ({ visible, onClose }) => {
  const fetchPage = useCallback(async (seen) => {
    const resp = await authedFetch(
      `${API_BASE}/mobile/ignore_candidates/?limit=${PAGE_LIMIT * 4}`
    );
    if (resp.networkError) throw new Error('network');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const all = Array.isArray(data.faces) ? data.faces : [];
    return { faces: all.filter((f) => !seen.has(f.id)) };
  }, []);

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
      title="Confirm ignored faces"
      hint="Tap any you don't want to decide on — it won't show here again."
      faces={q.faces}
      excluded={q.excluded}
      onToggle={q.toggle}
      loading={q.loading}
      busy={q.busy}
      error={q.error}
      emptyBody={q.error || 'No faces are currently guessed as “ignore”.'}
      submitLabel={submitLabel}
      onSubmit={q.submit}
      accent="#C0392B"
    />
  );
};

export default IgnoreReviewScreen;
