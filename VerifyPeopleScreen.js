import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Modal } from 'react-native';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';
import useReviewQueue from './useReviewQueue';

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
  const [popupName, setPopupName] = useState('');

  const excludeIdsRef = useRef(new Set()); // person ids skipped this session
  const pinnedPersonIdRef = useRef(null); // stay on this person until exhausted
  const currentPersonIdRef = useRef(null); // whose count `remaining` reflects
  const popupTimer = useRef(null);

  const showPopup = useCallback((name) => {
    setPopupName(name);
    if (popupTimer.current) clearTimeout(popupTimer.current);
    popupTimer.current = setTimeout(() => setPopupName(''), 2000);
  }, []);

  const fetchPage = useCallback(async () => {
    const exclude = [...excludeIdsRef.current].join(',');
    const pin = pinnedPersonIdRef.current ? `&person_id=${pinnedPersonIdRef.current}` : '';
    const resp = await authedFetch(
      `${API_BASE}/mobile/verify_candidates/?limit=${PAGE_LIMIT}&exclude=${exclude}${pin}`
    );
    if (resp.networkError) throw new Error('network');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const faces = Array.isArray(data.faces) ? data.faces : [];
    if (!data.person_id || faces.length === 0) return { faces: [], meta: null };
    return {
      faces,
      meta: { id: data.person_id, name: data.person_name, count: data.unverified_count },
    };
  }, []);

  const handlePage = useCallback(
    (meta) => {
      setPerson(meta);
      // Pin the server to this person for subsequent loads; null => the
      // queue is exhausted.
      pinnedPersonIdRef.current = meta ? meta.id : null;
      if (meta && meta.id !== currentPersonIdRef.current) {
        // Landed on a new person: latch their count from the server (only
        // sent on this first, unpinned load). From here we track it
        // locally -- see onSubmit -- so there's no COUNT query per screen.
        const isTransition = currentPersonIdRef.current !== null;
        currentPersonIdRef.current = meta.id;
        setRemaining(typeof meta.count === 'number' ? meta.count : null);
        // Only pop the "Now verifying" cue when moving *between* people --
        // not on the first load (the banner already says who) or a
        // Fast-Refresh remount.
        if (isTransition) showPopup(meta.name);
      }
    },
    [showPopup]
  );

  const q = useReviewQueue({
    visible,
    fetchPage,
    onPage: handlePage,
    submitUrl: `${API_BASE}/mobile/bulk_verify/`,
    buildBody: (verify_ids, reset_ids) => ({ verify_ids, reset_ids }),
  });

  // The screen mounts fresh each time it's opened, so refs start clean --
  // no reset needed here (an earlier version reset them in this effect and
  // clobbered the just-latched count).
  useEffect(
    () => () => {
      if (popupTimer.current) clearTimeout(popupTimer.current);
    },
    []
  );

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

  const meta = person ? (
    <>
      <Text style={styles.metaCount}>
        {typeof remaining === 'number' ? `~${remaining} unverified` : 'unverified'}
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
        title={person ? `Verifying ${person.name}` : 'Verify people'}
        hint="Tap any face that's the wrong person — it goes back to the unassigned pool. The rest are confirmed."
        meta={meta}
        faces={q.faces}
        excluded={q.excluded}
        onToggle={q.toggle}
        loading={q.loading}
        error={q.error}
        emptyBody={q.error || 'No unverified faces for any named person.'}
        submitLabel={submitLabel}
        onSubmit={onSubmit}
        accent="#2E7D32"
      />
      <Modal visible={!!popupName} transparent animationType="fade">
        <View style={styles.popupWrap}>
          <View style={styles.popupCard}>
            <Text style={styles.popupLabel}>Now verifying</Text>
            <Text style={styles.popupName}>{popupName}</Text>
            <TouchableOpacity onPress={() => setPopupName('')}>
              <Text style={styles.popupDismiss}>tap to dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  metaCount: { flex: 1, fontSize: 13, color: '#4a6b4c' },
  skipBtn: { paddingVertical: 6, paddingLeft: 10 },
  skipText: { fontSize: 13, color: '#2E7D32', fontWeight: '600' },
  popupWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0006' },
  popupCard: {
    backgroundColor: '#fff',
    paddingVertical: 24,
    paddingHorizontal: 40,
    borderRadius: 16,
    alignItems: 'center',
  },
  popupLabel: { fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 1 },
  popupName: { fontSize: 24, fontWeight: 'bold', color: '#222', marginVertical: 6 },
  popupDismiss: { fontSize: 12, color: '#aaa', marginTop: 4 },
});

export default VerifyPeopleScreen;
