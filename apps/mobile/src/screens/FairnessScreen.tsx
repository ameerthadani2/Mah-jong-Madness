import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApp } from '../app-state';
import { useSession } from '../game/useTable';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

export function FairnessScreen() {
  const app = useApp();
  const state = useSession(app.session);
  const audits = state?.audits ?? [];
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Fair play</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <Card>
        <H2>How the deal works</H2>
        <P>1. Before each hand every seat, including bots, picks a secret and publishes its SHA-256 fingerprint.</P>
        <P>2. The shuffle seed is the hash of all four secrets together. Nobody can steer it, not even the host.</P>
        <P>3. When the hand ends, the secrets and the full action log are published. Your phone checks the fingerprints, re-derives the seed, replays the hand and compares the result.</P>
        <P dim style={{ fontSize: 12 }}>
          There is no "luck balancing", no streak engine, no hidden weights. The engine is deterministic and open; the only randomness is the seed above.
        </P>
      </Card>
      <H2>This session's hands</H2>
      {audits.length === 0 && <P dim>No hands finished yet.</P>}
      {audits
        .slice()
        .reverse()
        .map(({ audit, status, failures }) => (
          <Card key={`${audit.matchId}-${audit.handNumber}`} style={{ gap: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>Hand {audit.handNumber + 1}</H2>
              <Pill text={status === 'ok' ? '✓ Verified' : status === 'failed' ? '⚠ Failed' : 'Unverified'} tone={status === 'ok' ? 'ok' : status === 'failed' ? 'danger' : 'neutral'} />
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
              <Text key={i} style={{ color: colors.danger, fontSize: 12 }}>
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
  mono: { color: '#4B5068', fontSize: 11, fontFamily: 'monospace' },
});
