/**
 * The hidden polite live region beside the compass: it speaks when the round or the seats turn, or the wall
 * drops to 10, 5 or its last tile (./hudSpeech.ts `hudNotice`), and says nothing on an ordinary draw.
 * Android and the web read the region; iOS ignores live regions and is told through `useAnnounce`.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '../../i18n';
import { useAnnounce } from './announce';
import { hudNotice, type HudFacts } from './hudSpeech';

export function CompassNotice({ facts, compassText, wallText }: { facts: HudFacts; compassText: string; wallText: string }) {
  const { t } = useT();
  const last = useRef<HudFacts | null>(null);
  const [notice, setNotice] = useState<{ parts: Array<'compass' | 'wall'>; n: number } | null>(null);
  const { round, myWind, dealerRel, drawsLeft } = facts;
  useEffect(() => {
    const next = { round, myWind, dealerRel, drawsLeft };
    const parts = hudNotice(last.current, next);
    last.current = next;
    if (parts.length) setNotice((prev) => ({ parts, n: (prev?.n ?? 0) + 1 }));
  }, [round, myWind, dealerRel, drawsLeft]);
  const spoken = notice ? notice.parts.map((p) => (p === 'compass' ? compassText : wallText)).join(t('table.a11y.sentenceBreak')) : '';
  useAnnounce(spoken || null, notice?.n);
  return (
    <View style={styles.hiddenLive} accessibilityLiveRegion="polite" testID="compass-notice" pointerEvents="none">
      <Text style={styles.hiddenText}>{spoken}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hiddenLive: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden' },
  hiddenText: { color: 'transparent' },
});
