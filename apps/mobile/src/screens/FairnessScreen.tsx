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
        <P>1. Before each hand your phone picks a secret, and so does every other player. The table server adds a fifth secret of its own and picks the bots' secrets.</P>
        <P>2. All five SHA-256 fingerprints are published before anyone reveals. Your phone only reveals its secret once it holds all five, so no one can pick a secret after seeing yours. The shuffle seed is the hash of all five secrets together.</P>
        <P>3. When the hand ends, the secrets, any restarts of the deal and the full action log are published. Your phone checks the fingerprints, re-derives the seed, replays the hand and compares the result.</P>
        <P>
          A hand marked <Text style={{ color: colors.goldDim, fontFamily: fonts.bodyBold }}>Verified (log only)</Text> checked out in every way, but your own secret was not part of its deal (the server stood in for you, or you joined mid-hand), so that shuffle rests on the server alone.
        </P>
        <P dim style={{ fontSize: 12 }}>
          The server learns the seed when it deals, so it is trusted not to look at the wall during the hand. There is no "luck balancing", no streak engine, no hidden weights. The engine is deterministic and open; the only randomness is the seed above.
        </P>
      </Card>
      <SectionLabel>This session's hands</SectionLabel>
      {audits.length === 0 && <Pill text="No hands finished yet." icon="hourglass" />}
      {audits
        .slice()
        .reverse()
        .map(({ audit, status, failures, caveats }) => (
          <Card key={`${audit.matchId}-${audit.handNumber}`} style={{ gap: 4 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <H2>Hand {audit.handNumber + 1}</H2>
              <Pill
                icon={status === 'ok' || status === 'partial' ? 'shield' : status === 'failed' ? 'warning' : 'hourglass'}
                text={status === 'ok' ? 'Verified' : status === 'partial' ? 'Verified (log only)' : status === 'failed' ? 'Failed' : 'Unverified'}
                tone={status === 'ok' ? 'ok' : status === 'partial' ? 'gold' : status === 'failed' ? 'danger' : 'neutral'}
              />
            </Row>
            <Text style={styles.mono}>seed {audit.seed}</Text>
            {audit.commits.map((c) => (
              <Text key={c.seat} style={styles.mono}>
                {c.seat === 4 ? 'server' : `seat ${c.seat + 1}`} commit {c.hash.slice(0, 16)}… secret {audit.reveals.find((r) => r.seat === c.seat)?.secret.slice(0, 8)}…
              </Text>
            ))}
            <Text style={styles.mono}>
              {audit.log.length} actions · final hash {audit.finalHash}
            </Text>
            {(caveats ?? []).map((c, i) => (
              <Text key={`c${i}`} style={{ color: colors.goldDim, fontSize: 12, fontFamily: fonts.bodyBold }}>
                {c}
              </Text>
            ))}
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
