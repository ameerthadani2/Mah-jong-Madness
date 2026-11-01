import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, fonts, space } from '../theme';
import { Card, H2, P, Pill, Row, ScreenHeader, SectionLabel } from '../components/Ui';
import { Icon } from '../components/Icons';

export function FairnessScreen() {
  const app = useApp();
  const state = useSession(app.session);
  const audits = state?.audits ?? [];
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title="Fair play" onBack={app.back} />
      <Card>
        <Row>
          <Icon name="shield" size={34} />
          <H2>How the deal works</H2>
        </Row>
        <P>1. Before each hand every seat, including bots, picks a secret and publishes its SHA-256 fingerprint.</P>
        <P>2. The shuffle seed is the hash of all four secrets together. Nobody can steer it, not even the host.</P>
        <P>3. When the hand ends, the secrets and the full action log are published. Your phone checks the fingerprints, re-derives the seed, replays the hand and compares the result.</P>
        <P dim style={{ fontSize: 12 }}>
          There is no "luck balancing", no streak engine, no hidden weights. The engine is deterministic and open; the only randomness is the seed above.
        </P>
      </Card>
      <SectionLabel>This session's hands</SectionLabel>
      {audits.length === 0 && <Pill text="No hands finished yet." icon="hourglass" />}
      {audits
        .slice()
        .reverse()
        .map(({ audit, status, failures }) => (
          <Card key={`${audit.matchId}-${audit.handNumber}`} style={{ gap: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>Hand {audit.handNumber + 1}</H2>
              <Pill icon={status === 'ok' ? 'shield' : status === 'failed' ? 'warning' : 'hourglass'} text={status === 'ok' ? 'Verified' : status === 'failed' ? 'Failed' : 'Unverified'} tone={status === 'ok' ? 'ok' : status === 'failed' ? 'danger' : 'neutral'} />
            </Row>
            <Text style={styles.mono}>seed {audit.seed}</Text>
            {audit.commits.map((c) => (
              <Text key={c.seat} style={styles.mono}>
                seat {c.seat + 1} commit {c.hash.slice(0, 16)}… secret {audit.reveals.find((r) => r.seat === c.seat)?.secret.slice(0, 8)}…
              </Text>
            ))}
            <Text style={styles.mono}>
              {audit.log.length} actions · final hash {audit.finalHash}
            </Text>
            {failures.map((f, i) => (
              <Text key={i} style={{ color: colors.dangerText, fontSize: 12, fontFamily: fonts.bodyBold }}>
                {f}
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
