import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Modal,
  Dimensions,
} from 'react-native';

import { authedFetch, API_BASE } from './auth';
import { nextIgnoreOffset } from './queueLogic';

const { width, height } = Dimensions.get('window');
const COLS = 3;
const GRID_PADDING = 12;
const GRID_GAP = 8;
const CHIP_SIZE = Math.floor((width - GRID_PADDING * 2 - GRID_GAP * (COLS - 1)) / COLS);

// Fit whole rows that clear the header/hint/footer chrome; no scroll.
const CHROME = 100 + 44 + 96;
const ROWS = Math.max(2, Math.min(8, Math.floor((height - CHROME) / (CHIP_SIZE + GRID_GAP))));
const PAGE_LIMIT = COLS * ROWS;
const MAX_FETCH = 120; // backend cap

/**
 * Review unlabeled faces whose top classifier guess is `.ignore`.
 * Non-excluded chips get confirmed as `.ignore`; excluded chips have
 * `.ignore` rejected from their guesses. The confirm PATCH runs in the
 * background while the next screenful (already prefetched) comes up.
 */
const IgnoreReviewScreen = ({ visible, onClose, pagesToCache }) => {
  const [grid, setGrid] = useState([]); // faces currently on screen
  const [excluded, setExcluded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // All candidates fetched this session (grows as the look-ahead is
  // topped up), and how far into it we've advanced.
  const chunkRef = useRef([]);
  const consumedRef = useRef(0);
  // Faces the server actually removed from the candidate list because of
  // our confirms/hides. `nextOffset = chunkRef.length - removedRef`: the
  // list shrank by `removedRef`, and our still-unconsumed look-ahead is
  // at the front, so this points just past what we already hold.
  const removedRef = useRef(0);
  const exhaustedRef = useRef(false);
  const fetchPromiseRef = useRef(null); // in-flight top-up, shared by callers
  const lastSubmitRef = useRef(Promise.resolve());

  // Keep this many faces buffered ahead of the visible screen.
  const targetLookahead = Math.max(1, Math.max(0, pagesToCache)) * PAGE_LIMIT;

  const fetchAt = useCallback(async (offset, limit) => {
    const n = Math.min(limit, MAX_FETCH);
    const resp = await authedFetch(
      `${API_BASE}/mobile/ignore_candidates/?limit=${n}&offset=${offset}`
    );
    if (resp.networkError) throw new Error('network');
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const list = Array.isArray(data.faces) ? data.faces : [];
    list.forEach((f) => Image.prefetch(f.face_img_url));
    return list;
  }, []);

  // Append the next slice of candidates to chunkRef. Returns the number
  // of genuinely new faces added (0 => server has no more right now).
  const fetchMore = useCallback(() => {
    if (exhaustedRef.current) return Promise.resolve(0);
    if (fetchPromiseRef.current) return fetchPromiseRef.current;
    fetchPromiseRef.current = (async () => {
      try {
        try {
          await lastSubmitRef.current; // so removedRef reflects the last batch
        } catch (e) {
          /* surfaced in submit() */
        }
        const offset = nextIgnoreOffset(chunkRef.current.length, removedRef.current);
        const want = targetLookahead + PAGE_LIMIT;
        const list = await fetchAt(offset, want);
        const have = new Set(chunkRef.current.map((f) => f.id));
        const fresh = list.filter((f) => !have.has(f.id));
        chunkRef.current = chunkRef.current.concat(fresh);
        if (list.length < want) exhaustedRef.current = true;
        return fresh.length;
      } catch (e) {
        console.warn('ignore_candidates fetchMore failed:', e);
        return 0;
      } finally {
        fetchPromiseRef.current = null;
      }
    })();
    return fetchPromiseRef.current;
  }, [fetchAt, targetLookahead]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setExcluded(new Set());
    chunkRef.current = [];
    consumedRef.current = 0;
    removedRef.current = 0;
    exhaustedRef.current = false;
    fetchPromiseRef.current = null;
    try {
      const want = targetLookahead + PAGE_LIMIT;
      const list = await fetchAt(0, want);
      chunkRef.current = list;
      if (list.length < want) exhaustedRef.current = true;
      consumedRef.current = Math.min(PAGE_LIMIT, list.length);
      setGrid(list.slice(0, PAGE_LIMIT));
    } catch (e) {
      console.warn('ignore_candidates load failed:', e);
      setError(
        e.message === 'network'
          ? 'No connection — check your network, then reopen this screen.'
          : 'Could not load ignore candidates. Reopen to try again.'
      );
      chunkRef.current = [];
      consumedRef.current = 0;
      setGrid([]);
    } finally {
      setLoading(false);
    }
  }, [fetchAt, targetLookahead]);

  // Move to the next screenful, blocking for one fetch only if we've
  // outrun the background top-up, then top up again for next time.
  const advanceScreen = useCallback(async () => {
    const take = () =>
      chunkRef.current.slice(consumedRef.current, consumedRef.current + PAGE_LIMIT);

    let next = take();
    if (next.length === 0 && !exhaustedRef.current) {
      setLoading(true);
      await fetchMore();
      setLoading(false);
      next = take();
    }

    if (next.length === 0) {
      setExcluded(new Set());
      setError('');
      if (exhaustedRef.current) {
        setGrid([]); // genuinely nothing left
      } else {
        await load(); // couldn't top up cleanly -> resync from the front
      }
      return;
    }

    consumedRef.current += next.length;
    setExcluded(new Set());
    setError('');
    setGrid(next);
    if (chunkRef.current.length - consumedRef.current < targetLookahead) {
      fetchMore(); // fire-and-forget top-up
    }
  }, [fetchMore, load, targetLookahead]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const toggleExclude = (id) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const confirmCount = grid.filter((f) => !excluded.has(f.id)).length;
  const hideCount = grid.length - confirmCount;

  const submit = () => {
    if (loading || grid.length === 0) return;
    const confirm_ids = grid.filter((f) => !excluded.has(f.id)).map((f) => f.id);
    const hide_ids = grid.filter((f) => excluded.has(f.id)).map((f) => f.id);

    // Fire the write in the background; track how many faces actually
    // left the server list so the next fetch's offset stays correct.
    lastSubmitRef.current = authedFetch(`${API_BASE}/mobile/bulk_confirm_ignore/`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_ids, hide_ids }),
    })
      .then(async (resp) => {
        if (!resp.ok) {
          setError("Couldn't save that batch — reopen to retry.");
          return;
        }
        const body = await resp.json().catch(() => ({}));
        removedRef.current += (body.confirmed || 0) + (body.hidden || 0);
        console.log('bulk_confirm_ignore:', body);
      })
      .catch((e) => {
        console.warn('bulk_confirm_ignore failed:', e);
        setError("Couldn't save that batch — reopen to retry.");
      });

    advanceScreen();
  };

  const buttonLabel =
    confirmCount > 0
      ? `Ignore ${confirmCount}` + (hideCount ? `  ·  hide ${hideCount}` : '')
      : `Hide ${hideCount}`;

  const renderChip = ({ item }) => {
    const isExcluded = excluded.has(item.id);
    return (
      <TouchableOpacity
        style={styles.chip}
        activeOpacity={0.8}
        onPress={() => toggleExclude(item.id)}
      >
        <Image
          source={{ uri: item.face_img_url }}
          style={[styles.chipImage, isExcluded && styles.chipImageExcluded]}
          resizeMode="cover"
        />
        {isExcluded && (
          <View style={styles.excludeBadge}>
            <Text style={styles.excludeBadgeText}>✕</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Confirm ignored faces</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.centerFill}>
            <ActivityIndicator size="large" color="#007bff" />
          </View>
        ) : grid.length === 0 ? (
          <View style={styles.centerFill}>
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptyBody}>
              {error || 'No faces are currently guessed as “ignore”.'}
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.hint}>
              Faces guessed as “ignore”. Tap any you don&apos;t want to decide
              on — it stays a proposed ignore but won&apos;t show here again.
            </Text>
            <FlatList
              data={grid}
              renderItem={renderChip}
              keyExtractor={(item) => String(item.id)}
              numColumns={COLS}
              scrollEnabled={false}
              contentContainerStyle={styles.grid}
              columnWrapperStyle={styles.gridRow}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.footer}>
              <TouchableOpacity style={styles.submitButton} onPress={submit}>
                <Text style={styles.submitButtonText}>{buttonLabel}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f0f0f0', paddingTop: 44 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  closeButton: { padding: 6 },
  closeText: { fontSize: 20, color: '#555', fontWeight: 'bold' },
  hint: {
    fontSize: 13,
    color: '#777',
    textAlign: 'center',
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  emptyTitle: { fontSize: 20, fontWeight: 'bold', color: '#333', marginBottom: 8 },
  emptyBody: { fontSize: 15, color: '#666', textAlign: 'center' },
  grid: { padding: GRID_PADDING },
  gridRow: { gap: GRID_GAP, marginBottom: GRID_GAP },
  chip: {
    width: CHIP_SIZE,
    height: CHIP_SIZE,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#ddd',
  },
  chipImage: { width: '100%', height: '100%' },
  chipImageExcluded: { opacity: 0.25 },
  excludeBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#C0392B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  excludeBadgeText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  errorText: {
    color: '#dc3545',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  footer: { padding: 16, paddingBottom: 32 },
  submitButton: {
    backgroundColor: '#C0392B',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitButtonText: { color: '#fff', fontSize: 17, fontWeight: 'bold' },
});

export default IgnoreReviewScreen;
