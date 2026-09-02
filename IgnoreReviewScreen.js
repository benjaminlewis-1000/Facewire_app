import React, { useState, useCallback } from 'react';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT, UndoButton, CancelUndoLink } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';

/**
 * Review unlabeled faces whose top classifier guess is `.ignore`.
 * Untapped chips are confirmed as `.ignore`; tapped chips are hidden from
 * this grid (mobile_review_hidden) without otherwise touching the face.
 * useReviewQueue buffers the batch so the next screenful is instant.
 */
const IgnoreReviewScreen = ({ visible, onClose }) => {
  const [pageSize, setPageSize] = useState(PAGE_LIMIT);

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
    pageSize,
    submitUrl: `${API_BASE}/mobile/bulk_confirm_ignore/`,
    buildBody: (confirm_ids, hide_ids) => ({ confirm_ids, hide_ids }),
    // bulk_confirm_ignore has no reset path -- route "undo" through
    // bulk_verify, whose reset_ids loop sends any face back to the pool.
    undoUrl: `${API_BASE}/mobile/bulk_verify/`,
    buildUndoBody: (reset_ids) => ({ verify_ids: [], reset_ids }),
  });

  const backCount = q.faces.filter((f) => q.excluded.has(f.id)).length;
  const hideCount = q.undoing ? 0 : backCount;
  const confirmCount = q.faces.length - hideCount;
  const submitLabel = q.undoing
    ? backCount
      ? `Reprocess ${backCount}`
      : 'Done'
    : confirmCount > 0
    ? `Ignore ${confirmCount}` + (hideCount ? `  ·  hide ${hideCount}` : '')
    : `Hide ${hideCount}`;

  return (
    <ReviewGrid
      visible={visible}
      onClose={onClose}
      title={q.undoing ? 'Fix last screen' : 'Confirm ignored faces'}
      headerAction={q.canUndo ? <UndoButton onPress={q.beginUndo} /> : null}
      meta={q.undoing ? <CancelUndoLink onPress={q.cancelUndo} /> : null}
      hint={
        q.undoing
          ? 'Tap the faces that should be reprocessed instead of ignored.'
          : "Tap any you don't want to decide on — it won't show here again."
      }
      faces={q.faces}
      excluded={q.excluded}
      onToggle={q.toggle}
      onCapacity={setPageSize}
      loading={q.loading}
      busy={q.busy}
      cooldown={q.cooldown}
      error={q.error}
      emptyBody={q.error || 'No faces are currently guessed as “ignore”.'}
      submitLabel={submitLabel}
      onSubmit={q.undoing ? q.submitUndo : q.submit}
      accent={q.undoing ? '#8E44AD' : '#C0392B'}
    />
  );
};

export default IgnoreReviewScreen;
