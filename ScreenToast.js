import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, Modal, TouchableOpacity } from 'react-native';

/**
 * A small centered card that appears for `duration` ms whenever `trigger`
 * changes to a new truthy value, then auto-dismisses (a tap also closes
 * it). Used as the "you're now on / doing X" cue across every screen.
 *
 *   trigger   any value; a change to a truthy value shows the toast
 *   title     main line (e.g. "Verifying ignored faces")
 *   subtitle  optional; when set, `title` becomes the small label above it
 *             (e.g. title="Now verifying", subtitle="Liam Lewis")
 */
const ScreenToast = ({ trigger, title, subtitle, duration = 2000 }) => {
  const [visible, setVisible] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!trigger || !title) return undefined;
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer.current);
  }, [trigger, title, subtitle, duration]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <TouchableOpacity
        style={styles.wrap}
        activeOpacity={1}
        onPress={() => setVisible(false)}
      >
        <View style={styles.card}>
          {subtitle ? <Text style={styles.label}>{title}</Text> : null}
          <Text style={styles.main}>{subtitle || title}</Text>
        </View>
      </TouchableOpacity>
    </Modal>
  );
};

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0006' },
  card: {
    backgroundColor: '#fff',
    paddingVertical: 22,
    paddingHorizontal: 40,
    borderRadius: 16,
    alignItems: 'center',
    maxWidth: '85%',
  },
  label: { fontSize: 13, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 },
  main: { fontSize: 22, fontWeight: 'bold', color: '#222', textAlign: 'center' },
});

export default ScreenToast;
