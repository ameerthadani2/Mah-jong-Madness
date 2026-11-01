import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, radius, space } from '../theme';

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  style,
  small,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={small ? 6 : 2}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        kind === 'primary' && { backgroundColor: colors.gold },
        kind === 'secondary' && { backgroundColor: colors.feltLight },
        kind === 'danger' && { backgroundColor: colors.danger },
        kind === 'ghost' && { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.textDim },
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      <Text style={[styles.btnText, small && { fontSize: 13 }, kind === 'primary' && { color: colors.ink }]}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H1({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h1, style]}>{children}</Text>;
}
export function H2({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h2, style]}>{children}</Text>;
}
export function P({ children, dim, style }: { children: React.ReactNode; dim?: boolean; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.p, dim && { color: colors.textDim }, style]}>{children}</Text>;
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'gold' | 'ok' | 'danger' }) {
  const bg = tone === 'gold' ? colors.gold : tone === 'ok' ? colors.ok : tone === 'danger' ? colors.danger : colors.panel;
  const fg = tone === 'neutral' ? colors.text : colors.ink;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function Row({ children, style, gap = space.sm }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.toggleRow}>
      <Text style={styles.p}>{label}</Text>
      <View style={[styles.toggle, value && { backgroundColor: colors.gold }]}>
        <View style={[styles.knob, value && { alignSelf: 'flex-end' }]} />
      </View>
    </Pressable>
  );
}

export function Stepper({ label, value, onChange, step = 1, min = 0, max = 9999, format }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.p}>{label}</Text>
      <Row>
        <Button small kind="secondary" title="−" onPress={() => onChange(Math.max(min, value - step))} />
        <Text style={[styles.p, { minWidth: 56, textAlign: 'center' }]}>{format ? format(value) : value}</Text>
        <Button small kind="secondary" title="+" onPress={() => onChange(Math.min(max, value + step))} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 18, paddingVertical: 12, minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnSmall: { paddingHorizontal: 12, paddingVertical: 8, minHeight: 36 },
  btnText: { color: colors.text, fontWeight: '800', fontSize: 15 },
  card: { backgroundColor: colors.panel, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  h1: { color: colors.gold, fontSize: 28, fontWeight: '900', letterSpacing: 0.5 },
  h2: { color: colors.text, fontSize: 18, fontWeight: '800' },
  p: { color: colors.text, fontSize: 15, lineHeight: 21 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  toggle: { width: 48, height: 28, borderRadius: 14, backgroundColor: colors.panelStrong, padding: 3, justifyContent: 'center' },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ivory },
});
