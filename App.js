import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Image, Text, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, Modal, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage'; // Import AsyncStorage
import { ImageZoom } from '@likashefqet/react-native-image-zoom';
import LoginScreen from './LoginScreen'; // Import the new LoginScreen component
import IgnoreReviewScreen from './IgnoreReviewScreen';
import SettingsScreen from './SettingsScreen';
import { authedFetch, signOut, lockSession, getValidIdToken, API_BASE } from './auth';
import { firstCheckIndex, pruneAndLocate, frontierAfterRemoval } from './queueLogic';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Get screen dimensions for responsive styling
const { width, height } = Dimensions.get('window');

// Array of placeholder image URLs (used as fallbacks or initial state if API fails)
const placeholderImages = [
  'https://picsum.photos/id/238/600/600', // Landscape
];

// Main App component
export default function App() {
  // Authentication states
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);

  // UI states
  const [isMenuVisible, setIsMenuVisible] = useState(false);
  const [isLoadingContent, setIsLoadingContent] = useState(true);
  const [currentImage, setCurrentImage] = useState(placeholderImages[0]);
  const [buttonNames, setButtonNames] = useState([]); // Real candidate names from the API (no synthetic entries)

  // API data states.
  // The main queue is segmented by "most likely person" (poss_ident1).
  // `groups` order + membership is frozen for the session; each group
  // carries its own cursor so switching people resumes where you left off.
  //   group: { personId, personName, count, faceIds: number[],
  //            viewIndex, frontierIndex }
  const [groups, setGroups] = useState([]);
  const [groupIndex, setGroupIndex] = useState(0);
  const [currentUnlabeledInstanceData, setCurrentUnlabeledInstanceData] = useState(null);
  const [queueExhausted, setQueueExhausted] = useState(false); // Every group reviewed
  const [actionError, setActionError] = useState(''); // Banner for a failed background write
  const [personPopup, setPersonPopup] = useState(null); // { name } -- "now labeling" cue

  // Modal states
  const [showIdsModal, setShowIdsModal] = useState(false);
  const [showInstanceDataModal, setShowInstanceDataModal] = useState(false);
  const [showSourceImageModal, setShowSourceImageModal] = useState(false); // New state for source image modal
  const [currentSourceImage, setCurrentSourceImage] = useState(null); // New state for source image URL
  const [showUndoModal, setShowUndoModal] = useState(false); // State for "Undo assignment" confirmation modal
  const [showIgnoreReview, setShowIgnoreReview] = useState(false); // "Review ignored faces" screen
  const [showSettings, setShowSettings] = useState(false); // Settings screen

  // How many upcoming faces to prefetch (instance data + image) in the
  // background. Persisted in AsyncStorage; adjustable from Settings.
  const PREFETCH_DEFAULT = 10;
  const [prefetchCount, setPrefetchCount] = useState(PREFETCH_DEFAULT);

  // How many extra screenfuls the "Confirm ignored faces" grid prefetches
  // ahead. Persisted; adjustable from Settings.
  const IGNORE_PAGES_DEFAULT = 1;
  const [ignorePages, setIgnorePages] = useState(IGNORE_PAGES_DEFAULT);

  // Prefetch caches (refs -- never trigger a render on their own):
  const instanceCache = useRef(new Map()); // faceId -> instance data
  const resolvedIds = useRef(new Set()); // faceIds known to be is_unassigned:false
  const pendingFetches = useRef(new Map()); // faceId -> in-flight fetch Promise

  const clearPrefetchCaches = () => {
    instanceCache.current.clear();
    resolvedIds.current.clear();
    pendingFetches.current.clear();
  };

  // Serializes user actions so a fast double-tap during an optimistic
  // (spinner-less) advance can't fire two writes / double-advance.
  const actionLock = useRef(false);

  /**
   * Sends an HTTP PATCH request to the specified URL with the given payload.
   * Auth (bearer token + refresh-and-retry on 401/403) is handled by
   * authedFetch; a persistent 401/403 forces a logout.
   * @param {string} url - The URL to send the PATCH request to.
   * @param {object|null} payload - The data to send in the request body.
   * @returns {boolean} True if the request was successful, false otherwise.
   */
  const sendPatchRequest = async (url, payload = null) => {
    try {
      const response = await authedFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
      });

      if (response.authError) {
        console.error('Auth failed on PATCH. Logging out user.');
        handleLogout();
        return false;
      }
      if (response.networkError) {
        setActionError('No connection — that change was not saved. Reconnect and try again.');
        return false;
      }
      if (response.ok) {
        console.log(`PATCH request to ${url} successful.`);
        return true;
      }
      const errorData = await response.json().catch(() => ({}));
      console.error(`PATCH request to ${url} failed (Status: ${response.status}):`, errorData);
      setActionError(`The server rejected that (${response.status}).`);
      return false;
    } catch (error) {
      console.error(`Network error during PATCH request to ${url}:`, error);
      return false;
    }
  };


  // Push an instance-data dict onto the on-screen state.
  const applyInstanceToUi = (data) => {
    setCurrentUnlabeledInstanceData(data);
    setCurrentImage(data.face_img_url || placeholderImages[0]);
    setButtonNames(Array.isArray(data.names) ? data.names.map((i) => i.name) : []);
    setCurrentSourceImage(data.source_img_url || null);
  };

  /**
   * Fetches detailed data for one unlabeled instance ID.
   * @param {number} id
   * @param {object} [opts]
   * @param {boolean} [opts.display=true] - push the result onto the UI.
   * @param {boolean} [opts.allowCache=true] - serve from the prefetch
   *   cache if present (skips the network round trip).
   * @returns {object|null} instance data, or null on failure.
   */
  const fetchUnlabeledInstanceData = async (
    id,
    { display = true, allowCache = true } = {}
  ) => {
    if (!id) {
      console.warn('fetchUnlabeledInstanceData: null/undefined ID.');
      return null;
    }

    if (allowCache && instanceCache.current.has(id)) {
      const cached = instanceCache.current.get(id);
      if (display) applyInstanceToUi(cached);
      return cached;
    }

    // Dedupe concurrent requests for the same id (a prefetch already in
    // flight + the user advancing onto it): share one network round trip.
    let fetchPromise = pendingFetches.current.get(id);
    if (!fetchPromise) {
      fetchPromise = (async () => {
        try {
          const response = await authedFetch(
            `${API_BASE}/mobile/unlabeled_instance/${id}/`
          );
          if (response.authError) {
            console.error('Auth failed fetching instance data. Logging out user.');
            handleLogout();
            return null;
          }
          if (response.networkError) {
            if (display) {
              setActionError('No connection — could not load this face. Reconnect and tap › to retry.');
            }
            return null;
          }
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error(`Failed to fetch instance ${id}:`, errorData);
            if (display) setActionError(`Could not load this face (${response.status}).`);
            return null;
          }
          const data = await response.json();
          if (Array.isArray(data.names)) {
            data.names = data.names.filter(
              (item) => item && item.name && !/^[._]/.test(item.name)
            );
          }
          instanceCache.current.set(id, data);
          if (data.is_unassigned === false) resolvedIds.current.add(id);
          if (instanceCache.current.size > 250) {
            instanceCache.current.delete(instanceCache.current.keys().next().value);
          }
          console.log(
            `Fetched instance ${id} (is_unassigned=${data.is_unassigned})`
          );
          return data;
        } catch (error) {
          console.error(`Network error fetching instance ${id}:`, error);
          return null;
        } finally {
          pendingFetches.current.delete(id);
        }
      })();
      pendingFetches.current.set(id, fetchPromise);
    }

    const data = await fetchPromise;
    if (data && display) applyInstanceToUi(data);
    return data;
  };

  /**
   * Background-fetch instance data (and warm the image cache) for the
   * next `prefetchCount` faces after `fromIndex`, in parallel, skipping
   * any already cached, in flight, or known to be resolved elsewhere.
   */
  const warmPrefetchCache = (ids, fromIndex) => {
    let queued = 0;
    for (let i = fromIndex + 1; i < ids.length && queued < prefetchCount; i++) {
      const id = ids[i];
      if (resolvedIds.current.has(id)) continue; // don't cache already-verified
      queued += 1;
      if (instanceCache.current.has(id)) continue;
      // fetchUnlabeledInstanceData dedupes in-flight requests internally.
      fetchUnlabeledInstanceData(id, { display: false, allowCache: false })
        .then((data) => {
          if (data && data.face_img_url) Image.prefetch(data.face_img_url);
        })
        .catch(() => {});
    }
  };

  // LoginScreen owns startup auth (biometric gate + silent token
  // refresh from the stored OIDC refresh token), so App just renders it
  // until it reports success.
  useEffect(() => {
    setIsLoadingAuth(false);
    AsyncStorage.getItem('pv_prefetch_count').then((v) => {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) setPrefetchCount(n);
    });
    AsyncStorage.getItem('pv_ignore_pages').then((v) => {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) setIgnorePages(n);
    });
  }, []);

  const updatePrefetchCount = (n) => {
    const clamped = Math.max(0, Math.min(60, Math.round(n)));
    setPrefetchCount(clamped);
    AsyncStorage.setItem('pv_prefetch_count', String(clamped)).catch(() => {});
  };

  const updateIgnorePages = (n) => {
    const clamped = Math.max(0, Math.min(8, Math.round(n)));
    setIgnorePages(clamped);
    AsyncStorage.setItem('pv_ignore_pages', String(clamped)).catch(() => {});
  };

  // Auto-lock: drop the session (fingerprint required to return) when the
  // app has been backgrounded for more than a brief grace period, or when
  // it's been sitting in the foreground untouched past the idle timeout.
  const LOCK_ON_BACKGROUND_GRACE_MS = 2000; // filters transient inactive states
  const IDLE_LOCK_MS = 3 * 60 * 1000; // 3 minutes of no touches
  const backgroundedAt = useRef(null);
  const lastActivityAt = useRef(Date.now());

  const registerActivity = () => {
    lastActivityAt.current = Date.now();
  };

  useEffect(() => {
    if (!isLoggedIn) return;

    const lock = (reason) => {
      console.log('Auto-locking:', reason);
      clearPrefetchCaches();
      lockSession().finally(() => setIsLoggedIn(false));
    };

    // Keep the bearer token fresh even while the app sits idle in the
    // foreground: refresh proactively if it's within 5 min of expiry, so
    // the next action never eats a refresh round-trip. (authedFetch also
    // refreshes on-demand with a 60s skew, and reactively on 401.)
    const keepTokenFresh = () => {
      getValidIdToken(300).catch((e) => console.warn('token keepalive failed:', e?.message));
    };

    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        if (backgroundedAt.current == null) backgroundedAt.current = Date.now();
      } else if (next === 'active') {
        const bgSince = backgroundedAt.current;
        backgroundedAt.current = null;
        lastActivityAt.current = Date.now(); // returning counts as activity
        if (bgSince != null && Date.now() - bgSince > LOCK_ON_BACKGROUND_GRACE_MS) {
          lock('returned after background');
        } else {
          keepTokenFresh();
        }
      }
    });

    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return; // timers pause in bg anyway
      if (Date.now() - lastActivityAt.current > IDLE_LOCK_MS) {
        lock('idle timeout');
      } else {
        keepTokenFresh();
      }
    }, 30000);

    keepTokenFresh(); // and once right now

    return () => {
      appStateSub.remove();
      clearInterval(timer);
    };
  }, [isLoggedIn]);

  // ==== Group-based main queue ==========================================

  const MAX_AUTOSKIP = 40;

  const buildGroups = (raw) =>
    (raw || [])
      .filter((grp) => Array.isArray(grp.face_ids) && grp.face_ids.length > 0)
      .map((grp) => {
        const n = grp.face_ids.length;
        const frontier = Math.min(Math.max(0, grp.frontier_index || 0), n);
        return {
          personId: grp.person_id,
          personName: grp.person_name,
          count: grp.count,
          faceIds: grp.face_ids.slice(),
          // Restore per-person progress across app restarts.
          frontierIndex: frontier,
          viewIndex: Math.min(Math.max(0, grp.view_index ?? frontier), Math.max(0, n - 1)),
        };
      });

  const persistGroups = (gs) => {
    AsyncStorage.setItem(
      'pv_groups',
      JSON.stringify(
        gs.map((g) => ({
          person_id: g.personId,
          person_name: g.personName,
          count: g.count,
          face_ids: g.faceIds,
          frontier_index: g.frontierIndex,
          view_index: g.viewIndex,
        }))
      )
    ).catch(() => {});
  };

  // Debounced persist whenever the groups structure changes.
  const persistTimer = useRef(null);
  useEffect(() => {
    if (!groups.length) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => persistGroups(groups), 1200);
    return () => persistTimer.current && clearTimeout(persistTimer.current);
  }, [groups]);

  // "Now labeling <name>" cue -- auto-dismisses after 2s (tap also closes).
  useEffect(() => {
    if (!personPopup) return;
    const t = setTimeout(() => setPersonPopup(null), 2000);
    return () => clearTimeout(t);
  }, [personPopup]);

  const showEmptyQueue = () => {
    setQueueExhausted(false);
    setCurrentUnlabeledInstanceData(null);
    setButtonNames([]);
    setCurrentImage(placeholderImages[0]);
  };

  const showAllDone = () => {
    setQueueExhausted(true);
    setCurrentUnlabeledInstanceData(null);
    setButtonNames([]);
  };

  const patchGroup = (gi, patch) =>
    setGroups((prev) => prev.map((x, i) => (i === gi ? { ...x, ...patch } : x)));

  /**
   * Within group `gi` of `gs`, walk `faceIds` forward from `startWithin`
   * to the first still-open face (pruning ones resolved elsewhere), then
   * display it and set the group's cursor. Returns {done:true} if the
   * group has nothing left to work.
   */
  const settleGroup = async (gs, gi, startWithin, inclusive) => {
    const grp = gs[gi];
    if (!grp) return { done: true };

    const faceIds = grp.faceIds;
    const resolvedIdx = new Set(); // indices into faceIds resolved elsewhere
    let idx = firstCheckIndex(startWithin, inclusive) - 1;
    let targetIdx = -1;
    let skipped = 0;

    while (skipped < MAX_AUTOSKIP) {
      idx += 1;
      if (idx >= faceIds.length) break;
      const fid = faceIds[idx];
      if (resolvedIds.current.has(fid)) {
        resolvedIdx.add(idx);
        skipped += 1;
        continue;
      }
      const data = await fetchUnlabeledInstanceData(fid, { display: false });
      if (data && data.is_unassigned === false) {
        resolvedIdx.add(idx);
        skipped += 1;
        continue;
      }
      targetIdx = idx;
      break;
    }

    const { pruned, finalIndex: finalIdx, done } = pruneAndLocate(
      faceIds,
      resolvedIdx,
      targetIdx
    );

    if (done) {
      // Mark the group complete: frontier past the end.
      patchGroup(gi, { faceIds: pruned, frontierIndex: pruned.length });
      return { done: true };
    }

    patchGroup(gi, { faceIds: pruned, viewIndex: finalIdx, frontierIndex: finalIdx });
    setGroupIndex(gi);
    setQueueExhausted(false);
    await fetchUnlabeledInstanceData(pruned[finalIdx], { display: true });
    warmPrefetchCache(pruned, finalIdx);
    return { done: false };
  };

  /**
   * Move toward group `startGi` in direction `dir` (+1 / -1) until a
   * group with faces still to work is found; settle on it. `popup` shows
   * the "now labeling" cue for the group we land on.
   */
  const goToGroup = async (gs, startGi, dir, { popup = false } = {}) => {
    for (let gi = startGi; gi >= 0 && gi < gs.length; gi += dir) {
      const res = await settleGroup(gs, gi, gs[gi].frontierIndex, true);
      if (!res.done) {
        if (popup) setPersonPopup({ name: gs[gi].personName });
        return true;
      }
    }
    if (dir > 0) showAllDone();
    return false;
  };

  const groupsAfterCurrentPatch = (gi, patch) =>
    groups.map((x, i) => (i === gi ? { ...x, ...patch } : x));

  // Advance the frontier within the current group after an action; roll
  // over to the next person (with popup) when the person is finished.
  const advanceAfterAction = async () => {
    const grp = groups[groupIndex];
    if (!grp) return;
    // settleGroup with inclusive:false starts at frontierIndex + 1.
    const res = await settleGroup(groups, groupIndex, grp.frontierIndex, false);
    if (res.done) {
      await goToGroup(groups, groupIndex + 1, 1, { popup: true });
    }
  };

  // Remove the face at `removeIdx` from the current group (skip / reset /
  // none-of-the-above) without advancing the frontier.
  const removeCurrentFace = async (removeIdx) => {
    const grp = groups[groupIndex];
    if (!grp) return;
    const newFaceIds = grp.faceIds.filter((_, i) => i !== removeIdx);
    const newFrontier = frontierAfterRemoval(grp.frontierIndex, removeIdx, newFaceIds.length);
    const gsNow = groupsAfterCurrentPatch(groupIndex, {
      faceIds: newFaceIds,
      frontierIndex: newFrontier,
    });
    setGroups(gsNow);

    if (newFrontier >= newFaceIds.length) {
      await goToGroup(gsNow, groupIndex + 1, 1, { popup: true });
    } else {
      await settleGroup(gsNow, groupIndex, newFrontier, true);
    }
  };

  /**
   * Optimistic single-tap choice: advance immediately while the write
   * (`doPatch`, truthy on success) runs in the background.
   */
  const commitChoice = (doPatch) => {
    if (isLoadingContent || actionLock.current) return;
    actionLock.current = true;
    setActionError('');
    const grp = groups[groupIndex];
    const nextFid = grp ? grp.faceIds[grp.frontierIndex + 1] : null;
    const nextWarm = nextFid != null && instanceCache.current.has(nextFid);
    if (!nextWarm) setIsLoadingContent(true);

    Promise.resolve()
      .then(doPatch)
      .then((ok) => {
        if (!ok) setActionError("Couldn't save that — tap ‹ to retry.");
      })
      .catch((e) => {
        console.error('Choice PATCH error:', e);
        setActionError("Couldn't save that — tap ‹ to retry.");
      });

    advanceAfterAction().finally(() => {
      setIsLoadingContent(false);
      actionLock.current = false;
    });
  };

  // Tap a candidate name -> confirm that person for this face.
  const chooseName = (index) => {
    const name = buttonNames[index];
    const item = (currentUnlabeledInstanceData?.names || []).find((n) => n.name === name);
    if (!item || !item.confirm_patch_url) {
      console.warn('No confirm_patch_url for name:', name);
      return;
    }
    commitChoice(() => sendPatchRequest(item.confirm_patch_url, item.confirm_patch_data));
  };

  // Tap "Not a real person" -> ignore this face.
  const chooseIgnore = () => {
    const d = currentUnlabeledInstanceData;
    if (!d || !d.ignore_url) {
      console.warn('No ignore_url in instance data.');
      return;
    }
    commitChoice(() => sendPatchRequest(d.ignore_url, d.ignore_payload));
  };

  const chooseNoneOfTheAbove = () => {
    const grp = groups[groupIndex];
    if (grp) resetFaceAndDrop(grp.viewIndex);
  };

  // Skip: no PATCH -- drop the face from this person's list and move on.
  const skipFace = async () => {
    if (isLoadingContent || actionLock.current) return;
    const grp = groups[groupIndex];
    if (!grp || grp.faceIds[grp.viewIndex] == null) return;
    actionLock.current = true;
    setActionError('');
    setIsLoadingContent(true);
    try {
      await removeCurrentFace(grp.viewIndex);
    } catch (e) {
      console.error('Error skipping face:', e);
    } finally {
      setIsLoadingContent(false);
      actionLock.current = false;
    }
  };

  // Reset the face at `removeIdx` (clears name + guesses, re-pools it)
  // then drop it from the current person's list.
  const resetFaceAndDrop = async (removeIdx) => {
    if (isLoadingContent || actionLock.current) return;
    const grp = groups[groupIndex];
    const faceId = grp ? grp.faceIds[removeIdx] : null;
    if (faceId == null) return;
    actionLock.current = true;
    setActionError('');
    setIsLoadingContent(true);
    try {
      const ok = await sendPatchRequest(`${API_BASE}/mobile/reset/${faceId}/`, null);
      if (!ok) {
        setActionError("Couldn't reset that face.");
        return;
      }
      await removeCurrentFace(removeIdx);
    } catch (e) {
      console.error('Error resetting face:', e);
    } finally {
      setIsLoadingContent(false);
      actionLock.current = false;
    }
  };

  // Face nav (‹ / ›) -- moves within the CURRENT person's list only.
  const navFace = async (delta) => {
    const grp = groups[groupIndex];
    if (isLoadingContent || actionLock.current || !grp) return;
    const newView = grp.viewIndex + delta;
    if (newView < 0 || newView > grp.frontierIndex) return;
    setActionError('');
    setQueueExhausted(false);
    setIsLoadingContent(true);
    patchGroup(groupIndex, { viewIndex: newView });
    await fetchUnlabeledInstanceData(grp.faceIds[newView], { display: true });
    setIsLoadingContent(false);
  };
  const handleNavigateBackward = () => navFace(-1);
  const handleNavigateForward = () => navFace(1);

  // Re-fetch the face currently on screen (banner "Retry" after a
  // connectivity failure).
  const retryCurrentFace = async () => {
    const grp = groups[groupIndex];
    if (isLoadingContent || !grp) return;
    const fid = grp.faceIds[grp.viewIndex];
    if (fid == null) return;
    setActionError('');
    setIsLoadingContent(true);
    try {
      const data = await fetchUnlabeledInstanceData(fid, { display: true, allowCache: false });
      if (data) warmPrefetchCache(grp.faceIds, grp.viewIndex);
    } finally {
      setIsLoadingContent(false);
    }
  };

  // Person nav (◀ / ▶) -- switch to the prev / next person's list.
  const changePerson = (dir) => {
    if (isLoadingContent || actionLock.current) return;
    actionLock.current = true;
    setActionError('');
    setIsLoadingContent(true);
    goToGroup(groups, groupIndex + dir, dir, { popup: true }).finally(() => {
      setIsLoadingContent(false);
      actionLock.current = false;
    });
  };
  const nextPerson = () => changePerson(1);
  const prevPerson = () => changePerson(-1);

  const handleResetFaceClick = () => setShowUndoModal(true);
  const confirmUndoAssignment = () => {
    setShowUndoModal(false);
    const grp = groups[groupIndex];
    if (grp) resetFaceAndDrop(grp.viewIndex);
  };

  // Load the group structure from storage on login.
  useEffect(() => {
    if (!isLoggedIn) return;
    (async () => {
      setIsLoadingContent(true);
      try {
        const stored = await AsyncStorage.getItem('pv_groups');
        const gs = stored ? buildGroups(JSON.parse(stored)) : [];
        console.log(`Loaded ${gs.length} labeling groups from storage.`);
        setGroups(gs);
        setGroupIndex(0);
        if (gs.length === 0) {
          showEmptyQueue();
          return;
        }
        await goToGroup(gs, 0, 1, { popup: true });
      } catch (e) {
        console.error('Initial group load failed:', e);
        showEmptyQueue();
      } finally {
        setIsLoadingContent(false);
      }
    })();
  }, [isLoggedIn]);

  /**
   * Re-fetch the grouped queue from the API, replacing the session's
   * groups and jumping to the first person.
   */
  const refreshQueueFromApi = async () => {
    setIsMenuVisible(false);
    setIsLoadingContent(true);
    clearPrefetchCaches();
    try {
      const resp = await authedFetch(`${API_BASE}/mobile/labeling_groups/`);
      if (resp.authError) {
        handleLogout();
        return;
      }
      if (resp.networkError) {
        setActionError('No connection — could not refresh. Your current list is unchanged.');
        return;
      }
      if (!resp.ok) {
        setActionError(`Refresh failed (${resp.status}).`);
        return;
      }
      const data = await resp.json();
      const gs = buildGroups(data.groups);
      persistGroups(gs);
      setGroups(gs);
      setGroupIndex(0);
      console.log(
        `Refreshed: ${gs.length} people, ${gs.reduce((n, g) => n + g.faceIds.length, 0)} faces.`
      );
      if (gs.length === 0) {
        showEmptyQueue();
        return;
      }
      await goToGroup(gs, 0, 1, { popup: true });

      try {
        const nr = await authedFetch(`${API_BASE}/mobile/name_list/`);
        if (nr.ok) {
          const nd = await nr.json();
          if (Array.isArray(nd.name_list)) {
            await AsyncStorage.setItem('nameList', JSON.stringify(nd.name_list));
          }
        }
      } catch (e) {
        /* best effort */
      }
    } catch (e) {
      console.error('Error refreshing queue:', e);
    } finally {
      setIsLoadingContent(false);
    }
  };


  /**
   * Lock: drop the active session but keep the refresh token, so the
   * login screen immediately offers a biometric sign-in.
   */
  const handleLock = async () => {
    clearPrefetchCaches();
    try {
      await lockSession();
    } catch (error) {
      console.error('Error locking:', error);
    } finally {
      setIsLoggedIn(false);
      setIsMenuVisible(false);
    }
  };

  /**
   * Full sign-out: wipe every stored token. Coming back needs the browser
   * OIDC flow. Also used on unrecoverable auth failures.
   */
  const handleLogout = async () => {
    clearPrefetchCaches();
    try {
      await signOut();
      await AsyncStorage.multiRemove(['pv_groups', 'nameList']);
      console.log('User signed out.');
    } catch (error) {
      console.error('Error signing out:', error);
    } finally {
      setIsLoggedIn(false);
      setIsMenuVisible(false);
    }
  };

  // Show a loading indicator while checking auth status
  if (isLoadingAuth) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#0000ff" />
        <Text>Loading app...</Text>
      </View>
    );
  }

  // Conditionally render LoginScreen or the main app UI
  if (!isLoggedIn) {
    return <LoginScreen onLoginSuccess={() => setIsLoggedIn(true)} />;
  }

  // Current group + derived view state.
  const g = groups[groupIndex] || null;
  const currentFaceId = g ? g.faceIds[g.viewIndex] : null;
  const isViewingCurrentItem = !g || g.viewIndex === g.frontierIndex;
  const facesLeft = g ? Math.max(0, g.faceIds.length - g.frontierIndex) : 0;
  const canNavFaceBack = g && !isLoadingContent && g.viewIndex > 0;
  const canNavFaceFwd = g && !isLoadingContent && g.viewIndex < g.frontierIndex;
  const hasPrevPerson =
    !isLoadingContent &&
    groups.slice(0, groupIndex).some((x) => x.frontierIndex < x.faceIds.length);
  const hasNextPerson =
    !isLoadingContent &&
    groups.slice(groupIndex + 1).some((x) => x.frontierIndex < x.faceIds.length);

  return (
    <GestureHandlerRootView>
    <View
      style={styles.container}
      onStartShouldSetResponderCapture={() => {
        registerActivity();
        return false; // passive: let children handle the touch
      }}
    >
      {/* Hamburger Menu Icon */}
      <TouchableOpacity
        style={styles.hamburgerIcon}
        onPress={() => setIsMenuVisible(true)}
      >
        <Text style={styles.hamburgerText}>☰</Text>
      </TouchableOpacity>

      {/* Face nav (within the current person's list) */}
      <View style={styles.navigationButtonsContainer}>
        <TouchableOpacity
          style={[styles.navButton, !canNavFaceBack && styles.navButtonDisabled]}
          onPress={handleNavigateBackward}
          disabled={!canNavFaceBack}
        >
          <Text style={styles.navButtonText}>{'‹'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.navButton, !canNavFaceFwd && styles.navButtonDisabled]}
          onPress={handleNavigateForward}
          disabled={!canNavFaceFwd}
        >
          <Text style={styles.navButtonText}>{'›'}</Text>
        </TouchableOpacity>
      </View>

      {/* Person header + person nav */}
      {g && !queueExhausted && (
        <View style={styles.personBar}>
          <TouchableOpacity
            style={[styles.personNavButton, !hasPrevPerson && styles.personNavDisabled]}
            onPress={prevPerson}
            disabled={!hasPrevPerson}
          >
            <Text style={styles.personNavText}>◀</Text>
          </TouchableOpacity>
          <View style={styles.personLabel}>
            <Text style={styles.personName} numberOfLines={1}>{g.personName}</Text>
            <Text style={styles.personCount}>{facesLeft} left</Text>
          </View>
          <TouchableOpacity
            style={[styles.personNavButton, !hasNextPerson && styles.personNavDisabled]}
            onPress={nextPerson}
            disabled={!hasNextPerson}
          >
            <Text style={styles.personNavText}>▶</Text>
          </TouchableOpacity>
        </View>
      )}


      {/* Image Section: Displays loading or image */}
      <View style={styles.imageContainer}>
        {isLoadingContent ? (
          <ActivityIndicator size="large" color="#0000ff" />
        ) : (
          <TouchableOpacity
            onPress={() => {
              console.log('Tapped image. currentSourceImage:', currentSourceImage); // Debugging log
              if (currentSourceImage) {
                setShowSourceImageModal(true);
              } else {
                console.log("No source image URL available to display.");
              }
            }}
            style={styles.imageTouchable} // Ensure touchable area covers image
          >
            <Image
              source={{ uri: currentImage }} // Set the image source from state
              style={styles.image}
              resizeMode="contain" // Ensures the entire image is visible within its container
              // Optional: Add an onError handler for debugging image loading issues
              onError={(e) => console.log('Image loading error:', e.nativeEvent.error)}
            />
          </TouchableOpacity>
        )}
      </View>

      {actionError ? (
        <View style={styles.actionErrorBanner}>
          <Text style={styles.actionErrorText}>{actionError}</Text>
          <View style={styles.actionErrorButtons}>
            {currentFaceId != null && (
              <TouchableOpacity onPress={retryCurrentFace} disabled={isLoadingContent}>
                <Text style={styles.actionErrorAction}>Retry</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={() => setActionError('')}>
              <Text style={styles.actionErrorAction}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Choices Section */}
      {queueExhausted || !g ? (
        <View style={styles.caughtUpPanel}>
          <Text style={styles.caughtUpTitle}>
            {g ? 'All caught up' : 'Nothing to label'}
          </Text>
          <Text style={styles.caughtUpBody}>
            {g
              ? "You've reviewed everyone in this batch. Pull a fresh queue, or use the arrows to look back."
              : 'Pull a fresh queue to start.'}
          </Text>
          <TouchableOpacity
            style={[styles.skipButtonFull, isLoadingContent && styles.choiceDisabled]}
            onPress={refreshQueueFromApi}
            disabled={isLoadingContent}
          >
            <Text style={styles.skipButtonText}>Refresh queue</Text>
          </TouchableOpacity>
        </View>
      ) : isViewingCurrentItem ? ( // Working the current (frontier) item
        <>
          <Text style={styles.choiceHint}>Tap who this is — one tap confirms</Text>
          <ScrollView
            style={styles.choicesScrollView}
            contentContainerStyle={styles.choicesContainer}
          >
            {buttonNames.map((name, index) => (
              <TouchableOpacity
                key={`name-${index}`}
                style={[
                  styles.choiceButton,
                  styles.nameChoice,
                  isLoadingContent && styles.choiceDisabled,
                ]}
                onPress={() => chooseName(index)}
                disabled={isLoadingContent}
              >
                <Text style={styles.choiceButtonText}>{name}</Text>
              </TouchableOpacity>
            ))}

            {buttonNames.length === 0 && (
              <Text style={styles.noButtonsText}>No name suggestions for this face.</Text>
            )}

            <View style={styles.choiceDivider} />

            <TouchableOpacity
              style={[styles.choiceButton, styles.noneChoice, isLoadingContent && styles.choiceDisabled]}
              onPress={chooseNoneOfTheAbove}
              disabled={isLoadingContent}
            >
              <Text style={styles.choiceButtonText}>None of the above</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.choiceButton, styles.ignoreChoice, isLoadingContent && styles.choiceDisabled]}
              onPress={chooseIgnore}
              disabled={isLoadingContent}
            >
              <Text style={styles.choiceButtonText}>Not a real person / ignore</Text>
            </TouchableOpacity>
          </ScrollView>

          {/* Skip bar */}
          <View style={styles.skipBar}>
            <TouchableOpacity
              style={[styles.skipButtonFull, isLoadingContent && styles.choiceDisabled]}
              onPress={skipFace}
              disabled={isLoadingContent}
            >
              <Text style={styles.skipButtonText}>Skip for now</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : (
        // Viewing a past item -> only offer "Reset Face"
        <View style={styles.skipBar}>
          <TouchableOpacity
            style={[styles.resetFaceButton, isLoadingContent && styles.choiceDisabled]}
            onPress={handleResetFaceClick}
            disabled={isLoadingContent}
          >
            <Text style={styles.skipButtonText}>Reset this face</Text>
          </TouchableOpacity>
        </View>
      )}


      {/* Hamburger Menu Modal */}
      <Modal
        animationType="slide" // Slide from bottom, or 'fade', 'none'
        transparent={true}
        visible={isMenuVisible}
        onRequestClose={() => setIsMenuVisible(false)} // Android back button support
      >
        <TouchableOpacity // Overlay to close menu when tapping outside
          style={styles.menuOverlay}
          activeOpacity={1}
          onPress={() => setIsMenuVisible(false)}
        >
          <View style={styles.menuContainer}>
            {/* Close Button for the menu */}
            <TouchableOpacity
              style={styles.menuCloseButton}
              onPress={() => setIsMenuVisible(false)}
            >
              <Text style={styles.menuCloseText}>X</Text>
            </TouchableOpacity>

            {/* Menu Options */}
            <TouchableOpacity style={styles.menuOption} onPress={refreshQueueFromApi}>
              <Text style={styles.menuOptionText}>Refresh queue</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                setIsMenuVisible(false);
                setShowIgnoreReview(true);
              }}
            >
              <Text style={styles.menuOptionText}>Review ignored faces</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                setIsMenuVisible(false);
                setShowSettings(true);
              }}
            >
              <Text style={styles.menuOptionText}>Settings</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuOption} onPress={handleLock}>
              <Text style={styles.menuOptionText}>Lock (fingerprint to return)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.menuOption} onPress={handleLogout}>
              <Text style={styles.menuOptionText}>Sign out completely</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                setIsMenuVisible(false); // Close menu
                setShowIdsModal(true); // Open IDs modal
              }}
            >
              <Text style={styles.menuOptionText}>View Confident Unlabeled IDs</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.menuOption}
              onPress={() => {
                setIsMenuVisible(false); // Close menu
                setShowInstanceDataModal(true); // Open instance data modal
              }}
              disabled={!currentUnlabeledInstanceData} // Disable if no data
            >
              <Text style={styles.menuOptionText}>View Current Instance Data</Text>
            </TouchableOpacity>

            {/* Add more menu options here if needed */}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Modal for displaying Confident Unlabeled IDs */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={showIdsModal}
        onRequestClose={() => setShowIdsModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowIdsModal(false)}
            >
              <Text style={styles.modalCloseText}>X</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Labeling groups</Text>
            <ScrollView style={styles.modalScrollView}>
              {groups.length > 0 ? (
                groups.map((grp, index) => (
                  <Text key={index} style={styles.modalItemText}>
                    {index === groupIndex ? '▶ ' : '  '}
                    {grp.personName}: {grp.frontierIndex}/{grp.faceIds.length}
                  </Text>
                ))
              ) : (
                <Text style={styles.modalItemText}>No groups loaded.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Modal for displaying Current Unlabeled Instance Data */}
      <Modal
        animationType="slide"
        transparent={true}
        visible={showInstanceDataModal}
        onRequestClose={() => setShowInstanceDataModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setShowInstanceDataModal(false)}
            >
              <Text style={styles.modalCloseText}>X</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Current Instance Data</Text>
            <ScrollView style={styles.modalScrollView}>
              {currentUnlabeledInstanceData ? (
                <Text style={styles.modalItemText}>
                  {JSON.stringify(currentUnlabeledInstanceData, null, 2)}
                </Text>
              ) : (
                <Text style={styles.modalItemText}>No instance data loaded.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Modal for displaying the Source Image (full screen) */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showSourceImageModal}
        onRequestClose={() => setShowSourceImageModal(false)}
      >
        <GestureHandlerRootView>
{/*         
      <View style={styles.imageContainer}>
        {isLoadingContent ? (
          <ActivityIndicator size="large" color="#0000ff" />
        ) : (
          <TouchableOpacity
            onPress={() => {
              console.log('Tapped image. currentSourceImage:', currentSourceImage); // Debugging log
              if (currentSourceImage) {
                setShowSourceImageModal(true);
              } else {
                console.log("No source image URL available to display.");
              }
            }}
            style={styles.imageTouchable} // Ensure touchable area covers image
          >
            <ImageZoom
              url={ currentImage } // Set the image source from state
              style={styles.image}
              resizeMode="contain" // Ensures the entire image is visible within its container
              // Optional: Add an onError handler for debugging image loading issues
              onError={(e) => console.log('Image loading error:', e.nativeEvent.error)}
            />
          </TouchableOpacity>
        )}
      </View> */}
      
        <View style={styles.fullScreenImageOverlay}>
          
          {currentSourceImage ? (
            <>
            <View style={styles.imageTouchable}>
             <ImageZoom
                uri={ currentSourceImage }
                style={styles.fullScreenImage}
                // resizeMode="contain" // Ensures the whole image is visible
                onError={(e) => console.log('Source image loading error:', e.nativeEvent.error)}
                isDoubleTapEnabled={true}
                maxScale={20}
                /></View>
                
              {/* Dedicated close button for the full-screen image modal */}
              <TouchableOpacity
                style={styles.fullScreenImageCloseButton}
                onPress={() => setShowSourceImageModal(false)}
              >
                <Text style={styles.fullScreenImageCloseText}>X</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={styles.noSourceImageText}>No source image available.</Text>
          )}
        </View>
        </GestureHandlerRootView>
      </Modal>

      {/* Undo Assignment Confirmation Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={showUndoModal}
        onRequestClose={() => setShowUndoModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Reset this face?</Text>
            <Text style={styles.modalItemText}>
              Clears its name and all suggestions, sends it back for
              re-classification, and removes it from this session's queue.
            </Text>
            <View style={styles.modalButtonContainer}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonConfirm]}
                onPress={() => confirmUndoAssignment()}
              >
                <Text style={styles.modalButtonText}>Yes</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => setShowUndoModal(false)}
              >
                <Text style={styles.modalButtonText}>No</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* "Now labeling <person>" cue */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={!!personPopup}
        onRequestClose={() => setPersonPopup(null)}
      >
        <TouchableOpacity
          style={styles.popupOverlay}
          activeOpacity={1}
          onPress={() => setPersonPopup(null)}
        >
          <View style={styles.popupCard}>
            <Text style={styles.popupLabel}>Now labeling</Text>
            <Text style={styles.popupName}>{personPopup?.name}</Text>
          </View>
        </TouchableOpacity>
      </Modal>

      <IgnoreReviewScreen
        visible={showIgnoreReview}
        onClose={() => setShowIgnoreReview(false)}
        pagesToCache={ignorePages}
      />

      <SettingsScreen
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        prefetchCount={prefetchCount}
        onChangePrefetchCount={updatePrefetchCount}
        ignorePages={ignorePages}
        onChangeIgnorePages={updateIgnorePages}
      />
    </View>
    </GestureHandlerRootView>
  );
}

// StyleSheet for the components
const styles = StyleSheet.create({
  container: {
    flex: 1, // Takes up the entire screen
    backgroundColor: '#f0f0f0', // Light grey background
    alignItems: 'center', // Center content horizontally
    justifyContent: 'flex-start', // Align content to the top
    paddingTop: 80, // Increased padding from the top to make space for hamburger menu
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f0f0f0',
  },
  hamburgerIcon: {
    position: 'absolute',
    top: 40, // Adjusted top position to be within the new padding
    left: 20,
    zIndex: 1, // Ensure it's above other elements
    padding: 10,
  },
  hamburgerText: {
    fontSize: 30,
    color: '#333',
  },
  navigationButtonsContainer: {
    position: 'absolute',
    top: 40,
    right: 20,
    flexDirection: 'row',
    zIndex: 1,
  },
  navButton: {
    backgroundColor: '#6A5ACD', // Slate Blue
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: 8,
    marginHorizontal: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 3,
  },
  navButtonText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
  },
  navButtonDisabled: {
    backgroundColor: '#A9A9A9', // Grey for disabled
    opacity: 0.6,
  },
  personBar: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '92%',
    marginTop: 8,
    marginBottom: 4,
  },
  personNavButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#6A5ACD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  personNavDisabled: { backgroundColor: '#c9c9c9' },
  personNavText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
  personLabel: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  personName: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  personCount: { fontSize: 12, color: '#888', marginTop: 2 },
  popupOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  popupCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 40,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 12,
  },
  popupLabel: {
    fontSize: 13,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  popupName: { fontSize: 26, fontWeight: 'bold', color: '#333' },
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)', // Semi-transparent black background
    justifyContent: 'flex-end', // Align menu to the bottom/right depending on flex direction
    alignItems: 'flex-start', // Align menu to the left
  },
  menuContainer: {
    width: '70%', // Menu takes up 70% of the screen width
    height: '100%', // Menu takes full height
    backgroundColor: '#FFFFFF',
    paddingTop: 60, // Space for status bar and close button
    paddingHorizontal: 20,
    borderTopRightRadius: 10,
    borderBottomRightRadius: 10,
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  menuCloseButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    padding: 10,
  },
  menuCloseText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
  },
  menuOption: {
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  menuOptionText: {
    fontSize: 18,
    color: '#333',
  },
  imageTouchable: {
    width: '100%', // Ensure touchable area covers the container
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: '90%', // Image takes 90% width of its container
    height: '90%', // Image takes 90% height of its container
    borderRadius: 8, // Slightly rounded corners for the image itself
  },
  // --- Single-tap choice UI ---
  actionErrorBanner: {
    backgroundColor: '#f8d7da',
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 8,
  },
  actionErrorText: {
    color: '#842029',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  actionErrorButtons: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 6,
  },
  actionErrorAction: {
    color: '#842029',
    fontSize: 13,
    fontWeight: 'bold',
    textDecorationLine: 'underline',
  },
  choiceHint: {
    fontSize: 13,
    color: '#777',
    textAlign: 'center',
    marginBottom: 6,
  },
  choicesScrollView: {
    width: '100%',
    flex: 1,
  },
  choicesContainer: {
    alignItems: 'center',
    paddingBottom: 12,
  },
  choiceButton: {
    width: width * 0.86,
    paddingVertical: 16,
    borderRadius: 12,
    marginVertical: 5,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 3,
    elevation: 2,
  },
  choiceButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  nameChoice: { backgroundColor: '#3B7DD8' }, // blue = a real person
  noneChoice: { backgroundColor: '#E69A0E' }, // orange = none of these
  ignoreChoice: { backgroundColor: '#C0392B' }, // red = not a real person
  choiceDisabled: { opacity: 0.5 },
  choiceDivider: {
    height: 1,
    width: width * 0.86,
    backgroundColor: '#d5d5d5',
    marginTop: 12,
    marginBottom: 6,
  },
  skipBar: {
    width: '100%',
    paddingHorizontal: '5%',
    paddingTop: 8,
    paddingBottom: 40,
  },
  skipButtonFull: {
    width: '100%',
    backgroundColor: '#8A8A8A',
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  resetFaceButton: {
    width: '100%',
    backgroundColor: '#E69A0E',
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  skipButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  caughtUpPanel: {
    flex: 1,
    width: '100%',
    paddingHorizontal: '8%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caughtUpTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  caughtUpBody: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 28,
    lineHeight: 21,
  },
  buttonsScrollView: {
    width: '100%', // Full width for the scroll view
    flex: 1, // Allows the scroll view to take up remaining vertical space
  },
  buttonsContainer: {
    alignItems: 'center', // Center buttons horizontally within the scroll view
    paddingBottom: 10, // Reduced padding at the bottom of the scrollable area
  },
  button: {
    width: width * 0.8, // Buttons are 80% of screen width
    backgroundColor: '#ADD8E6', // Light blue default background
    paddingVertical: 15, // Vertical padding inside button
    borderRadius: 10, // Rounded corners for buttons
    marginVertical: 8, // Vertical margin between buttons
    alignItems: 'center', // Center text horizontally
    justifyContent: 'center', // Center text vertically
    // Shadow for a subtle depth effect
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2, // Android shadow
  },
  buttonSelected: {
    backgroundColor: '#4682B4', // Steel blue when selected
    borderWidth: 2, // Add a border when selected
    borderColor: '#1E90FF', // Dodger blue border color
  },
  buttonText: {
    color: '#FFFFFF', // White text color
    fontSize: 18,
    fontWeight: 'bold',
  },
  buttonDisabledOverlay: {
    opacity: 0.6, // Faded look for disabled buttons
  },
  noneOfTheAboveButtonInList: { // New style for "None of the above" when in the list
    backgroundColor: '#e69a0e', // Orange color
  },
  noButtonsText: {
    fontSize: 16,
    color: '#666',
    marginTop: 20,
    textAlign: 'center',
  },
  // New styles for action buttons container and individual buttons
  actionButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around', // Distribute buttons evenly
    width: '90%', // Adjust width as needed
    marginTop: 10, // Add some top margin
    marginBottom: 50, // Changed to fixed value
  },
  actionButton: {
    paddingVertical: 15,
    paddingHorizontal: 10, // Reduced horizontal padding for smaller buttons
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1, // Allow buttons to grow and take equal space
    marginHorizontal: 5, // Space between buttons
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 5,
    elevation: 5,
  },
  actionButtonText: {
    color: '#FFFFFF', // Default white for most action buttons
    fontSize: 16, // Slightly smaller font for multiple buttons
    fontWeight: 'bold',
    textAlign: 'center',
  },
  actionButtonDisabled: {
    opacity: 0.5,
    backgroundColor: '#A9A9A9', // Darker grey for disabled state
  },
  skipButton: {
    backgroundColor: '#FFC107', // Yellow/Orange for Skip
  },
  verifyButton: {
    backgroundColor: '#28A745', // Green for Verify
  },
  ignoreButton: {
    backgroundColor: '#DC3545', // Red for Ignore
  },
  ignoreButtonSelected: { // Style for when "Ignore person" is selected
    borderWidth: 2,
    borderColor: '#FFD700', // Gold border to highlight
  },
  undoButtonContainer: {
    width: '90%',
    marginTop: 20,
    marginBottom: 50, // Changed to fixed value
    alignItems: 'center',
    borderWidth: 2, // Added red border for visibility
    borderColor: 'red',
  },
  undoButton: {
    backgroundColor: '#e69a0e', // Changed to bright yellow for visibility
    width: '80%', // Make it wider
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)', // Darker overlay
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 20,
    width: '90%',
    maxHeight: '80%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
  },
  modalCloseButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    padding: 5,
    zIndex: 1,
  },
  modalCloseText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
  },
  modalTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 15,
    textAlign: 'center',
    color: '#333',
  },
  modalScrollView: {
    flexGrow: 0, // Prevent scroll view from taking full height if content is small
    maxHeight: '85%', // Limit height to prevent overflow
  },
  modalItemText: {
    fontSize: 16,
    marginBottom: 5,
    color: '#555',
  },
  imageContainer: {
    width: '100%', // Full width
    height: height * 0.45, // Takes approximately 45% of screen height for the image
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff', // White background for the image area
    borderRadius: 10,
    overflow: 'hidden', // Ensures image respects border radius
    marginBottom: 20, // Space below the image container
    // Shadow for a subtle depth effect
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3, // Android shadow
  },
  fullScreenImageOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)', // Almost black background for full screen image
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Removed zoomableView style as it's no longer needed
  fullScreenImage: {
    width: '100%',
    height: '100%',
  },
  fullScreenImageCloseButton: { // New style for the close button on the full-screen image modal
    position: 'absolute',
    top: 40, // Adjust as needed to be visible and not cover content
    right: 20,
    backgroundColor: 'rgba(255,255,255,0.3)', // Semi-transparent white background
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10, // Ensure it's on top
  },
  fullScreenImageCloseText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
  },
  noSourceImageText: {
    color: '#FFFFFF',
    fontSize: 18,
    textAlign: 'center',
  },
  modalButtonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
  },
  modalButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  modalButtonConfirm: {
    backgroundColor: '#28A745', // Green
  },
  modalButtonCancel: {
    backgroundColor: '#DC3545', // Red
  },
  modalButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
