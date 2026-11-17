/**
 * The Shop's try-on preview: tapping a look's picture opens it here, drawn the way the game will show it, before it is
 * bought. A table look on a small table with a hand, two ponds of discards and the other seats' backs; a tile back on
 * a row of backs on the felt; an avatar frame on the player's own avatar; an emote pack with each emote playable over
 * the player's avatar; a win celebration played once with a button to play it again (with reduce motion on, its
 * still frame and a sentence saying what it does); a set on its own table and backs, with what it holds.
 *
 * The price and the Buy or Equip button are the card's own (ShopScreen.tsx passes the same handlers), so buying
 * here is the same purchase as buying from the card. A modal dialog: a title, every control labelled, closed by its
 * Close button, the scrim or the Back key; the Shop gives focus back to the card that opened it (display/focus.ts).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { kindFromCode } from '@mjm/engine';
import { productById, productText, type Product } from '../monetisation/catalog';
import { EMOTE_PACKS, tileBackById, type CelebrationId, type TileBackDesign } from '../monetisation/cosmetics';
import { useEquipped } from '../monetisation/useEquipped';
import { useReducedMotion } from '../display/reducedMotion';
import { emoteName, themeById, TableThemeContext, type TableTheme } from '../themes';
import { useT } from '../i18n';
import { colors, fonts, radius, space } from '../theme';
import { Button, fontFor, IconButton, Row } from './Ui';
import { Icon } from './Icons';
import { Live } from './Live';
import { FeltFrame } from './TableParts';
import { Tile, TileBackPreview } from './Tile';
import { AvatarPlate } from './Avatars';
import { PackEmote } from './EmotePacks';
import { WinCelebration } from './Celebrations';
import { NATIVE } from './table/Motion';

/** What the card offers for a look, handed to the preview unchanged. */
export interface LookOffer {
  owned: boolean;
  /** The look is on (the table theme, or the item in its slot). */
  inUse: boolean;
  /** The diamond price on the buy button (a set's drops with what is owned). */
  price: number;
  busy: boolean;
  /** A line under the description (what a set already holds). */
  note?: string;
  /** The card's buy: spend diamonds on the look. */
  onBuy?: () => void;
  /** The card's Equip, for an owned look (not a set). */
  onEquip?: () => void;
}

const HAND = ['2m', '3m', '4m', '5p', '6p', '7p', '3s', '4s', '5s', 'E'];
const PONDS = [
  ['9m', '1p', 'N', '8s', 'W', '2s'],
  ['1m', 'B', '7m', '9p', 'F', '6s'],
];
/** The felt's rail and the margins FeltFrame keeps inside it (TableParts.tsx). */
const RAIL = 8;
const IN_X = RAIL + 3;
const IN_TOP = RAIL + 3;
const IN_BOTTOM = RAIL + 7;

/** A felt of the given size in a table look, children laid out inside it. */
function Felt({ theme, w, h, children }: { theme: TableTheme; w: number; h: number; children: React.ReactNode }) {
  return (
    <TableThemeContext.Provider value={theme}>
      <View testID={`preview-felt-${theme.id}`} style={{ width: w, height: h }}>
        <FeltFrame rail={RAIL}>
          <View style={styles.feltInner}>{children}</View>
        </FeltFrame>
      </View>
    </TableThemeContext.Provider>
  );
}

function BackRow({ back, n, w, testID }: { back: TileBackDesign | null; n: number; w: number; testID: string }) {
  return (
    <View style={styles.row}>
      {Array.from({ length: n }, (_, i) => (
        <View key={i} testID={testID}>
          <TileBackPreview back={back} w={w} />
        </View>
      ))}
    </View>
  );
}

/** A small table in a look: the other seats' backs, two ponds of discards and a hand. */
function TableStage({ theme, back, w, maxH, label }: { theme: TableTheme; back: TileBackDesign | null; w: number; maxH: number; label: string }) {
  const iw = w - IN_X * 2;
  // The hand tile's width: ten across the felt, and the whole table within the height it has.
  const tw = Math.max(12, Math.min(30, Math.floor((iw - 18) / 10), Math.floor((maxH - IN_TOP - IN_BOTTOM - 14) / 4.3)));
  const bw = Math.round(tw * 0.7);
  const pw = Math.round(tw * 0.72);
  const h = IN_TOP + IN_BOTTOM + Math.round(bw * 1.36) + 2 * Math.round(pw * 1.4) + 2 + Math.round(tw * 1.4) + 14;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID="preview-stage">
      <Felt theme={theme} w={w} h={h}>
        <BackRow back={back} n={Math.min(10, Math.floor((iw - 4) / (bw + 2)))} w={bw} testID={`preview-back-${back?.id ?? 'table'}`} />
        <View style={[styles.row, { gap: Math.max(6, tw) }]}>
          {PONDS.map((pond, i) => (
            <View key={i} testID="preview-pond" style={[styles.row, { width: pw * 3 + 4, flexWrap: 'wrap', rowGap: 2 }]}>
              {pond.map((code) => (
                <Tile key={code} kind={kindFromCode(code)} size={pw} />
              ))}
            </View>
          ))}
        </View>
        <View style={styles.row}>
          {HAND.map((code) => (
            <Tile key={code} kind={kindFromCode(code)} size={tw} />
          ))}
        </View>
      </Felt>
    </View>
  );
}

/** A tile back as at the table: a hand of backs standing, and the wall's two-high stacks in front of it. */
function BackStage({ back, w, maxH, label }: { back: TileBackDesign | null; w: number; maxH: number; label: string }) {
  const theme = useTableTheme();
  const iw = w - IN_X * 2;
  const bw = Math.max(14, Math.min(34, Math.floor((iw - 18) / 9), Math.floor((maxH - IN_TOP - IN_BOTTOM - 12) / (1.36 * 2.6))));
  const sw = Math.round(bw * 0.8);
  const h = IN_TOP + IN_BOTTOM + Math.round(bw * 1.36) + Math.round(sw * 1.36) * 1.6 + 12;
  const n = Math.min(9, Math.floor((iw - 4) / (bw + 2)));
  const stacks = Math.min(11, Math.floor((iw - 4) / (sw + 1)));
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID="preview-stage">
      <Felt theme={theme} w={w} h={Math.round(h)}>
        <BackRow back={back} n={n} w={bw} testID={`preview-back-${back?.id ?? 'table'}`} />
        <View style={[styles.row, { gap: 1 }]}>
          {Array.from({ length: stacks }, (_, i) => (
            <View key={i} style={{ height: Math.round(sw * 1.36 * 1.6) }}>
              <View style={{ position: 'absolute', top: Math.round(sw * 0.6) }}>
                <TileBackPreview back={back} w={sw} />
              </View>
              <TileBackPreview back={back} w={sw} />
            </View>
          ))}
        </View>
      </Felt>
    </View>
  );
}

/** The table theme the player plays on now (a tile back, frame, emote or celebration is tried on it). */
function useTableTheme(): TableTheme {
  return React.useContext(TableThemeContext);
}

/** The player's avatar in a frame, at the size the Shop shows and at the size a seat shows at the table. */
function FrameStage({ avatar, frame, w, maxH, label }: { avatar: string; frame: string; w: number; maxH: number; label: string }) {
  const theme = useTableTheme();
  const big = Math.max(48, Math.min(104, maxH - IN_TOP - IN_BOTTOM - 26));
  const h = IN_TOP + IN_BOTTOM + big + 24;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID="preview-avatar">
      <Felt theme={theme} w={w} h={h}>
        <View testID={`preview-frame-${frame}`} style={[styles.row, { gap: space.lg, alignItems: 'flex-end' }]}>
          <AvatarPlate id={avatar} frame={frame} size={big} />
          <AvatarPlate id={avatar} frame={frame} size={44} />
        </View>
      </Felt>
    </View>
  );
}

/** The player's avatar with an emote bubble, as at the table; the emote pops in unless motion is reduced. */
function EmoteStage({ avatar, frame, playing, w, label }: { avatar: string; frame: string | null; playing: { id: string; n: number } | null; w: number; label: string }) {
  const theme = useTableTheme();
  const { t } = useT();
  const reduced = useReducedMotion();
  const pop = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!playing || reduced) return;
    pop.setValue(0.4);
    const run = Animated.spring(pop, { toValue: 1, friction: 5, tension: 160, useNativeDriver: NATIVE });
    run.start();
    return () => run.stop();
  }, [playing, reduced, pop]);
  const size = 64;
  const h = IN_TOP + IN_BOTTOM + size + 60;
  return (
    <View accessibilityLabel={label} testID="preview-stage">
      <Felt theme={theme} w={w} h={h}>
        <View style={{ width: size + 14, height: size + 14, marginTop: 44 }}>
          <AvatarPlate id={avatar} frame={frame} size={size} />
          {playing && (
            <Animated.View
              key={playing.n}
              testID="preview-emote-bubble"
              accessible
              accessibilityRole="image"
              accessibilityLabel={emoteName(playing.id, t)}
              style={[styles.bubble, { left: size * 0.62, top: -44 }, !reduced && { transform: [{ scale: pop }] }]}
            >
              <PackEmote id={playing.id} size={40} />
            </Animated.View>
          )}
        </View>
      </Felt>
    </View>
  );
}

/** A win celebration over the felt, played once per run (`run` remounts it). */
function CelebrationStage({ id, avatar, frame, run, w, maxH, label }: { id: CelebrationId; avatar: string; frame: string | null; run: number; w: number; maxH: number; label: string }) {
  const theme = useTableTheme();
  const h = Math.max(120, Math.min(200, maxH, Math.round(w * 0.6)));
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label} testID={`preview-celebration-${run}`}>
      <Felt theme={theme} w={w} h={h}>
        <AvatarPlate id={avatar} frame={frame} size={52} mood="win" />
      </Felt>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { margin: IN_X, marginBottom: IN_BOTTOM, overflow: 'hidden', borderRadius: 12 }]}>
        <WinCelebration key={run} id={id} width={w - IN_X * 2} height={h - IN_TOP - IN_BOTTOM} />
      </View>
    </View>
  );
}

export function LookPreview({
  product,
  offer,
  avatar,
  owns,
  message,
  onClose,
}: {
  /** The look shown; null hides the preview. */
  product: Product | null;
  offer: LookOffer | null;
  /** The player's own avatar id (profile). */
  avatar: string;
  /** Whether the player owns a catalogue product (a set's items are marked owned). */
  owns: (productId: string) => boolean;
  /** The Shop's last message (unlocked, not enough diamonds, failed), shown here while the preview is open. */
  message?: { text: string; tone: 'gold' | 'ok' | 'danger' } | null;
  onClose: () => void;
}) {
  const { t } = useT();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const equipped = useEquipped();
  const tableTheme = useTableTheme();
  const [playing, setPlaying] = useState<{ id: string; n: number } | null>(null);
  const [run, setRun] = useState(1);
  const productId = product?.id;
  // A fresh preview starts with no emote shown and the celebration on its first run.
  useEffect(() => {
    setPlaying(null);
    setRun(1);
  }, [productId]);
  // An emote shows for a while, as at the table, then the bubble goes.
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => setPlaying(null), 2600);
    return () => clearTimeout(id);
  }, [playing]);

  if (!product || !offer) return null;
  const text = productText(product, t);

  // Sheet size: the whole width on a phone (8 px from the edges at 320), at most 560; the height of the window less
  // a margin, with the picture and details scrolling between the fixed title and buy rows.
  const margin = width < 360 ? 8 : space.md;
  const sheetW = Math.min(560, width - margin * 2);
  const inner = sheetW - 2 * 6 - 2 * 12;
  const wide = width > height && height < 600;
  const stageW = wide ? Math.floor(inner * 0.55) : inner;
  const stageMaxH = wide ? height - margin * 2 - 150 : Math.min(260, Math.floor(height * 0.36));

  const first = product.contains ? productById(product.contains[0]) : product;
  const setBack = product.contains ? (product.contains.map((id) => tileBackById(id)).find(Boolean) ?? null) : null;
  const setFrame = product.contains?.find((id) => id.startsWith('frame.')) ?? null;
  const setEmotes = product.contains?.find((id) => id in EMOTE_PACKS) as keyof typeof EMOTE_PACKS | undefined;
  const ownBack = tileBackById(equipped.tileBack);
  const label = (kind: string) => t(`shop.preview.stage.${kind}`, { title: text.title });

  let stage: React.ReactNode = null;
  let extra: React.ReactNode = null;
  if (product.contains) {
    stage = <TableStage theme={themeById(first?.unlocks)} back={setBack} w={stageW} maxH={stageMaxH} label={label('bundle')} />;
    extra = (
      <View style={{ gap: 4 }}>
        <Text style={[styles.section, fontFor(t('shop.preview.inSet'), fonts.uiBold)]}>{t('shop.preview.inSet')}</Text>
        {product.contains.map((id) => {
          const item = productById(id);
          if (!item) return null;
          const name = productText(item, t).title;
          const have = owns(id);
          return (
            <Row key={id} gap={6} style={{ alignItems: 'center' }}>
              <Icon name={have ? 'check' : 'star'} size={18} color={have ? colors.cta : undefined} />
              <Text style={[styles.item, fontFor(name, fonts.body, '700')]}>{name}</Text>
              {have && <Text style={[styles.itemOwned, fontFor(t('shop.owned'), fonts.bodyBold)]}>{t('shop.owned')}</Text>}
            </Row>
          );
        })}
        {(setFrame || setEmotes) && (
          <Row gap={6} style={{ alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {setFrame && <AvatarPlate id={avatar} frame={setFrame} size={44} />}
            {setEmotes && EMOTE_PACKS[setEmotes].slice(0, 4).map((id) => <PackEmote key={id} id={id} size={30} />)}
          </Row>
        )}
      </View>
    );
  } else {
    switch (product.category) {
      case 'table':
        stage = <TableStage theme={themeById(product.unlocks)} back={ownBack} w={stageW} maxH={stageMaxH} label={label('table')} />;
        break;
      case 'tileback':
        stage = (
          <TableThemeContext.Provider value={tableTheme}>
            <BackStage back={tileBackById(product.id)} w={stageW} maxH={stageMaxH} label={label('tileback')} />
          </TableThemeContext.Provider>
        );
        break;
      case 'frame':
        stage = <FrameStage avatar={avatar} frame={product.id} w={stageW} maxH={stageMaxH} label={label('frame')} />;
        break;
      case 'emotes': {
        const ids = EMOTE_PACKS[product.id as keyof typeof EMOTE_PACKS] ?? [];
        stage = <EmoteStage avatar={avatar} frame={equipped.frame} playing={playing} w={stageW} label={label('emotes')} />;
        extra = (
          <View style={{ gap: 4 }}>
            <Text style={[styles.section, fontFor(t('shop.preview.tapEmote'), fonts.uiBold)]}>{t('shop.preview.tapEmote')}</Text>
            <View style={styles.emotes}>
              {ids.map((id) => {
                const name = emoteName(id, t);
                return (
                  <Pressable
                    key={id}
                    testID={`preview-play-${id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('shop.preview.play', { name })}
                    onPress={() => setPlaying((p) => ({ id, n: (p?.n ?? 0) + 1 }))}
                    style={({ pressed }) => [styles.emoteKey, playing?.id === id && styles.emoteKeyOn, pressed && { opacity: 0.8 }]}
                  >
                    <PackEmote id={id} size={34} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
        break;
      }
      case 'celebration': {
        const id = product.id as CelebrationId;
        stage = <CelebrationStage id={id} avatar={avatar} frame={equipped.frame} run={run} w={stageW} maxH={stageMaxH} label={t(`shop.preview.celebration.${id}`)} />;
        extra = reduced ? (
          <View testID="preview-celebration-still" style={styles.still}>
            <Icon name="star" size={20} />
            <Text style={[styles.stillText, fontFor(t(`shop.preview.celebration.${id}`), fonts.body, '700')]}>{t('shop.preview.stillNote', { description: t(`shop.preview.celebration.${id}`) })}</Text>
          </View>
        ) : (
          <Button small kind="secondary" icon="play" testID="preview-replay" title={t('shop.preview.replay')} onPress={() => setRun((n) => n + 1)} style={{ alignSelf: 'flex-start' }} />
        );
        break;
      }
    }
  }

  const details = (
    <View style={{ gap: space.sm, flex: wide ? 1 : undefined, minWidth: 0 }}>
      <Text style={[styles.desc, fontFor(text.description, fonts.body, '700')]}>{text.description}</Text>
      {offer.note && <Text style={[styles.desc, { color: colors.okText }]}>{offer.note}</Text>}
      {extra}
    </View>
  );

  const dialogLabel = t('shop.preview.dialog', { title: text.title });
  // One named modal dialog for screen readers. On the web the Modal itself is a dialog (react-native-web gives its
  // outer element role="dialog" and aria-modal), so it takes the name and the sheet is not a second dialog; on a
  // phone the sheet is the dialog. The scrim closes the preview on a tap but is hidden from screen readers and
  // the keyboard: the sheet's own close button is the one they reach.
  const web = Platform.OS === 'web';
  const sheetA11y = web ? {} : { role: 'dialog' as const, 'aria-modal': true, 'aria-label': dialogLabel, accessibilityViewIsModal: true };
  const modalA11y = (web ? { 'aria-label': dialogLabel } : {}) as object;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']} {...modalA11y}>
      <Pressable style={styles.scrim} onPress={onClose} aria-hidden focusable={false} tabIndex={-1} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden testID="preview-scrim" />
      <View style={[styles.wrap, { padding: margin }]} pointerEvents="box-none">
        <View {...sheetA11y} testID="look-preview" style={[styles.shell, { width: sheetW, maxHeight: height - margin * 2 }]}>
          {/* A Card's look, drawn here so the sheet can shrink to the window and scroll its middle. */}
          <View style={styles.sheet}>
            <View style={styles.head}>
              <Text accessibilityRole="header" testID="look-preview-title" style={[styles.title, fontFor(text.title, fonts.display)]}>
                {text.title}
              </Text>
              <IconButton icon="cross" kind="ghost" testID="preview-close" label={t('shop.preview.close')} onPress={onClose} />
            </View>
            <ScrollView style={styles.body} contentContainerStyle={[{ gap: space.sm }, wide && { flexDirection: 'row', alignItems: 'flex-start' }]}>
              {stage}
              {details}
            </ScrollView>
            {message && (
              <Live message={message.text} assertive={message.tone === 'danger'} testID="preview-message">
                <Text style={[styles.message, { color: message.tone === 'danger' ? colors.dangerText : message.tone === 'ok' ? colors.okText : colors.ink }]}>{message.text}</Text>
              </Live>
            )}
            <View style={styles.foot} testID="preview-foot">
              {offer.owned ? (
                <>
                  <Row gap={4} style={{ alignItems: 'center' }}>
                    <Icon name="check" size={20} color={colors.cta} />
                    <Text style={[styles.owned, fontFor(t('shop.owned'), fonts.display)]}>{t('shop.owned')}</Text>
                  </Row>
                  {offer.onEquip && <Button small kind={offer.inUse ? 'ghost' : 'secondary'} testID="preview-equip" title={offer.inUse ? t('shop.equipped') : t('shop.equip')} onPress={offer.onEquip} disabled={offer.inUse} />}
                </>
              ) : (
                offer.onBuy && (
                  <Button
                    small
                    icon="gem"
                    testID="preview-buy"
                    title={offer.busy ? '…' : t('shop.preview.buy', { n: offer.price.toLocaleString() })}
                    accessibilityLabel={t('shop.preview.buyLabel', { n: offer.price.toLocaleString() })}
                    onPress={offer.onBuy}
                    disabled={offer.busy}
                  />
                )
              )}
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,20,47,0.6)' },
  wrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  shell: { borderWidth: 3, borderColor: colors.ink, borderRadius: radius.lg, paddingBottom: 5, backgroundColor: colors.creamShelf, flexShrink: 1 },
  sheet: { backgroundColor: colors.cream, borderRadius: radius.lg - 3, padding: 12, gap: space.sm, flexShrink: 1, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { flex: 1, fontFamily: fonts.display, color: colors.ink, fontSize: 20, lineHeight: 25 },
  body: { flexGrow: 0, flexShrink: 1 },
  feltInner: { flex: 1, alignItems: 'center', justifyContent: 'space-evenly', gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  bubble: { position: 'absolute', backgroundColor: '#FFFFFF', borderRadius: 16, borderWidth: 2.5, borderColor: colors.ink, padding: 3 },
  desc: { color: colors.inkDim, fontSize: 13, lineHeight: 18 },
  section: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 14, lineHeight: 18 },
  item: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18 },
  itemOwned: { color: colors.okText, fontSize: 12, lineHeight: 16 },
  emotes: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  emoteKey: { width: 48, height: 48, borderRadius: 14, borderWidth: 2, borderColor: colors.ink, backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  emoteKeyOn: { backgroundColor: colors.gold },
  still: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 12, borderWidth: 2, borderColor: colors.ink, padding: 8 },
  stillText: { flex: 1, color: colors.ink, fontSize: 13, lineHeight: 18 },
  message: { fontFamily: fonts.bodyBold, fontSize: 13, lineHeight: 18 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: space.sm, flexWrap: 'wrap', minHeight: 44 },
  owned: { fontFamily: fonts.display, color: colors.okText, fontSize: 16 },
});
