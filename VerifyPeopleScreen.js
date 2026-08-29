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
  const [person, setPerson] = useState(null); // { id, name, count }
  const [popupName, setPopupName] = useState('');

  const excludeIdsRef = useRef(new Set()); // person ids skipped this session
  const pinnedPersonIdRef = useRef(null); // stay on this person until exhausted
  const lastPersonIdRef = useRef(null);
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
      if (meta && meta.id !== lastPersonIdRef.current) {
        lastPersonIdRef.current = meta.id;
        showPopup(meta.name);
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

  useEffect(() => {
    if (visible) {
      excludeIdsRef.current = new Set();
      pinnedPersonIdRef.current = null;
      lastPersonIdRef.current = null;
    }
    return () => {
      if (popupTimer.current) clearTimeout(popupTimer.current);
    };
  }, [visible]);

  const skipPerson = () => {
    if (person) excludeIdsRef.current.add(person.id);
    pinnedPersonIdRef.current = null; // let the server pick the next pile
    q.reload();
  };

  const resetCount = q.faces.filter((f) => q.excluded.has(f.id)).length;
  const verifyCount = q.faces.length - resetCount;
  const submitLabel =
    verifyCount > 0
      ? `Verify ${verifyCount}` + (resetCount ? `  ·  reset ${resetCount}` : '')
      : `Reset ${resetCount}`;

  const subHeader = person ? (
    <View style={styles.personBar}>
      <View style={{ flex: 1 }}>
        <Text style={styles.personName} numberOfLines={1}>
          {person.name}
        </Text>
        <Text style={styles.personCount}>
          {typeof person.count === 'number' ? `${person.count} unverified` : 'unverified'}
        </Text>
      </View>
      <TouchableOpacity onPress={skipPerson} hitSlop={10} style={styles.skipBtn}>
        <Text style={styles.skipText}>Skip person ▸</Text>
      </TouchableOpacity>
    </View>
  ) : null;

  return (
    <>
      <ReviewGrid
        visible={visible}
        onClose={onClose}
        title="Verify people"
        hint="Tap any face that's the wrong person — it goes back to the unassigned pool. The rest are confirmed."
        subHeader={subHeader}
        faces={q.faces}
        excluded={q.excluded}
        onToggle={q.toggle}
        loading={q.loading}
        error={q.error}
        emptyBody={q.error || 'No unverified faces for any named person.'}
        submitLabel={submitLabel}
        onSubmit={q.submit}
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
  personBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 8,
    marginHorizontal: 12,
    marginBottom: 2,
    backgroundColor: '#e8f0e9',
    borderRadius: 10,
  },
  personName: { fontSize: 17, fontWeight: 'bold', color: '#1b3a1d' },
  personCount: { fontSize: 12, color: '#4a6b4c' },
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
