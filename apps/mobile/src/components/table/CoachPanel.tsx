/** The coach bubble: status, the most useful advice, waits and claim reasons (offline bot tables only). */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Hint } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { CoachOwl } from '../Avatars';
import { Icon } from '../Icons';
import { Tile } from '../Tile';
import { Row } from '../Ui';

export function CoachPanel({ hint, waitKinds, compact, lines = 3 }: { hint: Hint; waitKinds: Set<number>; compact?: boolean; /** Lines for the advice in the compact bubble. */ lines?: number }) {
  const { t } = useT();
  // Coach sentences are engine reason keys rendered in the current locale (see src/i18n/index.ts).
  const engine = (key: string, params?: Record<string, string | number>) => t(`engine.${key}`, params);
  const preview = hint.winPreview ? t('table.coach.winPreview', { items: hint.winPreview.items.map((i) => t('table.coach.taiItem', { name: i.nameZh, tai: i.tai })).join(' · '), tai: hint.winPreview.tai }) : null;
  if (compact) {
    // Status + the single most useful piece of advice; both wrap (two lines each) rather than truncate mid-word.
    const rec = hint.claims.find((c) => c.recommended);
    const line = preview ?? (hint.discardReasonKey ? engine(hint.discardReasonKey, hint.discardReasonParams) : rec ? engine(rec.reasonKey, rec.reasonParams) : '');
    return (
      <View style={[styles.coach, styles.coachCompact]} accessibilityRole="summary" testID="coach">
        <CoachOwl size={30} />
        <View style={{ flex: 1, minWidth: 0, flexShrink: 1 }}>
          <Text style={styles.coachStatus} numberOfLines={2}>
            {engine(hint.statusKey, hint.statusParams)}
          </Text>
          {!!line && (
            <Text style={styles.coachLine} numberOfLines={lines}>
              {line}
            </Text>
          )}
        </View>
        {hint.waits.length > 0 && (
          <Row gap={2} style={{ flexShrink: 0 }}>
            {hint.waits.slice(0, 4).map((w) => (
              <Tile key={w.kind} kind={w.kind} size="xs" highlight={waitKinds.has(w.kind) ? 'wait' : undefined} />
            ))}
          </Row>
        )}
      </View>
    );
  }
  return (
    <View style={styles.coach} accessibilityRole="summary" testID="coach">
      <Row gap={8}>
        <CoachOwl size={36} />
        <Text style={styles.coachTitle}>{t('table.coach.title')}</Text>
      </Row>
      <Text style={styles.coachStatus}>{engine(hint.statusKey, hint.statusParams)}</Text>
      {preview && <Text style={styles.coachLine}>{preview}</Text>}
      {hint.discardReasonKey && <Text style={styles.coachLine}>{engine(hint.discardReasonKey, hint.discardReasonParams)}</Text>}
      {hint.waits.length > 0 && (
        <Row style={{ flexWrap: 'wrap' }} gap={4}>
          <Text style={styles.coachLabel}>{t('table.coach.waits')}</Text>
          {hint.waits.map((w) => (
            <View key={w.kind} style={{ alignItems: 'center' }}>
              <Tile kind={w.kind} size="xs" highlight={waitKinds.has(w.kind) ? 'wait' : undefined} />
              <Text style={styles.coachCount}>{t('table.coach.remaining', { n: w.remaining })}</Text>
            </View>
          ))}
        </Row>
      )}
      {hint.claims.map((c, i) => (
        <Row key={i} gap={4} style={{ alignItems: 'flex-start' }}>
          {c.recommended ? <Icon name="check" size={16} color={colors.cta} /> : <View style={styles.coachDot} />}
          <Text style={[styles.coachLine, { flex: 1 }, c.recommended && { color: colors.okText }]}>
            {t('table.coach.claimLine', { label: engine(c.labelKey, c.labelParams), reason: engine(c.reasonKey, c.reasonParams) })}
          </Text>
        </Row>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  coach: { backgroundColor: colors.cream, borderRadius: 16, padding: 8, gap: 4, borderWidth: 3, borderColor: colors.ink, flexShrink: 1, overflow: 'hidden' },
  coachCompact: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, maxWidth: 520, flexShrink: 1, paddingVertical: 5 },
  coachTitle: { color: colors.ink, fontFamily: fonts.display, fontSize: 18 },
  coachStatus: { color: colors.ink, fontFamily: fonts.uiBold, fontSize: 13, lineHeight: 17 },
  coachLine: { color: colors.inkDim, fontSize: 12, lineHeight: 15, fontWeight: '700' },
  coachLabel: { color: colors.ink, fontWeight: '900', fontSize: 13 },
  coachCount: { color: colors.inkDim, fontSize: 11, fontWeight: '800' },
  coachDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.inkDim, marginTop: 5, marginHorizontal: 5 },
});
