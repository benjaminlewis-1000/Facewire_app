import React, { useState, useCallback } from 'react';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT, UndoButton, CancelUndoLink } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';

/**
 * Verify faces already declared `.ignore` but not human-checked. Untapped
 * chips are confirmed as `.ignore`; tapped chips (a real person the
 * classifier wrongly ignored) go back to the unassigned pool for
 * reprocessing. Committed on button press. The backend returns a fresh
 * random sample each load, so `seen` keeps faces from cycling back.
 */
const VerifyIgnoreScreen = ({ visible, onClose }) => {
  const [pageSize, setPageSize] = useState(PAGE_LIMIT);

  const fetchPage = useCallback(async (seen) => {
    const resp = await authedFetch(
      `${API_BASE}/mobile/verify_ignore_candidates/?limit=${PAGE_LIMIT * 4}`
    );
    if (resp.networkError) throw new Error('network');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const all = Array.isArray(data.faces) ? data.faces : [];
    // The hook dedupes against the buffer; we just drop faces already
    // shown earlier this session.
    return { faces: all.filter((f) => !seen.has(f.id)) };
  }, []);

  const q = useReviewQueue({
    visible,
    fetchPage,
    pageSize,
    submitUrl: `${API_BASE}/mobile/bulk_verify/`,
    buildBody: (verify_ids, reset_ids) => ({ verify_ids, reset_ids }),
  });

  const resetCount = q.faces.filter((f) => q.excluded.has(f.id)).length;
  const keepCount = q.faces.length - resetCount;
  const submitLabel = q.undoing
    ? resetCount
      ? `Reprocess ${resetCount}`
      : 'Done'
    : keepCount > 0
    ? `Keep ignored ${keepCount}` + (resetCount ? `  ·  reset ${resetCount}` : '')
    : `Reset ${resetCount}`;

  return (
    <ReviewGrid
      visible={visible}
      onClose={onClose}
      title={q.undoing ? 'Fix last screen' : 'Verify ignored faces'}
      headerAction={q.canUndo ? <UndoButton onPress={q.beginUndo} /> : null}
      meta={q.undoing ? <CancelUndoLink onPress={q.cancelUndo} /> : null}
      hint={
        q.undoing
          ? 'Tap the faces that should be reprocessed instead of kept as ignored.'
          : 'Tap real people to send them back for reprocessing.'
      }
      faces={q.faces}
      excluded={q.excluded}
      onToggle={q.toggle}
      onCapacity={setPageSize}
      loading={q.loading}
      busy={q.busy}
      cooldown={q.cooldown}
      error={q.error}
      emptyBody={q.error || 'No unverified ignored faces left.'}
      submitLabel={submitLabel}
      onSubmit={q.undoing ? q.submitUndo : q.submit}
      accent={q.undoing ? '#8E44AD' : '#00695C'}
    />
  );
};

export default VerifyIgnoreScreen;
