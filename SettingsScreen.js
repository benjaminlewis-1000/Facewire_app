import React from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ScrollView } from 'react-native';

const PREFETCH_DEFAULT = 10;
const PREFETCH_MAX = 60;
const IGNORE_PAGES_DEFAULT = 1;
const IGNORE_PAGES_MAX = 8;

/**
 * App settings. Values are owned by App.js (which persists them to
 * AsyncStorage); this screen is just the UI.
 */
const SettingsScreen = ({
  visible,
  onClose,
  prefetchCount,
  onChangePrefetchCount,
  ignorePages,
  onChangeIgnorePages,
}) => {
  const setValue = (n) => onChangePrefetchCount(Math.max(0, Math.min(PREFETCH_MAX, n)));
  const setPages = (n) => onChangeIgnorePages(Math.max(0, Math.min(IGNORE_PAGES_MAX, n)));

  if (!visible) return null;

  return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Settings</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton} hitSlop={12}>
            <Text style={styles.closeText}>✕</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.sectionLabel}>Prefetch</Text>
          <Text style={styles.description}>
            How many upcoming faces to load in the background so they appear
            instantly. Higher uses more data and memory. Faces already
            handled elsewhere aren&apos;t cached.
          </Text>

          <View style={styles.stepperRow}>
            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => setValue(prefetchCount - 5)}
            >
              <Text style={styles.stepperButtonText}>−5</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => setValue(prefetchCount - 1)}
            >
              <Text style={styles.stepperButtonText}>−</Text>
            </TouchableOpacity>

            <Text style={styles.stepperValue}>{prefetchCount}</Text>

            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => setValue(prefetchCount + 1)}
            >
              <Text style={styles.stepperButtonText}>+</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.stepperButton}
              onPress={() => setValue(prefetchCount + 5)}
            >
              <Text style={styles.stepperButtonText}>+5</Text>
            </TouchableOpacity>
          </View>

          {prefetchCount !== PREFETCH_DEFAULT && (
            <TouchableOpacity
              style={styles.resetLink}
              onPress={() => setValue(PREFETCH_DEFAULT)}
            >
              <Text style={styles.resetLinkText}>
                Reset to default ({PREFETCH_DEFAULT})
              </Text>
            </TouchableOpacity>
          )}
          {prefetchCount === 0 && (
            <Text style={styles.warnText}>
              0 disables prefetching — each face loads when you reach it.
            </Text>
          )}

          <View style={styles.divider} />

          <Text style={styles.sectionLabel}>Confirm ignored faces</Text>
          <Text style={styles.description}>
            Extra screenfuls of ignore candidates to load ahead so the grid
            is instant after you hit the button.
          </Text>

          <View style={styles.stepperRow}>
            <TouchableOpacity style={styles.stepperButton} onPress={() => setPages(ignorePages - 1)}>
              <Text style={styles.stepperButtonText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.stepperValue}>{ignorePages}</Text>
            <TouchableOpacity style={styles.stepperButton} onPress={() => setPages(ignorePages + 1)}>
              <Text style={styles.stepperButtonText}>+</Text>
            </TouchableOpacity>
          </View>
          {ignorePages !== IGNORE_PAGES_DEFAULT && (
            <TouchableOpacity style={styles.resetLink} onPress={() => setPages(IGNORE_PAGES_DEFAULT)}>
              <Text style={styles.resetLinkText}>
                Reset to default ({IGNORE_PAGES_DEFAULT})
              </Text>
            </TouchableOpacity>
          )}
        </ScrollView>
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 44,
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#333' },
  closeButton: { padding: 6 },
  closeText: { fontSize: 20, color: '#555', fontWeight: 'bold' },
  body: { padding: 20 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  description: { fontSize: 14, color: '#666', lineHeight: 20, marginBottom: 20 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  stepperButton: {
    minWidth: 48,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginHorizontal: 4,
    backgroundColor: '#fff',
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  stepperButtonText: { fontSize: 18, fontWeight: 'bold', color: '#007bff' },
  stepperValue: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    minWidth: 64,
    textAlign: 'center',
  },
  divider: { height: 1, backgroundColor: '#ddd', marginVertical: 28 },
  resetLink: { marginTop: 20, alignItems: 'center' },
  resetLinkText: { color: '#007bff', fontSize: 15, textDecorationLine: 'underline' },
  warnText: { marginTop: 16, color: '#b5651d', fontSize: 13, textAlign: 'center' },
});

export default SettingsScreen;
