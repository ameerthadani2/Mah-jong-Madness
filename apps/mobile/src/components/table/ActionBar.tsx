/** The claim and discard buttons: big CJK verbs (過 吃 碰 槓 打 胡) with the tiles each would take. */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { kindOf, type Action, type Hint, type TableView, type TileId } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT, type Locale } from '../../i18n';
import { Tile } from '../Tile';
import { StrokeText, type ButtonKind } from '../Ui';
import { Icon } from '../Icons';
import { slopFor } from './layout';
import { tileLabel } from './tileLabel';

/** Spoken name of a tile for screen readers, in the UI language. */
export function tileName(tile: TileId, locale: Locale): string {
  return tileLabel(kindOf(tile), locale);
}

const PAL: Record<ButtonKind, [string, string, string]> = {
  primary: [colors.cta, colors.ctaLight, colors.ctaShelf],
  secondary: [colors.info, colors.infoLight, colors.infoShelf],
  danger: [colors.danger, colors.dangerLight, colors.dangerShelf],
  gold: [colors.gold, colors.goldLight, colors.goldShelf],
  premium: [colors.premium, colors.premiumLight, colors.premiumShelf],
  ghost: [colors.creamDeep, colors.creamLight, colors.creamShelf],
};

/**
 * Chunky claim button: a big CJK verb plus the tiles it would take. In English the verb carries a small gloss
 * before it ("Pong 碰"); the zh-TW gloss is empty.
 */
function ClaimButton({ label, gloss, a11y, tiles, kind, onPress, big, testID }: { label: string; gloss?: string; a11y: string; tiles?: TileId[]; kind: ButtonKind; onPress: () => void; big?: boolean; testID?: string }) {
  const [fill, light, shelf] = PAL[kind];
  const h = big ? 60 : 50;
  return (
    <Pressable onPress={onPress} hitSlop={slopFor(h, 4)} accessibilityRole="button" accessibilityLabel={a11y} testID={testID}>
      {({ pressed }) => (
        <View style={[styles.claimShell, { backgroundColor: shelf, height: h, borderRadius: h / 2, paddingBottom: pressed ? 0 : 5, paddingTop: pressed ? 5 : 0 }]}>
          <View style={[styles.claimFace, { backgroundColor: fill, borderRadius: h / 2 }]}>
            <View style={[styles.claimTop, { backgroundColor: light }]} />
            {!!gloss && <Text style={[styles.gloss, kind === 'ghost' ? { color: colors.ink } : null]}>{gloss}</Text>}
            {kind === 'ghost' ? (
              <Text style={[styles.claimGhost, { fontSize: big ? 24 : 21 }]}>{label}</Text>
            ) : (
              <StrokeText style={{ fontSize: big ? 26 : 22, lineHeight: big ? 32 : 27 }} strokeWidth={2} drop={1.5}>
                {label}
              </StrokeText>
            )}
            {tiles && tiles.length > 0 && (
              <View style={{ flexDirection: 'row', gap: 1 }}>
                {tiles.map((t) => (
                  <Tile key={t} tile={t} size={big ? 24 : 20} />
                ))}
              </View>
            )}
          </View>
        </View>
      )}
    </Pressable>
  );
}

export function ActionBar({
  actions,
  act,
  selected,
  hint,
  view,
  big,
  align = 'flex-end',
  tapHint = true,
}: {
  actions: Action[];
  act: (a: Action) => void;
  selected: TileId | null;
  hint: Hint | null;
  view: TableView;
  big?: boolean;
  align?: 'center' | 'flex-end';
  /** The first-game "tap a tile" pill (it retires after the player's first few discards: ./tapHint.ts). */
  tapHint?: boolean;
}) {
  const { t, locale } = useT();
  if (actions.length === 0) return null;
  const hu = actions.find((a) => a.type === 'hu');
  const kongs = actions.filter((a) => a.type === 'kong');
  const pong = actions.find((a) => a.type === 'pong');
  const chis = actions.filter((a) => a.type === 'chi');
  const pass = actions.find((a) => a.type === 'pass');
  const canDiscard = actions.some((a) => a.type === 'discard');
  const recommended = (a: Action) => hint?.claims.find((c) => JSON.stringify(c.action) === JSON.stringify(a))?.recommended;
  const pendingTile = view.pending?.tile;
  const names = (tiles: TileId[]) => tiles.map((x) => tileName(x, locale)).join(', ');
  const label = (verb: string, tiles?: TileId[]) => (tiles && tiles.length ? t('table.a11y.claimWith', { verb, tiles: names(tiles) }) : verb);
  return (
    <View style={[styles.actionBar, { justifyContent: align }]}>
      {tapHint && canDiscard && selected === null && !hu && kongs.length === 0 && (
        <View style={styles.tapHint}>
          <Icon name="play" size={14} />
          <Text style={styles.tapHintText}>{t('table.tapHint')}</Text>
        </View>
      )}
      {pass && <ClaimButton testID="claim-pass" kind="ghost" label={t('table.claim.pass')} gloss={t('table.claimGloss.pass')} a11y={t('table.a11y.pass')} onPress={() => act(pass)} big={big} />}
      {chis.map((c, i) => {
        const tiles = (c as { tiles: TileId[] }).tiles;
        return <ClaimButton key={i} kind={recommended(c) ? 'primary' : 'secondary'} label={t('table.claim.chi')} gloss={t('table.claimGloss.chi')} a11y={label(t('table.a11y.chi'), tiles)} tiles={tiles} onPress={() => act(c)} big={big} />;
      })}
      {pong && <ClaimButton kind={recommended(pong) ? 'primary' : 'secondary'} label={t('table.claim.pong')} gloss={t('table.claimGloss.pong')} a11y={label(t('table.a11y.pong'), pendingTile !== undefined ? [pendingTile] : undefined)} tiles={pendingTile !== undefined ? [pendingTile] : undefined} onPress={() => act(pong)} big={big} />}
      {kongs.map((k, i) => {
        const tile = (k as { tile: TileId }).tile;
        return <ClaimButton key={i} kind={recommended(k) ? 'primary' : 'premium'} label={t('table.claim.kong')} gloss={t('table.claimGloss.kong')} a11y={label(t('table.a11y.kong'), [tile])} tiles={[tile]} onPress={() => act(k)} big={big} />;
      })}
      {canDiscard && selected !== null && <ClaimButton testID="claim-discard" kind="danger" label={t('table.claim.discard')} gloss={t('table.claimGloss.discard')} a11y={label(t('table.a11y.discard'), [selected])} tiles={[selected]} onPress={() => act({ type: 'discard', tile: selected })} big={big} />}
      {hu && <ClaimButton testID="claim-win" kind="gold" label={t(view.phase === 'discard' ? 'table.claim.selfDrawWin' : 'table.claim.win')} gloss={t(view.phase === 'discard' ? 'table.claimGloss.selfDrawWin' : 'table.claimGloss.win')} a11y={t(view.phase === 'discard' ? 'table.a11y.selfDrawWin' : 'table.a11y.win')} onPress={() => act(hu)} big />}
    </View>
  );
}

const styles = StyleSheet.create({
  actionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  tapHint: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(16,20,47,0.78)', borderWidth: 2, borderColor: colors.ink, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  tapHintText: { color: '#FFFFFF', fontFamily: fonts.uiBold, fontSize: 13 },
  claimShell: { borderWidth: 3, borderColor: colors.ink, overflow: 'hidden', minWidth: 60 },
  claimFace: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 16, overflow: 'hidden' },
  claimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: '50%' },
  claimGhost: { color: colors.ink, fontWeight: '900' },
  gloss: { color: '#FFFFFF', fontFamily: fonts.uiBold, fontSize: 13 },
});
