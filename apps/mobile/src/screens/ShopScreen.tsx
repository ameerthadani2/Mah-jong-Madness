import { track } from '../telemetry';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { COSMETICS, DIAMOND_PACKS, productText, SUBSCRIPTIONS, type Product } from '../monetisation/catalog';
import { coachRenewal, coachTier, ownsCosmetic, totalDiamonds } from '../monetisation/wallet';
import { StoreError } from '../monetisation/providers';
import { useWallet } from '../monetisation/useWallet';
import { ApiError } from '../api/http';
import { friendlyError } from '../logic/errors';
import { useT } from '../i18n';
import type { Translate } from '../logic/translate';
import { gateFor } from '../legal/age';
import { useAgeGate } from '../legal/useAgeGate';
import { colors, fonts, space } from '../theme';
import { themeById } from '../themes';
import { Button, Card, fontFor, GemCounter, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { GemPile, MedalScene, ThemeScene } from '../components/Scenes';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { LegalLinks, NoValueNotice } from '../components/LegalLinks';

type Tab = 'diamonds' | 'looks' | 'coach';

function shopError(e: unknown, t: Translate): string {
  if (e instanceof StoreError) return t(`shop.errors.${e.code}`);
  if (e instanceof ApiError) return friendlyError(e, t);
  return t('shop.purchaseFailed');
}

export function ShopScreen() {
  const app = useApp();
  const gate = useAgeGate();
  const { t } = useT();
  const { width, height } = useWindowDimensions();
  const shop = useWallet();
  const [tab, setTab] = useState<Tab>('diamonds');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'gold' | 'ok' | 'danger' } | null>(null);
  const [offline, setOffline] = useState(false);
  const wallet = shop.wallet;
  const { refresh } = shop;
  const accountId = useAuth().user?.id;

  useEffect(() => {
    void refresh().then((r) => setOffline(r === 'offline'));
  }, [refresh, accountId]);

  const gateState = gateFor('shop', gate.status, false);
  if (gate.loaded && gateState === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (gate.loaded && gateState === 'ask') return <AgeGate onBack={app.back} />;

  const unlocked = (p: Product) => {
    setMsg({ text: t('shop.unlocked', { title: productText(p, t).title }), tone: 'ok' });
    if (p.kind === 'cosmetic' && p.unlocks) app.setSettings({ ...app.settings, tableTheme: p.unlocks });
  };

  const buy = async (p: Product) => {
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
      if (r.status === 'credited') unlocked(p);
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
      setMsg(r.ok ? { text: t('shop.restored'), tone: 'ok' } : { text: shopError(r.error, t), tone: 'danger' });
    } finally {
      setBusy(null);
    }
  };

  /** The store's own price string, or why there is none. */
  const priceLabel = (p: Product): { label: string; sellable: boolean } => {
    if (shop.storeKind === 'unavailable') return { label: t('shop.notOnSale'), sellable: false };
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
  const pad = width >= 1000 ? 28 : space.lg;
  const inner = width - pad * 2;
  const cols = Math.max(2, Math.min(6, Math.floor(inner / 182)));
  const gap = 12;
  const cardW = Math.floor((inner - gap * (cols - 1)) / cols);
  const narrowTabs = width < 500;
  const shortScreen = height < 500;

  const grid = (items: React.ReactNode[]) => <View style={[styles.grid, { gap }]}>{items}</View>;

  return (
    <ScrollView contentContainerStyle={[styles.wrap, { padding: pad }]} testID="shop">
      <ScreenHeader title={t('shop.title')} onBack={app.back} backTestID="back" right={<GemCounter amount={totalDiamonds(wallet)} onPress={() => setTab('diamonds')} />} />
      <View style={styles.trust}>
        <Icon name="shield" size={20} />
        <Text style={styles.trustText} numberOfLines={2}>
          {t('shop.trust')}
        </Text>
      </View>
      {shop.storeKind === 'unavailable' && (
        <Card tone="gold" testID="store-unavailable" style={{ flexDirection: 'row', gap: space.md, alignItems: 'center' }}>
          <Icon name="lock" size={30} />
          <View style={{ flex: 1, gap: 2 }}>
            <H2>{t('shop.unavailable.title')}</H2>
            <P dim style={{ fontSize: 13, lineHeight: 18 }}>
              {t('shop.unavailable.body')}
            </P>
          </View>
        </Card>
      )}
      {shop.storeKind === 'mock' && <Pill tone="premium" icon="warning" text={t('shop.mock')} />}
      {offline && <Pill icon="warning" text={t('shop.offline')} />}
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
      {msg && <Pill text={msg.text} tone={msg.tone} icon={msg.tone === 'ok' ? 'check' : 'warning'} />}

      {tab === 'diamonds' && (
        <>
          <P style={styles.note}>{t('shop.diamondsUse')}</P>
          {grid(DIAMOND_PACKS.map((p, i) => <ProductCard key={p.id} w={cardW} short={shortScreen} p={p} price={priceLabel(p)} busy={busy === p.id} onBuy={() => void buy(p)} art={<GemPile tier={i} width="100%" height="100%" />} bg={['#E9DBFF', '#B79BFF']} amount={p.diamonds} />))}
        </>
      )}

      {tab === 'looks' &&
        grid(
          COSMETICS.map((p) => (
            <ProductCard
              key={p.id}
              w={cardW}
              p={p}
              owned={p.unlocks ? ownsCosmetic(wallet, p.unlocks) : false}
              busy={busy === p.id}
              onBuyDiamonds={p.diamondPrice ? () => void spend(p) : undefined}
              art={<ThemeScene theme={themeById(p.unlocks)} width="100%" height="100%" />}
              bg={['#D5F7E3', '#8FE0B0']}
            />
          )),
        )}

      {tab === 'coach' && (
        <>
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
          {grid(SUBSCRIPTIONS.map((p) => <ProductCard key={p.id} w={cardW} p={p} price={priceLabel(p)} busy={busy === p.id} onBuy={() => void buy(p)} art={<MedalScene tier={p.tier === 'fourwinds' ? 'fourwinds' : 'gold'} width="100%" height="100%" />} bg={['#FFF3C4', '#FFD36B']} />))}
        </>
      )}

      <NoValueNotice />
      {shop.storeKind !== 'unavailable' && (
        <Button testID="restore-purchases" small kind="ghost" icon="check" title={busy === 'restore' ? t('shop.restoring') : t('shop.restore')} onPress={() => void restore()} disabled={busy !== null} style={{ alignSelf: 'flex-start' }} />
      )}
      <Text style={styles.foot}>{t('shop.foot')}</Text>
      <LegalLinks style={{ justifyContent: 'flex-start' }} />
    </ScrollView>
  );
}

function ProductCard({
  p,
  price,
  owned,
  busy,
  onBuy,
  onBuyDiamonds,
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
        <Text style={[styles.sub, fontFor(sub, fonts.body, '700'), amount !== undefined && { textAlign: 'center' }]} numberOfLines={2}>
          {sub}
        </Text>
      </View>
      {owned ? (
        <View style={styles.owned}>
          <Icon name="check" size={20} color={colors.cta} />
          <Text style={[styles.ownedText, fontFor(t('shop.owned'), fonts.display)]}>{t('shop.owned')}</Text>
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          {price && onBuy && <Button small testID={`buy-${p.id}`} title={busy ? '…' : price.label} onPress={onBuy} disabled={busy || !price.sellable} />}
          {onBuyDiamonds && <Button small testID={`spend-${p.id}`} icon="gem" title={busy ? '…' : (p.diamondPrice ?? 0).toLocaleString()} onPress={onBuyDiamonds} disabled={busy} />}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  trust: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  trustText: { flex: 1, fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 12 },
  note: { color: '#FFFFFF', fontSize: 13, fontFamily: fonts.bodyBold },
  tabs: { flexDirection: 'row', gap: 6, backgroundColor: 'rgba(16,20,47,0.55)', borderRadius: 18, borderWidth: 3, borderColor: colors.ink, padding: 4, alignSelf: 'flex-start', maxWidth: '100%' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, minHeight: 44 },
  tabNarrow: { flex: 1, flexDirection: 'column', gap: 0, paddingHorizontal: 2, paddingVertical: 4, justifyContent: 'center' },
  tabOn: { backgroundColor: colors.gold, borderWidth: 2, borderColor: colors.ink, borderBottomWidth: 4, paddingVertical: 4 },
  tabText: { fontFamily: fonts.display, color: '#FFFFFF', fontSize: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch' },
  window: { height: 96, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, overflow: 'hidden' },
  shine: { position: 'absolute', top: -30, left: -16, width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(255,255,255,0.35)' },
  ribbon: { position: 'absolute', top: 2, right: 2, backgroundColor: colors.danger, borderWidth: 2, borderColor: colors.ink, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, transform: [{ rotate: '6deg' }] },
  ribbonText: { fontFamily: fonts.display, color: '#FFFFFF', fontSize: 12 },
  title: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 15, lineHeight: 18 },
  sub: { color: colors.inkDim, fontSize: 11, lineHeight: 14 },
  owned: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 8 },
  ownedText: { fontFamily: fonts.display, color: colors.okText, fontSize: 16 },
  foot: { fontFamily: fonts.body, color: colors.inkSoft, fontSize: 11, lineHeight: 15 },
});
