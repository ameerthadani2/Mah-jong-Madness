/**
 * The club's record of matches an owner or admin closed before they finished (the server's
 * `closedMatches`): newest first, with who closed it, the hand it had reached and each seat's points
 * at that moment. Shown under the standings, which these matches never count toward.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ClosedMatch } from '../api/clubs';
import { useT } from '../i18n';
import { colors, fonts } from '../theme';
import { P, SectionLabel } from './Ui';

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function ClubClosedMatches({ matches }: { matches: readonly ClosedMatch[] | undefined }) {
  const { t } = useT();
  if (!matches?.length) return null;
  return (
    <View style={styles.box} testID="club-closed-matches">
      <SectionLabel>{t('clubs.closed.title')}</SectionLabel>
      <P dim style={styles.note}>
        {t('clubs.closed.note')}
      </P>
      {[...matches].reverse().map((m) => (
        <View key={`${m.table}-${m.closedAt}`} style={styles.match} accessible testID={`closed-${m.table}`}>
          <Text style={styles.line}>{t('clubs.closed.line', { table: m.label || m.table, name: m.closedBy.name, hand: m.handNumber + 1, date: new Date(m.closedAt).toLocaleDateString() })}</Text>
          <Text style={styles.scores}>
            {[...m.seats]
              .sort((a, b) => a.seat - b.seat)
              .map((s) => `${s.isBot ? t('clubs.closed.bot', { name: s.name }) : s.name} ${signed(s.points)}`)
              .join(' · ')}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 12, gap: 6 },
  note: { fontSize: 12, lineHeight: 17 },
  match: { paddingVertical: 6, borderTopWidth: 2, borderTopColor: colors.creamDeep, gap: 2 },
  line: { color: colors.ink, fontSize: 13 },
  scores: { color: colors.inkDim, fontSize: 12, fontFamily: fonts.body },
});
