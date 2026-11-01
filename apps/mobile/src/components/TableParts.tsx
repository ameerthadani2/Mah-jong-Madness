import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { kindInfo, kindOf, WINDS, type Meld, type PlayerView, type TileId } from '@mjm/engine';
import type { SeatInfo } from '@mjm/net';
import { colors, radius } from '../theme';
import { Tile, type TileSize } from './Tile';

export function MeldView({ meld, size = 'sm' }: { meld: Meld; size?: TileSize }) {
  return (
    <View style={styles.meld}>
      {meld.tiles.map((t, i) => {
        const hidden = meld.type === 'kong' && meld.concealed && (i === 0 || i === 3);
        return <Tile key={t} tile={t} size={size} faceDown={hidden} rotated={!meld.concealed && meld.claimed === t} />;
      })}
    </View>
  );
}

export function TileStrip({ tiles, size = 'xs', max = 20 }: { tiles: TileId[]; size?: TileSize; max?: number }) {
  const shown = tiles.slice(-max);
  return (
    <View style={styles.strip}>
      {shown.map((t) => (
        <Tile key={t} tile={t} size={size} />
      ))}
    </View>
  );
}

export function DiscardPool({ tiles, size = 'xs', perRow = 8, latest }: { tiles: TileId[]; size?: TileSize; perRow?: number; latest?: TileId }) {
  const rows: TileId[][] = [];
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow));
  return (
    <View style={{ gap: 2 }}>
      {rows.map((row, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 2 }}>
          {row.map((t) => (
            <Tile key={t} tile={t} size={size} highlight={t === latest ? 'wait' : undefined} />
          ))}
        </View>
      ))}
    </View>
  );
}

export function SeatBadge({
  seat,
  info,
  player,
  dealerSeat,
  isTurn,
  score,
  compact,
  viewerSeat,
}: {
  seat: number;
  info?: SeatInfo;
  player: PlayerView;
  dealerSeat: number;
  isTurn: boolean;
  score: number;
  compact?: boolean;
  viewerSeat: number;
}) {
  const wind = WINDS[(seat - dealerSeat + 4) % 4];
  const rel = (seat - viewerSeat + 4) % 4;
  const relLabel = rel === 0 ? '你' : rel === 1 ? '下家' : rel === 2 ? '對家' : '上家';
  return (
    <View style={[styles.badge, isTurn && styles.badgeTurn, compact && { paddingVertical: 2 }]}>
      <Text style={styles.badgeAvatar}>{info?.avatar ?? (info?.isBot ? '🤖' : '🀄')}</Text>
      <View>
        <Text style={styles.badgeName} numberOfLines={1}>
          {info?.name || `Seat ${seat + 1}`} {seat === dealerSeat ? '莊' : ''}
        </Text>
        <Text style={styles.badgeMeta}>
          {wind} · {relLabel} · {score >= 0 ? '+' : ''}
          {score}
          {info && !info.connected && !info.isBot ? ' · 離線' : ''}
        </Text>
      </View>
      {player.flowers.length > 0 && (
        <View style={styles.flowers}>
          {player.flowers.map((f) => (
            <Text key={f} style={styles.flower}>
              {kindInfo(kindOf(f)).nameZh}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  meld: { flexDirection: 'row', alignItems: 'flex-end', gap: 1, marginRight: 6 },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.panel, borderRadius: radius.md, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: 'transparent' },
  badgeTurn: { borderColor: colors.gold },
  badgeAvatar: { fontSize: 18 },
  badgeName: { color: colors.text, fontWeight: '800', fontSize: 12, maxWidth: 120 },
  badgeMeta: { color: colors.textDim, fontSize: 10 },
  flowers: { flexDirection: 'row', gap: 2, marginLeft: 4 },
  flower: { color: colors.pink, fontSize: 11, fontWeight: '800', backgroundColor: colors.ivory, borderRadius: 3, paddingHorizontal: 2 },
});
