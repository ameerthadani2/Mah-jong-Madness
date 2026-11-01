import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, displayText, radius, space } from '../theme';

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'gold';

const KIND: Record<ButtonKind, { fill: string; shelf: string; outline: string; text: string; shadow: boolean }> = {
  primary: { fill: colors.cta, shelf: colors.ctaShelf, outline: colors.ctaOutline, text: '#FFFFFF', shadow: true },
  secondary: { fill: colors.info, shelf: colors.infoShelf, outline: '#143F8A', text: '#FFFFFF', shadow: true },
  danger: { fill: colors.danger, shelf: colors.dangerShelf, outline: '#7A1F23', text: '#FFFFFF', shadow: true },
  gold: { fill: colors.gold, shelf: colors.goldShelf, outline: colors.goldDim, text: colors.ink, shadow: false },
  ghost: { fill: colors.cream, shelf: colors.creamEdge, outline: colors.creamEdge, text: colors.ink, shadow: false },
};

/** Chunky Flat-2.0 button: 3px outline, hard shelf, drops 4px when pressed. */
export function Button({ title, onPress, kind = 'primary', disabled, style, small, testID }: { title: string; onPress?: () => void; kind?: ButtonKind; disabled?: boolean; style?: StyleProp<ViewStyle>; small?: boolean; testID?: string }) {
  const k = KIND[kind];
  const shelf = small ? 4 : 6;
  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled} hitSlop={small ? 6 : 2} style={({ pressed }) => [{ opacity: disabled ? 0.45 : 1, paddingBottom: pressed ? 0 : shelf, transform: [{ translateY: pressed ? shelf : 0 }] }, style]}>
      {({ pressed }) => (
        <View style={[styles.btnShell, { borderColor: k.outline, backgroundColor: k.shelf, borderRadius: small ? 14 : 18 }]}>
          <View style={[styles.btnFace, { backgroundColor: k.fill, borderRadius: small ? 11 : 15, marginBottom: pressed ? 0 : shelf - 1 }, small && styles.btnFaceSmall]}>
            <Text style={[styles.btnText, small && { fontSize: 13 }, { color: k.text }, k.shadow && { textShadowColor: 'rgba(16,20,47,0.6)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1 }]}>{title}</Text>
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** Cream panel with outline and a light top highlight. */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.cardShelf, style && { alignSelf: 'auto' }]}>
      <View style={[styles.card, style]}>
        <View style={styles.cardHighlight} />
        {children}
      </View>
    </View>
  );
}

export function H1({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h1, style]}>{children}</Text>;
}
export function H2({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h2, style]}>{children}</Text>;
}
export function P({ children, dim, style }: { children: React.ReactNode; dim?: boolean; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.p, dim && { color: '#4B5068' }, style]}>{children}</Text>;
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'gold' | 'ok' | 'danger' | 'premium' }) {
  const bg = tone === 'gold' ? colors.gold : tone === 'ok' ? colors.ok : tone === 'danger' ? colors.danger : tone === 'premium' ? colors.premium : colors.cream;
  const fg = tone === 'neutral' || tone === 'gold' ? colors.ink : '#FFFFFF';
  const edge = tone === 'gold' ? colors.goldDim : tone === 'ok' ? colors.ctaOutline : tone === 'danger' ? colors.dangerShelf : tone === 'premium' ? colors.premiumShelf : colors.creamEdge;
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: edge }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '800' }}>{text}</Text>
    </View>
  );
}

export function Row({ children, style, gap = space.sm }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.toggleRow} hitSlop={4}>
      <Text style={[styles.p, { flex: 1 }]}>{label}</Text>
      <View style={[styles.toggle, value && { backgroundColor: colors.cta, borderColor: colors.ctaOutline }]}>
        <View style={[styles.knob, value && { alignSelf: 'flex-end' }]} />
      </View>
    </Pressable>
  );
}

export function Stepper({ label, value, onChange, step = 1, min = 0, max = 9999, format }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={[styles.p, { flex: 1 }]}>{label}</Text>
      <Row>
        <Button small kind="ghost" title="−" onPress={() => onChange(Math.max(min, value - step))} />
        <Text style={[styles.p, { minWidth: 56, textAlign: 'center', fontWeight: '800' }]}>{format ? format(value) : value}</Text>
        <Button small kind="ghost" title="+" onPress={() => onChange(Math.min(max, value + step))} />
      </Row>
    </View>
  );
}

/** Selectable chip (filters, presets). */
export function Chip({ label, selected, onPress, locked }: { label: string; selected?: boolean; onPress?: () => void; locked?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.chip, selected && styles.chipOn, pressed && { opacity: 0.8 }]}>
      <Text style={[styles.chipText, selected && { color: colors.ink }]}>
        {locked ? '🔒 ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btnShell: { borderWidth: 3, overflow: 'hidden' },
  btnFace: { paddingHorizontal: 18, paddingVertical: 11, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  btnFaceSmall: { paddingHorizontal: 12, paddingVertical: 7, minHeight: 34 },
  btnText: { fontWeight: '900', fontSize: 15, letterSpacing: 0.3 },
  cardShelf: { backgroundColor: colors.creamEdge, borderRadius: radius.lg + 3, paddingBottom: 4 },
  card: { backgroundColor: colors.cream, borderRadius: radius.lg, borderWidth: 3, borderColor: colors.creamEdge, padding: space.lg, gap: space.sm, overflow: 'hidden' },
  cardHighlight: { position: 'absolute', top: 0, left: 12, right: 12, height: 2, backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 2 },
  h1: { ...displayText, fontSize: 28, fontWeight: '900', letterSpacing: 0.5 },
  h2: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  p: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 2 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: 8 },
  toggle: { width: 50, height: 30, borderRadius: 15, backgroundColor: colors.creamDeep, borderWidth: 2, borderColor: colors.creamEdge, padding: 2, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF', borderWidth: 2, borderColor: colors.ink },
  chip: { backgroundColor: colors.cream, borderWidth: 2, borderColor: colors.creamEdge, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999 },
  chipOn: { backgroundColor: colors.gold, borderColor: colors.goldDim },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
});
