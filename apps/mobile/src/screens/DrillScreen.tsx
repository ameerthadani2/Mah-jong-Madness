import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { discardPuzzle, waitsPuzzle } from '@mjm/engine';
import { useApp } from '../app-state';
import { space } from '../theme';
import { PuzzleView } from '../components/PuzzleView';
import { Card, Chip, Pill, Row, ScreenHeader } from '../components/Ui';

export function DrillScreen({ kind }: { kind: 'discard' | 'waits' }) {
  const app = useApp();
  const [n, setN] = useState(0);
  const [difficulty, setDifficulty] = useState<1 | 2 | 3>(2);
  // Seed is fixed for the life of this screen so answering never remounts the puzzle.
  const [runId] = useState(() => Math.random().toString(36).slice(2, 8));
  const seed = `${kind}-${runId}-${n}`;
  const puzzle = useMemo(() => (kind === 'discard' ? discardPuzzle(seed, difficulty) : waitsPuzzle(seed, difficulty)), [kind, seed, difficulty]);
  const acc = app.progress.drillsPlayed ? Math.round((app.progress.drillsCorrect / app.progress.drillsPlayed) * 100) : null;
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={kind === 'discard' ? 'Best discard' : 'Read the wait'} onBack={app.back} />
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        {([1, 2, 3] as const).map((d) => (
          <Chip key={d} label={d === 1 ? 'Easy' : d === 2 ? 'Medium' : 'Hard'} selected={difficulty === d} onPress={() => setDifficulty(d)} />
        ))}
        {acc !== null && <Pill icon="target" text={`${acc}% · ${app.progress.drillsPlayed} played`} />}
      </Row>
      <Card>
        <PuzzleView
          puzzle={puzzle}
          onResult={(r) => app.setProgress((p) => ({ ...p, drillsPlayed: p.drillsPlayed + 1, drillsCorrect: p.drillsCorrect + (r.correct ? 1 : 0) }))}
          onNext={() => setN(n + 1)}
          nextLabel="Next hand"
        />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
});
