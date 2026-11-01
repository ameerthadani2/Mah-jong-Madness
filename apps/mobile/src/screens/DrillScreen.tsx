import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { countsFromKinds, createRng, discardOptions, kindInfo, kindsToString, NUM_PLAY_KINDS, relevantKinds, shanten, shuffle, waits, type Kind } from '@mjm/engine';
import { useApp } from '../app-state';
import { colors, space } from '../theme';
import { Tile } from '../components/Tile';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

/** A random 17-tile hand (no bonus tiles) that is at most `maxShanten` from ready. */
function randomHand(seed: string, maxShanten: number): Kind[] {
  const rng = createRng(seed);
  for (let attempt = 0; attempt < 400; attempt++) {
    const pool: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = 0; c < 4; c++) pool.push(k);
    shuffle(pool, rng);
    const hand = pool.slice(0, 17).sort((a, b) => a - b);
    if (shanten(countsFromKinds(hand), 5) <= maxShanten) return hand;
  }
  return [];
}

/** A random ready (聽牌) 16-tile hand built from 5 random sets + a pair minus one tile. */
function randomReadyHand(seed: string): Kind[] {
  const rng = createRng(seed);
  for (let attempt = 0; attempt < 400; attempt++) {
    const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
    const hand: Kind[] = [];
    const add = (k: Kind) => {
      counts[k]++;
      hand.push(k);
    };
    let ok = true;
    for (let s = 0; s < 5 && ok; s++) {
      if (rng.next() < 0.65) {
        const suit = rng.int(3);
        const start = suit * 9 + rng.int(7);
        if (counts[start] >= 4 || counts[start + 1] >= 4 || counts[start + 2] >= 4) ok = false;
        else {
          add(start);
          add(start + 1);
          add(start + 2);
        }
      } else {
        const k = rng.int(NUM_PLAY_KINDS);
        if (counts[k] + 3 > 4) ok = false;
        else {
          add(k);
          add(k);
          add(k);
        }
      }
    }
    if (!ok) continue;
    const pair = rng.int(NUM_PLAY_KINDS);
    if (counts[pair] + 2 > 4) continue;
    add(pair);
    add(pair);
    hand.splice(rng.int(hand.length), 1);
    hand.sort((a, b) => a - b);
    if (waits(countsFromKinds(hand), 5).length > 0) return hand;
  }
  return [];
}

export function DrillScreen({ kind }: { kind: 'discard' | 'waits' }) {
  const app = useApp();
  const [n, setN] = useState(0);
  const seed = `${kind}-${app.progress.drillsPlayed}-${n}`;
  return kind === 'discard' ? <DiscardDrill seed={seed} onNext={() => setN(n + 1)} /> : <WaitsDrill seed={seed} onNext={() => setN(n + 1)} />;
}

function DiscardDrill({ seed, onNext }: { seed: string; onNext: () => void }) {
  const app = useApp();
  const [picked, setPicked] = useState<number | null>(null);
  const hand = useMemo(() => randomHand(seed, 2), [seed]);
  const analysis = useMemo(() => {
    const counts = countsFromKinds(hand);
    const unseen = counts.map((c) => 4 - c);
    const opts = discardOptions(counts, 5, unseen);
    const bestShanten = Math.min(...opts.map((o) => o.shanten));
    const bestAcc = Math.max(...opts.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
    const best = new Set(opts.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcc * 0.9).map((o) => o.kind));
    return { opts, best, bestShanten, current: shanten(counts, 5) };
  }, [hand]);

  const pick = (i: number) => {
    if (picked !== null) return;
    setPicked(i);
    const good = analysis.best.has(hand[i]);
    app.setProgress((p) => ({ ...p, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (good ? 1 : 0) }));
  };

  const pickedOpt = picked !== null ? analysis.opts.find((o) => o.kind === hand[picked]) : null;
  const bestOpt = analysis.opts.filter((o) => analysis.best.has(o.kind)).sort((a, b) => b.acceptance - a.acceptance)[0];

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Best discard</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <Card>
        <P dim>You just drew. This hand is {analysis.current <= 0 ? 'ready' : `${analysis.current} from ready`}. Which tile do you discard?</P>
        <View style={styles.hand}>
          {hand.map((k, i) => (
            <Tile key={i} kind={k} size="md" onPress={() => pick(i)} selected={picked === i} highlight={picked !== null ? (analysis.best.has(k) ? 'good' : picked === i ? 'bad' : undefined) : undefined} />
          ))}
        </View>
        {picked !== null && pickedOpt && bestOpt && (
          <View style={{ gap: 6 }}>
            <H2 style={{ color: analysis.best.has(hand[picked]) ? colors.ok : colors.danger }}>{analysis.best.has(hand[picked]) ? 'Good discard!' : 'There is a better one.'}</H2>
            <P>
              Discarding {kindInfo(pickedOpt.kind).nameZh}: {pickedOpt.shanten <= 0 ? 'ready' : `${pickedOpt.shanten} from ready`}, {pickedOpt.accepts.length} kinds / {pickedOpt.acceptance} tiles improve you.
            </P>
            {!analysis.best.has(hand[picked]) && (
              <P>
                Best is {kindInfo(bestOpt.kind).nameZh}: {bestOpt.shanten <= 0 ? 'ready' : `${bestOpt.shanten} from ready`}, {bestOpt.accepts.length} kinds / {bestOpt.acceptance} tiles ({kindsToString(bestOpt.accepts)}).
              </P>
            )}
            <Button title="Next hand" onPress={() => { setPicked(null); onNext(); }} />
          </View>
        )}
      </Card>
    </ScrollView>
  );
}

function WaitsDrill({ seed, onNext }: { seed: string; onNext: () => void }) {
  const app = useApp();
  const hand = useMemo(() => randomReadyHand(seed), [seed]);
  const answer = useMemo(() => new Set(waits(countsFromKinds(hand), 5)), [hand]);
  const candidates = useMemo(() => relevantKinds(countsFromKinds(hand)), [hand]);
  const [chosen, setChosen] = useState<Set<Kind>>(new Set());
  const [checked, setChecked] = useState(false);
  const toggle = (k: Kind) => {
    if (checked) return;
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setChosen(next);
  };
  const correct = checked && chosen.size === answer.size && [...chosen].every((k) => answer.has(k));
  const check = () => {
    setChecked(true);
    const good = chosen.size === answer.size && [...chosen].every((k) => answer.has(k));
    app.setProgress((p) => ({ ...p, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (good ? 1 : 0) }));
  };
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1 style={{ fontSize: 22 }}>Read the wait</H1>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      <Card>
        <P dim>This 16-tile hand is ready. Select every tile that would complete it, then check.</P>
        <View style={styles.hand}>
          {hand.map((k, i) => (
            <Tile key={i} kind={k} size="md" />
          ))}
        </View>
        <H2>Candidates</H2>
        <View style={styles.hand}>
          {candidates.map((k) => (
            <Tile key={k} kind={k} size="sm" onPress={() => toggle(k)} selected={chosen.has(k)} highlight={checked ? (answer.has(k) ? 'good' : chosen.has(k) ? 'bad' : undefined) : undefined} />
          ))}
        </View>
        {!checked ? (
          <Button title="Check" onPress={check} disabled={chosen.size === 0} />
        ) : (
          <View style={{ gap: 6 }}>
            <H2 style={{ color: correct ? colors.ok : colors.danger }}>{correct ? 'Exactly right!' : 'Not all of them.'}</H2>
            <Row style={{ flexWrap: 'wrap' }}>
              <Text style={{ color: colors.text }}>Waits:</Text>
              {[...answer].map((k) => (
                <Pill key={k} text={kindInfo(k).nameZh} tone="gold" />
              ))}
            </Row>
            <Button title="Next hand" onPress={() => { setChosen(new Set()); setChecked(false); onNext(); }} />
          </View>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  hand: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, paddingVertical: 10 },
});
