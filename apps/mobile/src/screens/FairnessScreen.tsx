import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, fonts, space } from '../theme';
import { Card, H2, P, Pill, Row, ScreenHeader, SectionLabel } from '../components/Ui';
import { Icon } from '../components/Icons';
import { useT } from '../i18n';
import { caveatText, failureText } from '../logic/fairnessText';

export function FairnessScreen() {
  const app = useApp();
  const { t } = useT();
  const state = useSession(app.session);
  const audits = state?.audits ?? [];
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('fairness.title')} onBack={app.back} />
      <Card>
        <Row>
          <Icon name="shield" size={34} />
          <H2>{t('fairness.howTitle')}</H2>
        </Row>
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
      {/* The end of a match is believed only when the hands this phone verified lead to it; say so when they do not. */}
      {state?.matchOver && !state.matchEndVerified && (
        <Text testID="fairness-end-unverified" style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
          {t('fairness.endUnverified')}
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
                {t('fairness.commit', { who: c.seat === 4 ? t('fairness.server') : t('fairness.seat', { n: c.seat + 1 }), hash: c.hash.slice(0, 16), secret: audit.reveals.find((r) => r.seat === c.seat)?.secret.slice(0, 8) ?? '' })}
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
});
