import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, fonts, space } from '../theme';
import { Card, fontFor, H2, P, Pill, Row, ScreenHeader, SectionLabel } from '../components/Ui';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';
import { caveatText, claimsPassedLateText, claimsPassedText, endNote, failureText, turnsLateText } from '../logic/fairnessText';

export function FairnessScreen() {
  const app = useApp();
  const { t } = useT();
  const state = useSession(app.session);
  const audits = state?.audits ?? [];
  const passed = claimsPassedText(t, state);
  const passedLate = claimsPassedLateText(t, state);
  const turnsLate = turnsLateText(t, state);
  // Against bots the phone is the only party: it deals and it checks itself. Say so, and do not call the fifth secret a server's.
  const local = app.session?.mode === 'local';
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('fairness.title')} onBack={app.back} />
      <Card>
        <Row>
          <Icon name="shield" size={34} />
          <H2>{t('fairness.howTitle')}</H2>
        </Row>
        {local && (
          <View testID="fairness-local" style={styles.local}>
            <Icon name="bot" size={22} />
            <Text style={[styles.localText, fontFor(t('fairness.localNote'), fonts.bodyBold, '700')]}>{t('fairness.localNote')}</Text>
          </View>
        )}
        <P>{t('fairness.step1')}</P>
        <P>{t('fairness.step2')}</P>
        <P>{t('fairness.step3')}</P>
        <P>{t('fairness.step4')}</P>
        <P>
          {t('fairness.partialBefore')}
          <Text style={{ color: colors.goldDim, fontFamily: fonts.bodyBold }}>{t('fairness.partialLabel')}</Text>
          {t('fairness.partialAfter')}
        </P>
        <P dim style={{ fontSize: 12 }}>
          {t('fairness.trust')}
        </P>
      </Card>
      <SectionLabel>{t('fairness.sessionHands')}</SectionLabel>
      {audits.length === 0 && <Pill text={t('fairness.none')} icon="hourglass" />}
      {/* The end of a match is believed only when the hands this phone verified lead to it, and its final scores are shown
          as verified only when no hand of the match failed its check; say why when they are not. */}
      {endNote(state) && (
        <Text testID="fairness-end-unverified" style={{ color: endNote(state) === 'failed' ? colors.dangerText : colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
          {t(endNote(state) === 'failed' ? 'fairness.endFailed' : 'fairness.endUnverified')}
        </Text>
      )}
      {/* The claims the table passed for this seat while its link was down, over the match: the pattern a cut link leaves. */}
      {passed && (
        <Text testID="fairness-claims-passed" style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
          {passed}
        </Text>
      )}
      {/* The same on turns that reached the phone late, whether or not the link dropped: the pattern a held-back turn leaves. */}
      {passedLate && (
        <Text testID="fairness-claims-passed-late" style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
          {passedLate}
        </Text>
      )}
      {/* The turns that reached the phone with more than a quarter of their clock gone (at least 1 s), over the match: never a
          verdict, but the pattern a server leaves that shows every turn late inside the half a turn clock the audit allows. */}
      {turnsLate && (
        <Text testID="fairness-turns-late" style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
          {turnsLate}
        </Text>
      )}
      {audits
        .slice()
        .reverse()
        .map(({ audit, status, failures, caveats }) => (
          <Card key={`${audit.matchId}-${audit.handNumber}`} style={{ gap: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>{t('fairness.hand', { n: audit.handNumber + 1 })}</H2>
              {/* Amber 'Logged' carries no shield: only a deal this phone watched whole earns one. */}
              <Pill
                icon={status === 'ok' ? 'shield' : status === 'failed' ? 'warning' : status === 'partial' ? undefined : 'hourglass'}
                wrap={status === 'partial'}
                text={t(status === 'ok' ? 'fairness.status.ok' : status === 'partial' ? 'fairness.status.partial' : status === 'failed' ? 'fairness.status.failed' : 'fairness.status.unverified')}
                tone={status === 'ok' ? 'ok' : status === 'partial' ? 'gold' : status === 'failed' ? 'danger' : 'neutral'}
              />
            </Row>
            <Text style={styles.mono}>{t('fairness.seed', { seed: audit.seed })}</Text>
            {audit.commits.map((c) => (
              <Text key={c.seat} style={styles.mono}>
                {t('fairness.commit', { who: c.seat === 4 ? t(local ? 'fairness.table' : 'fairness.server') : t('fairness.seat', { n: c.seat + 1 }), hash: c.hash.slice(0, 16), secret: audit.reveals.find((r) => r.seat === c.seat)?.secret.slice(0, 8) ?? '' })}
              </Text>
            ))}
            <Text style={styles.mono}>
              {t('fairness.log', { n: audit.log.length, hash: audit.finalHash })}
            </Text>
            {(caveats ?? []).map((c, i) => (
              <Text key={`c${i}`} style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
                {t('fairness.note', { text: caveatText(t, c) })}
              </Text>
            ))}
            {failures.map((f, i) => (
              <Text key={i} style={{ color: colors.dangerText, fontSize: 12, fontFamily: fonts.bodyBold }}>
                {t('fairness.note', { text: failureText(t, f) })}
              </Text>
            ))}
          </Card>
        ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  mono: { color: colors.inkDim, fontSize: 11, fontFamily: 'monospace' },
  local: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.ink, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  localText: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18 },
});
