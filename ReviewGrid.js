import React from 'react';
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

// Fit whole rows that clear the fixed header / meta-row / hint / footer
// chrome; no scroll. These heights are identical on every grid screen so
// the first photo lands at the same spot regardless of which one you're
// on (header 90 + meta 38 + hint 34 + footer 96, plus slack).
const CHROME = 90 + 38 + 34 + 96 + 16;
export const ROWS = Math.max(
  2,
  Math.min(8, Math.floor((height - CHROME) / (CHIP_SIZE + GRID_GAP)))
);
export const PAGE_LIMIT = COLS * ROWS;

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
 *                    banner (e.g. "~N unverified" + Skip person); the row
 *                    is always reserved even when this is null
 *   faces            [{ id, face_img_url }] currently on screen
 *   excluded         Set of flagged face ids
 *   onToggle(id)
 *   loading, error   booleans/strings for the two non-grid states
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
  error,
  emptyTitle = 'All caught up',
  emptyBody = 'Nothing to review right now.',
  submitLabel,
  onSubmit,
  accent = '#C0392B',
}) => {
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
        <Text style={styles.hint} numberOfLines={2}>{hint}</Text>

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
          <>
            <FlatList
              data={faces}
              renderItem={renderChip}
              keyExtractor={(item) => String(item.id)}
              numColumns={COLS}
              scrollEnabled={false}
              contentContainerStyle={styles.grid}
              columnWrapperStyle={styles.gridRow}
            />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <View style={styles.footer}>
              <TouchableOpacity
                style={[styles.submitButton, { backgroundColor: accent }]}
                onPress={onSubmit}
              >
                <Text style={styles.submitButtonText}>{submitLabel}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#f0f0f0',
    paddingTop: 44,
  },
  header: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 60, // clear the global hamburger button (top-left)
    paddingRight: 16,
  },
  title: { flex: 1, fontSize: 20, fontWeight: 'bold', color: '#333' },
  closeButton: { padding: 6 },
  closeText: { fontSize: 20, color: '#555', fontWeight: 'bold' },
  metaRow: {
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  hint: {
    height: 34,
    fontSize: 12,
    lineHeight: 16,
    color: '#777',
    textAlign: 'center',
    paddingHorizontal: 20,
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
  footer: { padding: 16, paddingBottom: 32 },
  submitButton: {
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitButtonText: { color: '#fff', fontSize: 17, fontWeight: 'bold' },
});

export default ReviewGrid;
