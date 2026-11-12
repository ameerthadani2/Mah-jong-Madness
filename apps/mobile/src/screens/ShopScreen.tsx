import { track } from '../telemetry';
import React, { useEffect, useRef, useState } from 'react';
import { plansInOrder, shopTabFor, type ShopFocus, type ShopTab } from '../logic/shopFocus';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { BUNDLES, bundlePrice, COSMETIC_CATEGORIES, COSMETICS, DIAMOND_PACKS, productById, productText, SUBSCRIPTIONS, type CosmeticCategory, type Product } from '../monetisation/catalog';
import { EMOTE_PACKS, tileBackById, type CelebrationId } from '../monetisation/cosmetics';
import { slotOf } from '../monetisation/equipped';
import { setEquipped, useOwnedEquipped } from '../monetisation/useEquipped';
import { coachRenewal, coachTier, diamondsOwed, ownsProduct, totalDiamonds, type Wallet } from '../monetisation/wallet';
import { StoreError } from '../monetisation/providers';
import { shopStoreState } from '../monetisation/store-mode';
import { useRemoteConfig } from '../telemetry/RemoteConfig';
import { useWallet } from '../monetisation/useWallet';
import { ApiError } from '../api/http';
import { friendlyError } from '../logic/errors';
import { useT } from '../i18n';
import { Live } from '../components/Live';
import type { Translate } from '../logic/translate';
import { gateFor } from '../legal/age';
import { useAgeGate } from '../legal/useAgeGate';
import { colors, fonts, space } from '../theme';
import { themeById } from '../themes';
import { Button, Card, Chip, fontFor, GemCounter, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { GemPile, MedalScene, ThemeScene } from '../components/Scenes';
import { AvatarPlate } from '../components/Avatars';
import { PackEmote } from '../components/EmotePacks';
import { WinCelebration } from '../components/Celebrations';
import { TileBackPreview } from '../components/Tile';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { LegalLinks, NoValueNotice } from '../components/LegalLinks';

type Tab = ShopTab;

function shopError(e: unknown, t: Translate): string {
  if (e instanceof StoreError) return t(`shop.errors.${e.code}`);
  if (e instanceof ApiError) return friendlyError(e, t);
  return t('shop.purchaseFailed');
}

/** `focus` opens on the plans with that plan first and in view (club owners, a used Puzzle Rush or hand review arrive here). */
export function ShopScreen({ focus }: { focus?: ShopFocus } = {}) {
  const app = useApp();
  const gate = useAgeGate();
  const { t } = useT();
  const { width, height } = useWindowDimensions();
  const shop = useWallet();
  const [tab, setTab] = useState<Tab>(shopTabFor(focus));
  // Sent here for a plan: bring the plan cards into view once they are laid out (they start below the first screen).
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const scrolledToPlans = useRef(false);
  const showPlans = (y: number) => {
    if (!focus || scrolledToPlans.current) return;
    scrolledToPlans.current = true;
    scroller.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
  };
  const [shelf, setShelf] = useState<CosmeticCategory>('table');
  const equipped = useOwnedEquipped();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'gold' | 'ok' | 'danger' } | null>(null);
  const [offline, setOffline] = useState(false);
  const wallet = shop.wallet;
  const { refresh } = shop;
  const accountId = useAuth().user?.id;
  const storeState = shopStoreState(shop.storeKind, useRemoteConfig().config?.storeEnabled);

  useEffect(() => {
    void refresh().then((r) => setOffline(r === 'offline'));
  }, [refresh, accountId]);

  const gateState = gateFor('shop', gate.status, false);
  if (gate.loaded && gateState === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (gate.loaded && gateState === 'ask') return <AgeGate onBack={app.back} />;

  /** Put a cosmetic on: a table look becomes the table theme; anything else goes in its slot. */
  const wear = (p: Product, w: Wallet) => {
    if (p.category === 'table' && p.unlocks) app.setSettings({ ...app.settings, tableTheme: p.unlocks });
    const slot = slotOf(p.id);
    if (slot) setEquipped(slot, p.id, w);
  };

  const unlocked = (p: Product, w: Wallet = wallet) => {
    setMsg({ text: t('shop.unlocked', { title: productText(p, t).title }), tone: 'ok' });
    if (p.kind !== 'cosmetic') return;
    // A set puts on each of its items; a single item goes straight on.
    for (const id of p.contains ?? [p.id]) {
      const item = productById(id);
      if (item) wear(item, w);
    }
  };

  const buy = async (p: Product) => {
    if (storeState !== 'open') {
      setMsg({ text: t('shop.errors.store_unavailable'), tone: 'danger' });
      return;
    }
    setBusy(p.id);
    setMsg(null);
    try {
      track('purchase_start', { product: p.id });
      const r = await shop.buy(p);
      if (r.status === 'credited') {
        track('purchase_success', { product: p.id });
        unlocked(p);
      }
      else if (r.status === 'pending') setMsg({ text: t('shop.pending'), tone: 'gold' });
      else if (r.status === 'unavailable') setMsg({ text: t('shop.errors.store_unavailable'), tone: 'danger' });
      else if (r.status === 'failed') setMsg({ text: shopError(r.error, t), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const spend = async (p: Product) => {
    setBusy(p.id);
    setMsg(null);
    try {
      const r = await shop.spend(p);
      if (r.status === 'credited') unlocked(p, r.wallet);
      else if (r.status === 'need_diamonds') {
        setMsg({ text: t('shop.needDiamonds', { n: r.short }), tone: 'gold' });
      } else setMsg({ text: shopError(r.error, t), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setMsg(null);
    try {
      const r = await shop.restore();
      if (!r.ok) setMsg({ text: shopError(r.error, t), tone: 'danger' });
      // The store answered, but the game server could not check the purchases: say so instead of "restored".
      else if (r.serverSync === 'failed') setMsg({ text: t('shop.restoredUnchecked'), tone: 'gold' });
      else setMsg({ text: t('shop.restored'), tone: 'ok' });
    } finally {
      setBusy(null);
    }
  };

  /** The store's own price string, or why there is none. */
  const priceLabel = (p: Product): { label: string; sellable: boolean } => {
    if (storeState !== 'open') return { label: t('shop.notOnSale'), sellable: false };
    if (!shop.pricesLoaded) return { label: t('shop.priceLoading'), sellable: false };
    const price = shop.prices[p.id];
    if (!price) return { label: t('shop.notOnSale'), sellable: false };
    return { label: `${price}${p.period ? t(p.period === 'year' ? 'shop.perYear' : 'shop.perMonth') : ''}`, sellable: true };
  };

  const tabs: Array<[Tab, string, IconName]> = [
    ['diamonds', t('shop.tabs.diamonds'), 'gem'],
    ['looks', t('shop.tabs.looks'), 'star'],
    ['coach', t('shop.tabs.coach'), 'cap'],
  ];
  const tier = coachTier(wallet);
  const renewal = coachRenewal(wallet);
  const owed = diamondsOwed(wallet);
  const pad = width >= 1000 ? 28 : space.lg;
  const inner = width - pad * 2;
  const cols = Math.max(2, Math.min(6, Math.floor(inner / 182)));
  const gap = 12;
  const cardW = Math.floor((inner - gap * (cols - 1)) / cols);
  const narrowTabs = width < 500;
  const shortScreen = height < 500;

  const grid = (items: React.ReactNode[]) => <View style={[styles.grid, { gap }]}>{items}</View>;

  return (
    <ScrollView ref={scroller} contentContainerStyle={[styles.wrap, { padding: pad }]} testID="shop">
      <ScreenHeader title={t('shop.title')} onBack={app.back} backTestID="back" right={<GemCounter amount={totalDiamonds(wallet)} owed={owed} onPress={() => setTab('diamonds')} />} />
      <View style={styles.trust}>
        <Icon name="shield" size={20} />
        <Text style={styles.trustText} numberOfLines={2}>
          {t('shop.trust')}
        </Text>
      </View>
      {storeState !== 'open' && (
        <Card tone="gold" testID="store-unavailable" style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <Icon name="lock" size={30} />
          <View style={{ flex: 1, gap: 2 }}>
            <H2>{t(storeState === 'server_off' ? 'shop.unavailable.serverTitle' : 'shop.unavailable.title')}</H2>
            <P dim style={{ fontSize: 13, lineHeight: 18 }}>
              {t(storeState === 'server_off' ? 'shop.unavailable.serverBody' : 'shop.unavailable.body')}
            </P>
          </View>
        </Card>
      )}
      {shop.storeKind === 'mock' && <Pill tone="premium" icon="warning" text={t('shop.mock')} />}
      {offline && <Pill icon="warning" text={t('shop.offline')} />}
      {owed > 0 && (
        <Card tone="gold" testID="diamonds-owed" style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <Icon name="gem" size={30} />
          <View style={{ flex: 1, gap: 2 }}>
            <H2>{t('shop.owed.title', { n: owed.toLocaleString() })}</H2>
            <P dim style={{ fontSize: 13, lineHeight: 18 }}>
              {t('shop.owed.body', { n: owed.toLocaleString() })}
            </P>
          </View>
        </Card>
      )}
      <View style={[styles.tabs, narrowTabs && { alignSelf: 'stretch', gap: 2 }]}>
        {tabs.map(([id, label, icon]) => {
          const on = tab === id;
          return (
            <Pressable key={id} testID={`shop-tab-${id}`} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => setTab(id)} style={[styles.tab, on && styles.tabOn, narrowTabs && styles.tabNarrow]}>
              <Icon name={icon} size={narrowTabs ? 20 : 22} />
              <Text style={[styles.tabText, fontFor(label, fonts.display), on && { color: colors.ink }, narrowTabs && { fontSize: 13 }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {msg && (
        <Live message={msg.text} assertive={msg.tone === 'danger'} testID="shop-message">
          <Pill wrap text={msg.text} tone={msg.tone} icon={msg.tone === 'ok' ? 'check' : 'warning'} />
        </Live>
      )}

      {tab === 'diamonds' && (
        <>
          {/* Ink on a cream strip, like the trust line: white on the sky was 2:1. */}
          <View style={styles.trust}>
            <Icon name="gem" size={22} />
            <Text style={[styles.trustText, fontFor(t('shop.diamondsUse'), fonts.bodyBold, '700')]}>{t('shop.diamondsUse')}</Text>
          </View>
          {grid(DIAMOND_PACKS.map((p, i) => <ProductCard key={p.id} w={cardW} short={shortScreen} p={p} price={priceLabel(p)} busy={busy === p.id} onBuy={() => void buy(p)} art={<GemPile tier={i} width="100%" height="100%" />} bg={['#E9DBFF', '#B79BFF']} amount={p.diamonds} />))}
        </>
      )}

      {tab === 'looks' && (
        <>
          <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
            {COSMETIC_CATEGORIES.map((c) => (
              <Chip key={c} label={t(`shop.shelves.${c}`)} selected={shelf === c} onPress={() => setShelf(c)} />
            ))}
          </Row>
          {grid(
            (shelf === 'bundle' ? BUNDLES : COSMETICS.filter((p) => p.category === shelf)).map((p) => {
              const owned = ownsProduct(wallet, p.id);
              const inUse = p.category === 'table' ? app.settings.tableTheme === p.unlocks : !!slotOf(p.id) && Object.values(equipped).includes(p.id);
              const price = p.contains ? bundlePrice(p, (id) => ownsProduct(wallet, id)) : (p.diamondPrice ?? 0);
              const have = p.contains ? p.contains.filter((id) => ownsProduct(wallet, id)).length : 0;
              return (
                <ProductCard
                  key={p.id}
                  w={cardW}
                  p={p}
                  owned={owned}
                  busy={busy === p.id}
                  onBuyDiamonds={p.diamondPrice ? () => void spend(p) : undefined}
                  diamondLabel={price}
                  note={have > 0 && !owned ? t('shop.bundleSaves', { owned: have, total: p.contains!.length }) : undefined}
                  onEquip={owned && !p.contains ? () => wear(p, wallet) : undefined}
                  inUse={inUse}
                  art={<CosmeticPreview p={p} avatar={app.profile.avatar} w={cardW - 16} />}
                  bg={['#D5F7E3', '#8FE0B0']}
                />
              );
            }),
          )}
        </>
      )}

      {tab === 'coach' && (
        <>
          {/* The plans first, the explanation under them: the cards and their prices are what the player came for. */}
          <View testID="shop-plans" onLayout={(e) => showPlans(e.nativeEvent.layout.y)}>
            {grid(plansInOrder(SUBSCRIPTIONS, focus).map((p) => <ProductCard key={p.id} w={cardW} p={p} price={priceLabel(p)} busy={busy === p.id} onBuy={() => void buy(p)} art={<MedalScene tier={p.tier === 'fourwinds' ? 'fourwinds' : 'gold'} width="100%" height="100%" />} bg={['#FFF3C4', '#FFD36B']} />))}
          </View>
          <Card style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <Icon name="cap" size={40} />
            <View style={{ flex: 1, gap: 4 }}>
              <H2>{tier === 'free' ? t('shop.coach.tiers') : t('shop.coach.active', { tier: t(`shop.tiers.${tier}`) })}</H2>
              <P dim style={{ fontSize: 13, lineHeight: 18 }}>
                {t('shop.coach.body')}
              </P>
              {tier !== 'free' && renewal !== null && <Pill text={t('shop.coach.renews', { date: new Date(renewal).toLocaleDateString() })} tone="ok" />}
            </View>
          </Card>
        </>
      )}

      <NoValueNotice />
      {storeState === 'open' && (
        <Button testID="restore-purchases" small kind="ghost" icon="check" title={busy === 'restore' ? t('shop.restoring') : t('shop.restore')} onPress={() => void restore()} disabled={busy !== null} style={{ alignSelf: 'flex-start' }} />
      )}
      <Text style={styles.foot}>{t('shop.foot')}</Text>
      <LegalLinks style={{ justifyContent: 'flex-start' }} />
    </ScrollView>
  );
}

/** The Shop picture of a cosmetic: the look itself, drawn the way the table will show it. */
function CosmeticPreview({ p, avatar, w }: { p: Product; avatar: string; w: number }) {
  const first = p.contains ? productById(p.contains[0]) : p;
  if (!first) return null;
  if (p.contains) {
    const back = p.contains.map((id) => tileBackById(id)).find(Boolean) ?? null;
    return (
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <View style={{ width: '62%', height: '100%' }}>
          <ThemeScene theme={themeById(first.unlocks)} width="100%" height="100%" />
        </View>
        {back && <TileBackPreview back={back} w={26} />}
      </View>
    );
  }
  switch (p.category) {
    case 'table':
      return <ThemeScene theme={themeById(p.unlocks)} width="100%" height="100%" />;
    case 'tileback':
      return (
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <TileBackPreview back={tileBackById(p.id)} w={34} />
          <TileBackPreview back={tileBackById(p.id)} w={34} />
        </View>
      );
    case 'frame':
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <AvatarPlate id={avatar} frame={p.id} size={64} />
        </View>
      );
    case 'emotes':
      return (
        <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', alignContent: 'center' }}>
          {(EMOTE_PACKS[p.id as keyof typeof EMOTE_PACKS] ?? []).map((id) => (
            <PackEmote key={id} id={id} size={28} />
          ))}
        </View>
      );
    case 'celebration':
      return <WinCelebration id={p.id as CelebrationId} width={Math.max(40, w - 8)} height={84} still />;
    default:
      return null;
  }
}

function ProductCard({
  p,
  price,
  owned,
  busy,
  onBuy,
  onBuyDiamonds,
  diamondLabel,
  note,
  onEquip,
  inUse,
  art,
  bg,
  w,
  amount,
  short,
}: {
  p: Product;
  /** For products sold for money: the store's price, or why there is none. */
  price?: { label: string; sellable: boolean };
  owned?: boolean;
  busy: boolean;
  onBuy?: () => void;
  onBuyDiamonds?: () => void;
  /** The diamond price shown on the buy button (a set's price drops with what is owned). */
  diamondLabel?: number;
  /** A line under the description (what a set already holds). */
  note?: string;
  /** For an owned cosmetic: put it on. */
  onEquip?: () => void;
  inUse?: boolean;
  art: React.ReactNode;
  bg: readonly [string, string];
  w: number;
  amount?: number;
  short?: boolean;
}) {
  const { t } = useT();
  const text = productText(p, t);
  const sub = amount !== undefined ? text.description : t('shop.productSub', { zh: p.titleZh, description: text.description });
  return (
    <Card style={{ width: w, padding: 8, gap: 6 }} testID={`product-${p.id}`}>
      <View style={[styles.window, short && { height: 68 }]}>
        <LinearGradient colors={bg} style={StyleSheet.absoluteFill} />
        <View style={styles.shine} />
        <View style={{ position: 'absolute', left: 4, right: 4, top: 4, bottom: 4 }}>{art}</View>
      </View>
      {text.badge && (
        <View style={styles.ribbon}>
          <Text style={[styles.ribbonText, fontFor(text.badge, fonts.display)]}>{text.badge}</Text>
        </View>
      )}
      <View style={{ paddingHorizontal: 4, gap: 2, flex: 1 }}>
        {amount !== undefined ? (
          <Row gap={4} style={{ justifyContent: 'center' }}>
            <Icon name="gem" size={24} />
            <StrokeText style={{ fontSize: 26 }} strokeWidth={2} drop={2}>
              {amount.toLocaleString()}
            </StrokeText>
          </Row>
        ) : (
          <Text style={[styles.title, fontFor(text.title, fonts.uiBold)]} numberOfLines={2}>
            {text.title}
          </Text>
        )}
        {/* A plan's line carries its billing terms, so it is never cut; other cards keep two lines. */}
        <Text style={[styles.sub, fontFor(sub, fonts.body, '700'), amount !== undefined && { textAlign: 'center' }]} numberOfLines={p.kind === 'subscription' ? undefined : 2}>
          {sub}
        </Text>
        {note && <Text style={[styles.sub, { color: colors.okText }]}>{note}</Text>}
      </View>
      {owned ? (
        <View style={{ gap: 4 }}>
          <View style={styles.owned}>
            <Icon name="check" size={20} color={colors.cta} />
            <Text style={[styles.ownedText, fontFor(t('shop.owned'), fonts.display)]}>{t('shop.owned')}</Text>
          </View>
          {onEquip && <Button small kind={inUse ? 'ghost' : 'secondary'} testID={`equip-${p.id}`} title={inUse ? t('shop.equipped') : t('shop.equip')} onPress={onEquip} disabled={inUse} />}
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          {price && onBuy && <Button small testID={`buy-${p.id}`} title={busy ? '…' : price.label} onPress={onBuy} disabled={busy || !price.sellable} />}
          {onBuyDiamonds && <Button small testID={`spend-${p.id}`} icon="gem" title={busy ? '…' : (diamondLabel ?? p.diamondPrice ?? 0).toLocaleString()} onPress={onBuyDiamonds} disabled={busy} />}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  trust: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  trustText: { flex: 1, fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 12 },
  tabs: { flexDirection: 'row', gap: 6, backgroundColor: 'rgba(16,20,47,0.55)', borderRadius: 18, borderWidth: 3, borderColor: colors.ink, padding: 4, alignSelf: 'flex-start', maxWidth: '100%' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, minHeight: 44 },
  tabNarrow: { flex: 1, flexDirection: 'column', gap: 0, paddingHorizontal: 2, paddingVertical: 4, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.ink, borderBottomWidth: 4, paddingVertical: 4 },
  tabText: { fontFamily: fonts.display, color: '#FFFFFF', fontSize: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch' },
  window: { height: 96, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, overflow: 'hidden' },
  shine: { position: 'absolute', top: -30, left: -16, width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(255,255,255,0.35)' },
  ribbon: { position: 'absolute', top: 2, right: 2, backgroundColor: colors.danger, borderWidth: 2, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, transform: [{ rotate: '6deg' }] },
  // Ink on the red ribbon (5.9:1); white was 3:1.
  ribbonText: { fontFamily: fonts.display, color: colors.ink, fontSize: 12 },
  title: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 15, lineHeight: 18 },
  sub: { color: colors.inkDim, fontSize: 11, lineHeight: 14 },
  owned: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8 },
  ownedText: { fontFamily: fonts.display, color: colors.okText, fontSize: 16 },
  foot: { fontFamily: fonts.body, color: colors.inkSoft, fontSize: 11, lineHeight: 15 },
});
