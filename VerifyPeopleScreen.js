import React, { useState, useEffect, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Image, Modal } from 'react-native';

import { authedFetch, API_BASE } from './auth';
import ReviewGrid, { PAGE_LIMIT } from './ReviewGrid';

/**
 * Verify unconfirmed assignments for one *named* person at a time, biggest
 * unverified pile first. Untapped chips get confirmed; tapped chips are
 * sent back to the unassigned pool for reprocessing. Both happen when the
 * button is pressed. "Skip person" parks the current person for the
 * session and jumps to the next-biggest pile.
 */
const VerifyPeopleScreen = ({ visible, onClose }) => {
  const [person, setPerson] = useState(null); // { id, name, count }
  const [faces, setFaces] = useState([]);
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [popupName, setPopupName] = useState('');

  const excludeIdsRef = useRef(new Set()); // person ids skipped this session
  const lastPersonIdRef = useRef(null);
  const popupTimer = useRef(null);

  const showPopup = useCallback((name) => {
    setPopupName(name);
    if (popupTimer.current) clearTimeout(popupTimer.current);
    popupTimer.current = setTimeout(() => setPopupName(''), 2000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setExcluded(new Set());
    try {
      const exclude = [...excludeIdsRef.current].join(',');
      const resp = await authedFetch(
        `${API_BASE}/mobile/verify_candidates/?limit=${PAGE_LIMIT}&exclude=${exclude}`
      );
      if (resp.networkError) throw new Error('network');
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      const list = Array.isArray(data.faces) ? data.faces : [];
      list.forEach((f) => Image.prefetch(f.face_img_url));
      if (!data.person_id || list.length === 0) {
        setPerson(null);
        setFaces([]);
        return;
      }
      setPerson({
        id: data.person_id,
        name: data.person_name,
        count: data.unverified_count,
      });
      setFaces(list);
      if (data.person_id !== lastPersonIdRef.current) {
        lastPersonIdRef.current = data.person_id;
        showPopup(data.person_name);
      }
    } catch (e) {
      console.warn('verify_candidates load failed:', e);
      setError(
        e.message === 'network'
          ? 'No connection — check your network, then reopen this screen.'
          : 'Could not load faces to verify. Reopen to try again.'
      );
      setFaces([]);
    } finally {
      setLoading(false);
    }
  }, [showPopup]);

  useEffect(() => {
    if (visible) {
      excludeIdsRef.current = new Set();
      lastPersonIdRef.current = null;
      load();
    }
    return () => {
      if (popupTimer.current) clearTimeout(popupTimer.current);
    };
  }, [visible, load]);

  const toggle = (id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const skipPerson = () => {
    if (person) excludeIdsRef.current.add(person.id);
    load();
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
      ? `Verify ${verifyCount}` + (resetCount ? `  ·  reset ${resetCount}` : '')
      : `Reset ${resetCount}`;

  const subHeader = person ? (
    <View style={styles.personBar}>
      <View style={{ flex: 1 }}>
        <Text style={styles.personName} numberOfLines={1}>
          {person.name}
        </Text>
        <Text style={styles.personCount}>{person.count} unverified</Text>
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
        faces={faces}
        excluded={excluded}
        onToggle={toggle}
        loading={loading}
        error={error}
        emptyBody={error || 'No unverified faces for any named person.'}
        submitLabel={submitLabel}
        onSubmit={submit}
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
