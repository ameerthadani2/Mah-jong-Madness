import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { colors, fonts, hasCJK, radius, space } from '../theme';
import { Icon, type IconName } from './Icons';
import { slopFor } from './table/layout';
import { t } from '../i18n';
import { useDisplayScale } from '../display/DisplayScale';
import { scaleTextStyle } from '../display/scale';

/** Screen-reader name for an icon-only button, when the caller gives none. */
function iconLabel(icon: IconName): string {
  return t(`table.a11y.icon.${icon}`, { defaultValue: icon });
}

/* ------------------------------------------------------------------ */
/* Stroked display text                                                */
/* ------------------------------------------------------------------ */

const RING: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0.72, 0.72],
  [-0.72, 0.72],
  [0.72, -0.72],
  [-0.72, -0.72],
];

function childText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childText).join('');
  return '';
}

/** Picks a Latin face, or leaves fontFamily unset (system CJK, heavy) when the text is Chinese. */
export function fontFor(children: React.ReactNode, latin: string, cjkWeight: TextStyle['fontWeight'] = '900'): TextStyle {
  return hasCJK(childText(children)) ? { fontWeight: cjkWeight } : { fontFamily: latin };
}

/**
 * White display type with a dark outline: eight offset copies in the stroke
 * colour plus a drop copy sit behind the fill text.
 */
export function StrokeText({
  children,
  style,
  color = '#FFFFFF',
  strokeColor = colors.ink,
  strokeWidth = 2,
  drop = 2,
  numberOfLines,
  containerStyle,
  font = fonts.display,
}: {
  children: React.ReactNode;
  style?: StyleProp<TextStyle>;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  drop?: number;
  numberOfLines?: number;
  containerStyle?: StyleProp<ViewStyle>;
  font?: string;
}) {
  const base: TextStyle = { ...fontFor(children, font), ...(StyleSheet.flatten(style) ?? {}) };
  const copies: Array<[number, number]> = RING.map(([x, y]) => [x * strokeWidth, y * strokeWidth]);
  if (drop > 0) copies.unshift([-strokeWidth * 0.7, strokeWidth + drop], [0, strokeWidth + drop], [strokeWidth * 0.7, strokeWidth + drop]);
  return (
    <View style={containerStyle}>
      {copies.map(([dx, dy], i) => (
        <Text
          key={i}
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          numberOfLines={numberOfLines}
          selectable={false}
          style={[base, styles.strokeCopy, { color: strokeColor, left: dx, top: dy, right: -dx, bottom: -dy }]}
        >
          {children}
        </Text>
      ))}
      <Text numberOfLines={numberOfLines} selectable={false} style={[base, { color }]}>
        {children}
      </Text>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'gold' | 'premium';

const KIND: Record<ButtonKind, { fill: string; light: string; shelf: string; text: string; stroke: boolean }> = {
  primary: { fill: colors.cta, light: colors.ctaLight, shelf: colors.ctaShelf, text: '#FFFFFF', stroke: true },
  secondary: { fill: colors.info, light: colors.infoLight, shelf: colors.infoShelf, text: '#FFFFFF', stroke: true },
  danger: { fill: colors.danger, light: colors.dangerLight, shelf: colors.dangerShelf, text: '#FFFFFF', stroke: true },
  gold: { fill: colors.gold, light: colors.goldLight, shelf: colors.goldShelf, text: '#FFFFFF', stroke: true },
  premium: { fill: colors.premium, light: colors.premiumLight, shelf: colors.premiumShelf, text: '#FFFFFF', stroke: true },
  ghost: { fill: colors.creamDeep, light: colors.creamLight, shelf: colors.creamShelf, text: colors.ink, stroke: false },
};

/** Chunky two-tone button: ink outline, lighter top tone, hard shelf; drops onto the shelf when pressed. */
export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  style,
  small,
  large,
  testID,
  icon,
  accessibilityLabel,
}: {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  large?: boolean;
  testID?: string;
  icon?: IconName;
  /** Screen-reader name, when the visible title is not enough on its own. */
  accessibilityLabel?: string;
}) {
  const k = KIND[kind];
  const shelf = small ? 4 : large ? 7 : 5;
  const r = small ? 14 : large ? 22 : 18;
  const fontSize = small ? 15 : large ? 24 : 19;
  const minHeight = small ? 32 : large ? 54 : 42;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={slopFor(minHeight + shelf, 2)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      style={[{ opacity: disabled ? 0.5 : 1 }, style]}
    >
      {({ pressed }) => (
        <View style={{ paddingTop: pressed ? shelf : 0 }}>
          <View style={[styles.btnShell, { borderRadius: r, backgroundColor: k.shelf, paddingBottom: pressed ? 0 : shelf }]}>
            <View style={[styles.btnFace, { backgroundColor: k.fill, borderRadius: r - 3, minHeight, paddingHorizontal: small ? 12 : large ? 26 : 18 }]}>
              <View style={[styles.btnTop, { backgroundColor: k.light, borderTopLeftRadius: r - 3, borderTopRightRadius: r - 3 }]} />
              <View style={[styles.btnGloss, small && { height: 3, top: 3 }]} />
              <View style={styles.btnRow}>
                {icon && <Icon name={icon} size={small ? 18 : large ? 28 : 22} />}
                {k.stroke ? (
                  <StrokeText style={{ fontSize, lineHeight: fontSize * 1.2 }} strokeWidth={small ? 1.5 : 2} drop={small ? 1 : 1.5} numberOfLines={1}>
                    {title}
                  </StrokeText>
                ) : (
                  <Text numberOfLines={1} style={[{ fontSize: fontSize - 2, color: k.text }, fontFor(title, fonts.uiBold)]}>
                    {title}
                  </Text>
                )}
              </View>
            </View>
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** Round chunky icon button (back, settings, emotes...). */
export function IconButton({ icon, onPress, kind = 'secondary', size = 44, testID, disabled, badge, label, selected }: { icon: IconName; onPress?: () => void; kind?: ButtonKind; size?: number; testID?: string; disabled?: boolean; badge?: React.ReactNode; label?: string; selected?: boolean }) {
  const k = KIND[kind];
  const shelf = size >= 44 ? 5 : 4;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hitSlop={slopFor(size, 6)}
      accessibilityRole="button"
      accessibilityLabel={label ?? iconLabel(icon)}
      accessibilityState={{ disabled: !!disabled, selected: selected ?? undefined }}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      {({ pressed }) => (
        <View>
          <View style={[styles.btnShell, { width: size, height: size, borderRadius: size / 2, backgroundColor: k.shelf, paddingBottom: pressed ? 0 : shelf, paddingTop: pressed ? shelf : 0 }]}>
            <View style={[styles.iconFace, { backgroundColor: k.fill, borderRadius: size / 2 }]}>
              <View style={[styles.btnTop, { backgroundColor: k.light }]} />
              <Icon name={icon} size={Math.round(size * 0.56)} />
            </View>
          </View>
          {badge}
        </View>
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

const OUTER_KEYS = new Set(['flex', 'flexGrow', 'flexShrink', 'flexBasis', 'minWidth', 'maxWidth', 'width', 'alignSelf', 'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginHorizontal', 'marginVertical', 'height', 'minHeight', 'maxHeight']);

function splitStyle(style: StyleProp<ViewStyle>): [ViewStyle, ViewStyle] {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(flat)) (OUTER_KEYS.has(key) ? outer : inner)[key] = v;
  return [outer as ViewStyle, inner as ViewStyle];
}

/** Cream panel: 3px ink outline, hard tan shelf, white top highlight. */
export function Card({ children, style, tone = 'cream', testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; tone?: 'cream' | 'gold' | 'danger' | 'sky'; testID?: string }) {
  const [outer, inner] = splitStyle(style);
  const pal = tone === 'gold' ? { face: '#FFF1C4', shelf: colors.goldShelf } : tone === 'danger' ? { face: '#FFE3E1', shelf: colors.dangerShelf } : tone === 'sky' ? { face: '#E6F7FF', shelf: '#8CCBEA' } : { face: colors.cream, shelf: colors.creamShelf };
  return (
    <View testID={testID} style={[styles.cardShell, { backgroundColor: pal.shelf }, outer]}>
      <View style={[styles.card, { backgroundColor: pal.face, flexGrow: 1 }, inner]}>
        <View pointerEvents="none" style={styles.cardHighlight} />
        {children}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Type                                                                */
/* ------------------------------------------------------------------ */

export function H1({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <StrokeText style={[styles.h1, style]} strokeWidth={2.5} drop={2.5}>
      {children}
    </StrokeText>
  );
}
export function H2({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.h2, fontFor(children, fonts.uiBold), style]}>{children}</Text>;
}
/** Body text. It follows Settings → Display → Text (never below the OS text size); callers' sizes scale too. */
export function P({ children, dim, style, numberOfLines }: { children: React.ReactNode; dim?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const { fontFactor } = useDisplayScale();
  const sized = fontFactor === 1 ? null : scaledType(style, fontFactor);
  return (
    <Text numberOfLines={numberOfLines} style={[styles.p, fontFor(children, fonts.body, '700'), dim && { color: colors.inkDim }, style, sized]}>
      {children}
    </Text>
  );
}

/** Body type's size under a text factor: the caller's fontSize / lineHeight, or the body defaults. */
function scaledType(style: StyleProp<TextStyle>, factor: number): TextStyle {
  const flat = StyleSheet.flatten([styles.p, style]) ?? {};
  const base: TextStyle = typeof flat.lineHeight === 'number' ? { fontSize: flat.fontSize ?? 15, lineHeight: flat.lineHeight } : { fontSize: flat.fontSize ?? 15 };
  return scaleTextStyle(base, factor);
}

export type PillTone = 'neutral' | 'gold' | 'ok' | 'danger' | 'premium' | 'info' | 'dark';
const PILL: Record<PillTone, { bg: string; fg: string }> = {
  neutral: { bg: colors.creamLight, fg: colors.ink },
  gold: { bg: colors.gold, fg: colors.ink },
  ok: { bg: colors.cta, fg: '#FFFFFF' },
  danger: { bg: colors.danger, fg: '#FFFFFF' },
  premium: { bg: colors.premium, fg: '#FFFFFF' },
  info: { bg: colors.info, fg: '#FFFFFF' },
  dark: { bg: 'rgba(16,20,47,0.72)', fg: '#FFFFFF' },
};

export function Pill({ text, tone = 'neutral', icon, style, size = 'md' }: { text: string; tone?: PillTone; icon?: IconName; style?: StyleProp<ViewStyle>; size?: 'sm' | 'md' }) {
  const p = PILL[tone];
  const fs = size === 'sm' ? 11 : 13;
  return (
    <View style={[styles.pill, { backgroundColor: p.bg }, size === 'sm' && { paddingHorizontal: 7, paddingVertical: 1 }, icon && { paddingLeft: 4 }, style]}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 17} />}
      <Text numberOfLines={1} style={[{ color: p.fg, fontSize: fs }, fontFor(text, fonts.uiBold)]}>
        {text}
      </Text>
    </View>
  );
}

export function Row({ children, style, gap = space.sm }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable onPress={() => onChange(!value)} style={styles.toggleRow} hitSlop={4} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: value }}>
      <Text style={[styles.p, fontFor(label, fonts.bodyBold, '700'), { flex: 1 }]}>{label}</Text>
      <View style={[styles.toggle, value && { backgroundColor: colors.cta }]}>
        <View style={[styles.toggleTop, value && { backgroundColor: colors.ctaLight }]} />
        <View style={[styles.knob, value && { alignSelf: 'flex-end' }]} />
      </View>
    </Pressable>
  );
}

export function Stepper({ label, value, onChange, step = 1, min = 0, max = 9999, format }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; format?: (v: number) => string }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={[styles.p, fontFor(label, fonts.bodyBold, '700'), { flex: 1 }]}>{label}</Text>
      <Row>
        <IconButton size={34} kind="ghost" icon="minus" label={`${label} −`} onPress={() => onChange(Math.max(min, value - step))} />
        <Text style={[styles.stepValue, fontFor(format ? format(value) : String(value), fonts.display)]}>{format ? format(value) : value}</Text>
        <IconButton size={34} kind="ghost" icon="plus" label={`${label} +`} onPress={() => onChange(Math.min(max, value + step))} />
      </Row>
    </View>
  );
}

/** Selectable chip (filters, presets). */
export function Chip({ label, selected, onPress, locked, dark }: { label: string; selected?: boolean; onPress?: () => void; locked?: boolean; dark?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={slopFor(34, 4)} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!selected, disabled: !!locked }} style={({ pressed }) => [styles.chip, dark && styles.chipDark, selected && styles.chipOn, pressed && { transform: [{ translateY: 1 }] }]}>
      {locked && <Icon name="lock" size={15} />}
      <Text numberOfLines={1} style={[styles.chipText, fontFor(label, fonts.uiBold), dark && !selected && { color: '#FFFFFF' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Gem balance capsule with a green "+" (opens the shop). */
export function GemCounter({ amount, onPress, testID }: { amount: number; onPress?: () => void; testID?: string }) {
  return (
    <Pressable testID={testID} onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('table.a11y.gems', { n: amount })} style={({ pressed }) => [styles.gemWrap, pressed && { transform: [{ translateY: 2 }] }]}>
      <View style={styles.gemPill}>
        <StrokeText style={{ fontSize: 17 }} strokeWidth={1.5} drop={1}>
          {amount.toLocaleString()}
        </StrokeText>
      </View>
      <View style={styles.gemIcon}>
        <Icon name="gem" size={30} />
      </View>
      {onPress && (
        <View style={styles.gemPlus}>
          <Icon name="plus" size={16} />
        </View>
      )}
    </Pressable>
  );
}

/** Screen title row: round back button, stroked title, optional right-hand items. */
export function ScreenHeader({ title, onBack, backTestID = 'back', right, sub }: { title: string; onBack?: () => void; backTestID?: string; right?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <View style={styles.header}>
      {onBack && <IconButton testID={backTestID} icon="back" kind="secondary" size={44} onPress={onBack} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <StrokeText style={styles.headerTitle} strokeWidth={2.5} drop={2.5} numberOfLines={1}>
          {title}
        </StrokeText>
        {sub}
      </View>
      {right && <Row>{right}</Row>}
    </View>
  );
}

/** Small section label on the sky background. */
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <StrokeText style={{ fontSize: 20 }} strokeWidth={2} drop={2} containerStyle={{ marginTop: 4 }}>
      {children}
    </StrokeText>
  );
}

const styles = StyleSheet.create({
  strokeCopy: { position: 'absolute' },
  btnShell: { borderWidth: 3, borderColor: colors.ink, overflow: 'hidden' },
  btnFace: { justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  btnTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '50%' },
  btnGloss: { position: 'absolute', top: 4, left: 10, width: 14, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.75)' },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  iconFace: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  cardShell: {
    borderWidth: 3,
    borderColor: colors.ink,
    borderRadius: radius.lg,
    paddingBottom: 5,
    shadowColor: colors.ink,
    shadowOpacity: 0.22,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 4 },
  },
  card: { borderRadius: radius.lg - 3, padding: space.lg, gap: space.sm, overflow: 'hidden' },
  cardHighlight: { position: 'absolute', top: 3, left: 16, right: 16, height: 3, backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 2 },
  h1: { fontSize: 30, letterSpacing: 0.5 },
  h2: { color: colors.ink, fontSize: 19 },
  p: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, borderWidth: 2, borderColor: colors.ink, alignSelf: 'flex-start' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, gap: 8 },
  toggle: { width: 56, height: 32, borderRadius: 16, backgroundColor: '#C9CFE3', borderWidth: 3, borderColor: colors.ink, padding: 2, justifyContent: 'center', overflow: 'hidden' },
  toggleTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%', backgroundColor: '#DDE2F0' },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF', borderWidth: 2.5, borderColor: colors.ink },
  stepValue: { color: colors.ink, fontSize: 18, minWidth: 64, textAlign: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.creamLight, borderWidth: 2, borderColor: colors.ink, paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderBottomWidth: 4 },
  chipDark: { backgroundColor: 'rgba(16,20,47,0.55)' },
  chipOn: { backgroundColor: colors.gold },
  chipText: { color: colors.ink, fontSize: 13 },
  gemWrap: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, height: 40 },
  gemPill: { minWidth: 76, height: 30, borderRadius: 15, borderWidth: 3, borderColor: colors.ink, backgroundColor: 'rgba(16,20,47,0.55)', justifyContent: 'center', paddingLeft: 22, paddingRight: 24 },
  gemIcon: { position: 'absolute', left: 0, top: 4 },
  gemPlus: { position: 'absolute', right: -6, top: 7, width: 26, height: 26, borderRadius: 13, backgroundColor: colors.cta, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52 },
  headerTitle: { fontSize: 30, letterSpacing: 0.5 },
});
