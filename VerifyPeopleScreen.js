import React, { useState, useCallback, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';
import ScreenToast from './ScreenToast';

// Ask for several screenfuls at once; useReviewQueue buffers them so the
// next page is instant.
const FETCH_LIMIT = Math.min(120, PAGE_LIMIT * 4);

/**
 * Verify unconfirmed assignments for one *named* person at a time, biggest
 * unverified pile first. Untapped chips get confirmed; tapped chips are
 * sent back to the unassigned pool for reprocessing. Both happen when the
 * button is pressed. "Skip person" parks the current person for the
 * session and jumps to the next-biggest pile.
 */
const VerifyPeopleScreen = ({ visible, onClose }) => {
  const [person, setPerson] = useState(null); // { id, name }
  const [remaining, setRemaining] = useState(null); // locally-tracked count
  const [pageSize, setPageSize] = useState(PAGE_LIMIT);

  const excludeIdsRef = useRef(new Set()); // person ids skipped this session
  const pinnedPersonIdRef = useRef(null); // stay on this person until exhausted
  const currentPersonIdRef = useRef(null); // whose count `remaining` reflects

  const fetchPage = useCallback(async (seen) => {
    const exclude = [...excludeIdsRef.current].join(',');
    const pin = pinnedPersonIdRef.current ? `&person_id=${pinnedPersonIdRef.current}` : '';
    const resp = await authedFetch(
      `${API_BASE}/mobile/verify_candidates/?limit=${FETCH_LIMIT}&exclude=${exclude}${pin}`
    );
    if (resp.networkError) throw new Error('network');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const all = Array.isArray(data.faces) ? data.faces : [];
    // Drop faces already shown this session -- the optimistic submit
    // advances before the PATCH lands, so a just-verified face could
    // otherwise come back in the next random sample.
    const fresh = all.filter((f) => !seen.has(f.id));
    // No person, or this person's reachable pool is used up -> meta:null
    // so the pin clears and we move on to the next pile.
    if (!data.person_id || fresh.length === 0) return { faces: [], meta: null };
    return {
      faces: fresh,
      meta: { id: data.person_id, name: data.person_name, count: data.unverified_count },
    };
  }, []);

  const handlePage = useCallback((meta) => {
    if (!meta) {
      // Pinned person exhausted (or queue empty). Drop the pin so the next
      // fetch re-picks; leave `person` alone so the banner doesn't flicker.
      pinnedPersonIdRef.current = null;
      return;
    }
    setPerson(meta);
    pinnedPersonIdRef.current = meta.id; // stay on them until exhausted
    if (meta.id !== currentPersonIdRef.current) {
      // Landed on a new person: latch their count (only sent on the first,
      // unpinned load); from here we track it locally -- see onSubmit.
      currentPersonIdRef.current = meta.id;
      setRemaining(typeof meta.count === 'number' ? meta.count : null);
    }
  }, []);

  const q = useReviewQueue({
    visible,
    fetchPage,
    onPage: handlePage,
    pageSize,
    submitUrl: `${API_BASE}/mobile/bulk_verify/`,
    buildBody: (verify_ids, reset_ids) => ({ verify_ids, reset_ids }),
  });

  const skipPerson = () => {
    if (person) excludeIdsRef.current.add(person.id);
    pinnedPersonIdRef.current = null; // let the server pick the next pile
    currentPersonIdRef.current = null; // re-latch the count for the next person
    q.reload();
  };

  // Every face on the grid leaves this person's unverified pile on submit
  // (verified -> validated, reset -> off the person), so drop the local
  // count by the screenful -- but only once the write has actually landed.
  const onSubmit = async () => {
    const leaving = q.faces.length;
    const ok = await q.submit();
    if (ok) {
      setRemaining((r) => (typeof r === 'number' ? Math.max(0, r - leaving) : r));
    }
  };

  const resetCount = q.faces.filter((f) => q.excluded.has(f.id)).length;
  const verifyCount = q.faces.length - resetCount;
  const submitLabel =
    verifyCount > 0
      ? `Verify ${verifyCount}` + (resetCount ? `  ·  reset ${resetCount}` : '')
      : `Reset ${resetCount}`;

  const active = person && q.faces.length;

  const meta = active ? (
    <>
      <Text style={styles.metaCount}>
        {typeof remaining === 'number' ? `~${remaining} left` : ' '}
      </Text>
      <TouchableOpacity onPress={skipPerson} hitSlop={10} style={styles.skipBtn}>
        <Text style={styles.skipText}>Skip person ▸</Text>
      </TouchableOpacity>
    </>
  ) : null;

  return (
    <>
      <ReviewGrid
        visible={visible}
        onClose={onClose}
        title={active ? `Verify people · ${person.name}` : 'Verify people'}
        hint="Tap the wrong ones to send them back for reprocessing."
        meta={meta}
        faces={q.faces}
        excluded={q.excluded}
        onToggle={q.toggle}
        onCapacity={setPageSize}
        loading={q.loading}
        busy={q.busy}
        error={q.error}
        emptyBody={q.error || 'No unverified faces for any named person.'}
        submitLabel={submitLabel}
        onSubmit={onSubmit}
        accent="#2E7D32"
      />
      {/* Per-person cue (fires on each person, including the first). */}
      <ScreenToast
        trigger={person?.id}
        title={person ? `Verifying faces for ${person.name}` : ''}
      />
    </>
  );
};

const styles = StyleSheet.create({
  metaCount: { flex: 1, fontSize: 13, color: '#4a6b4c' },
  skipBtn: { paddingVertical: 6, paddingLeft: 10 },
  skipText: { fontSize: 13, color: '#2E7D32', fontWeight: '600' },
});

export default VerifyPeopleScreen;
