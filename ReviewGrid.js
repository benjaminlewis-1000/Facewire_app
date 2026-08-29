import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Dimensions,
} from 'react-native';

const { width, height } = Dimensions.get('window');
export const COLS = 3;
const GRID_PADDING = 12;
const GRID_GAP = 8;
export const CHIP_SIZE = Math.floor(
  (width - GRID_PADDING * 2 - GRID_GAP * (COLS - 1)) / COLS
);

// Rough starting guess for how many faces fit (used only for the very
// first render, until the grid area reports its real height via
// onLayout -> onCapacity). ~284 = fixed chrome (padding + header + meta +
// hint + footer) above/below the grid.
const ROW_H = CHIP_SIZE + GRID_GAP;
export const PAGE_LIMIT =
  COLS * Math.max(3, Math.min(9, Math.floor((height - 284) / ROW_H)));

// Given the measured height of the grid area, how many whole rows fit.
// (+GRID_GAP: the last row doesn't need its trailing marginBottom.)
const rowsForHeight = (h) =>
  Math.max(1, Math.floor((h - GRID_PADDING * 2 + GRID_GAP) / ROW_H));

/**
 * Presentational shell for the tap-to-flag review grids (confirm ignored,
 * verify people, verify ignored). Owns layout + chip interaction only;
 * the parent owns data fetching, the excluded set and submit behaviour.
 *
 * Every grid screen uses the same fixed-height header / meta-row / hint
 * stack, so the photo grid starts at the same Y on all of them.
 *
 * Props:
 *   visible, onClose
 *   title            banner text (what screen you're on)
 *   hint             instruction under the banner (clamped to 2 lines)
 *   meta             optional node for the fixed-height row below the
 *                    banner (e.g. "~N left" + Skip person); the row is
 *                    always reserved even when this is null
 *   faces            [{ id, face_img_url }] currently on screen
 *   excluded         Set of flagged face ids
 *   onToggle(id)
 *   loading          true when there's nothing to show yet (full spinner)
 *   busy             true while a submit is in flight (button disabled,
 *                    grid stays put -- no spinner)
 *   error            message string or ''
 *   emptyTitle, emptyBody
 *   submitLabel      button text
 *   onSubmit
 *   accent           button / badge colour (default red)
 */
const ReviewGrid = ({
  visible,
  onClose,
  title,
  hint,
  meta = null,
  faces = [],
  excluded,
  onToggle,
  loading,
  busy = false,
  error,
  emptyTitle = 'All caught up',
  emptyBody = 'Nothing to review right now.',
  submitLabel,
  onSubmit,
  onCapacity,
  accent = '#C0392B',
}) => {
  // Measure the real height available for the grid and tell the parent
  // how many faces fit, so a screenful is always whole rows with no
  // scroll -- no matter the device chrome.
  const [gridH, setGridH] = useState(0);
  useEffect(() => {
    if (gridH > 0 && onCapacity) onCapacity(rowsForHeight(gridH) * COLS);
  }, [gridH, onCapacity]);

  const renderChip = ({ item }) => {
    const isExcluded = excluded.has(item.id);
    return (
      <TouchableOpacity
        style={styles.chip}
        activeOpacity={0.8}
        onPress={() => onToggle(item.id)}
      >
        <Image
          source={{ uri: item.face_img_url }}
          style={[styles.chipImage, isExcluded && styles.chipImageExcluded]}
          resizeMode="cover"
        />
        {isExcluded && (
          <View style={[styles.excludeBadge, { backgroundColor: accent }]}>
            <Text style={styles.excludeBadgeText}>↺</Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  if (!visible) return null;

  return (
      <View style={styles.container}>
        {/* Fixed header stack -- identical geometry on every grid screen */}
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.metaRow}>{meta}</View>
        <Text style={styles.hint} numberOfLines={1}>{hint}</Text>

        <View
          style={styles.gridArea}
          onLayout={(e) => setGridH(e.nativeEvent.layout.height)}
        >
          {loading ? (
            <View style={styles.centerFill}>
              <ActivityIndicator size="large" color="#007bff" />
            </View>
          ) : faces.length === 0 ? (
            <View style={styles.centerFill}>
              <Text style={styles.emptyTitle}>{emptyTitle}</Text>
              <Text style={styles.emptyBody}>{error || emptyBody}</Text>
            </View>
          ) : (
            <FlatList
              data={faces}
              renderItem={renderChip}
              keyExtractor={(item) => String(item.id)}
              numColumns={COLS}
              scrollEnabled={false}
              contentContainerStyle={styles.grid}
              columnWrapperStyle={styles.gridRow}
            />
          )}
        </View>

        {error && faces.length ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[
              styles.submitButton,
              { backgroundColor: accent },
              busy && styles.submitButtonBusy,
            ]}
            onPress={onSubmit}
            disabled={busy}
          >
            <Text style={styles.submitButtonText}>
              {busy ? 'Saving…' : submitLabel}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f0f0f0',
    paddingTop: 56,
  },
  header: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 62, // clear the global hamburger button (top-left)
    paddingRight: 16,
  },
  title: { flex: 1, fontSize: 18, fontWeight: 'bold', color: '#333' },
  closeButton: { padding: 6 },
  closeText: { fontSize: 20, color: '#555', fontWeight: 'bold' },
  metaRow: {
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  hint: {
    height: 20,
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  gridArea: { flex: 1 },
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  excludeBadgeText: { color: '#fff', fontSize: 15, fontWeight: 'bold' },
  errorText: {
    color: '#dc3545',
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  footer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 60 },
  submitButton: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitButtonBusy: { opacity: 0.6 },
  submitButtonText: { color: '#fff', fontSize: 17, fontWeight: 'bold' },
});

export default ReviewGrid;
