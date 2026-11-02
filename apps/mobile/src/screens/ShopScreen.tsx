import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useApp } from '../app-state';
import { CLUB_PRODUCTS, COSMETICS, DIAMOND_PACKS, SUBSCRIPTIONS, VIP_CARDS, type Product } from '../monetisation/catalog';
import { buyWithDiamonds, coachTier, hasVip, ownsCosmetic, store, totalDiamonds } from '../monetisation/store';
import { colors, fonts, space } from '../theme';
import { themeById } from '../themes';
import { Button, Card, fontFor, GemCounter, H2, P, Pill, Row, ScreenHeader, StrokeText } from '../components/Ui';
import { Icon, type IconName } from '../components/Icons';
import { ClubhouseScene, GemPile, MedalScene, ThemeScene, VipCardScene } from '../components/Scenes';
import { AvatarLine } from '../components/Avatars';
import { Emote } from '../components/Emotes';

type Tab = 'diamonds' | 'looks' | 'coach' | 'vip' | 'club';

export function ShopScreen() {
  const app = useApp();
  const { width, height } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('diamonds');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const wallet = app.wallet;

  const buy = async (p: Product, via: 'money' | 'diamonds') => {
    setBusy(p.id);
    setMsg(null);
    try {
      const result = via === 'diamonds' ? buyWithDiamonds(wallet, p) : await store.purchase(p, wallet);
      if (!result.ok) setMsg(result.message ?? 'Purchase failed');
      else {
        app.setWallet(result.wallet);
        setMsg(`Unlocked ${p.title}`);
        if (p.kind === 'cosmetic' && p.unlocks && p.id.startsWith('theme.')) app.setSettings({ ...app.settings, tableTheme: p.unlocks });
      }
    } finally {
      setBusy(null);
    }
  };

  const tabs: Array<[Tab, string, IconName]> = [
    ['diamonds', 'Gems', 'gem'],
    ['looks', 'Looks', 'star'],
    ['coach', 'Coach', 'cap'],
    ['vip', 'VIP', 'crown'],
    ['club', 'Clubs', 'users'],
  ];
  const tier = coachTier(wallet);
  const pad = width >= 1000 ? 28 : space.lg;
  const inner = width - pad * 2;
  const cols = Math.max(2, Math.min(6, Math.floor(inner / 182)));
  const gap = 12;
  const cardW = Math.floor((inner - gap * (cols - 1)) / cols);
  const narrowTabs = width < 500;
  const shortScreen = height < 500;

  const grid = (items: React.ReactNode[]) => <View style={[styles.grid, { gap }]}>{items}</View>;

  return (
    <ScrollView contentContainerStyle={[styles.wrap, { padding: pad }]}>
      <ScreenHeader title="Shop" onBack={app.back} backTestID="back" right={<GemCounter amount={totalDiamonds(wallet)} onPress={() => setTab('diamonds')} />} />
      <View style={styles.trust}>
        <Icon name="shield" size={20} />
        <Text style={styles.trustText} numberOfLines={2}>
          Cosmetics, coaching and club capacity only. Nothing here changes the tiles you draw.
        </Text>
      </View>
      <View style={[styles.tabs, narrowTabs && { alignSelf: 'stretch', gap: 2 }]}>
        {tabs.map(([t, label, icon]) => {
          const on = tab === t;
          return (
            <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, on && styles.tabOn, narrowTabs && styles.tabNarrow]}>
              <Icon name={icon} size={narrowTabs ? 20 : 22} />
              <Text style={[styles.tabText, on && { color: colors.ink }, narrowTabs && { fontSize: 13 }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {msg && <Pill text={msg} tone="gold" icon="check" />}

      {tab === 'diamonds' &&
        grid(
          DIAMOND_PACKS.map((p, i) => (
            <ProductCard key={p.id} w={cardW} short={shortScreen} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} art={<GemPile tier={i} width="100%" height="100%" />} bg={['#E9DBFF', '#B79BFF']} amount={p.diamonds} />
          )),
        )}

      {tab === 'looks' &&
        grid(
          COSMETICS.map((p) => {
            const owned = p.unlocks ? ownsCosmetic(wallet, p.unlocks) : false;
            const art = p.id.startsWith('theme.') ? (
              <ThemeScene theme={themeById(p.unlocks)} width="100%" height="100%" />
            ) : p.id.startsWith('avatars.') ? (
              <View style={styles.center}>
                <AvatarLine ids={['tiger', 'bunny', 'pig', 'monkey']} size={Math.min(52, cardW / 3.4)} />
              </View>
            ) : (
              <View style={[styles.center, { flexDirection: 'row', gap: 4 }]}>
                <Emote id="lol" size={44} />
                <Emote id="love" size={44} />
                <Emote id="fire" size={44} />
              </View>
            );
            return <ProductCard key={p.id} w={cardW} p={p} owned={owned} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} art={art} bg={['#D5F7E3', '#8FE0B0']} />;
          }),
        )}

      {tab === 'coach' && (
        <>
          <Card style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <Icon name="cap" size={40} />
            <View style={{ flex: 1, gap: 4 }}>
              <H2>{tier === 'free' ? 'Coaching tiers' : `Coach ${tier[0].toUpperCase()}${tier.slice(1)} is active`}</H2>
              <P dim style={{ fontSize: 13, lineHeight: 18 }}>
                Free: coach at the table, daily puzzle, drills, lessons 1–3, 1 hand review and 1 Puzzle Rush per day, Beginner and Club bots.{'\n'}Gold: all lessons, unlimited Puzzle Rush, Pro bots, review history.{'\n'}Platinum: unlimited hand reviews, puzzle battles, luck dashboard.{'\n'}Diamond: move-by-move explanations, insights, club-table discounts.
              </P>
              {tier !== 'free' && <Pill text={`Renews ${new Date(wallet.subscription!.until).toLocaleDateString()}`} tone="ok" />}
            </View>
          </Card>
          {grid(SUBSCRIPTIONS.map((p) => <ProductCard key={p.id} w={cardW} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} art={<MedalScene tier={p.tier === 'platinum' ? 'platinum' : p.tier === 'diamond' ? 'diamond' : 'gold'} width="100%" height="100%" />} bg={['#FFF3C4', '#FFD36B']} />))}
        </>
      )}

      {tab === 'vip' && (
        <>
          <Card style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <Icon name="crown" size={40} />
            <View style={{ flex: 1, gap: 4 }}>
              <H2>{hasVip(wallet) ? 'VIP is active' : 'VIP cards'}</H2>
              <P dim style={{ fontSize: 13, lineHeight: 18 }}>
                Prepaid, no auto-renew. Every table look while active, an emote allowance, one extra club slot and one extra review per day. Days carry over when you upgrade.
              </P>
              {hasVip(wallet) && <Pill text={`Until ${new Date(wallet.vip!.until).toLocaleDateString()}`} tone="ok" />}
            </View>
          </Card>
          {grid(VIP_CARDS.map((p, i) => <ProductCard key={p.id} w={cardW} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} art={<VipCardScene tier={i === 0 ? 'bronze' : i === 1 ? 'silver' : 'gold'} width="100%" height="100%" />} bg={['#FFE6D1', '#FFB98A']} />))}
        </>
      )}

      {tab === 'club' && (
        <>
          <Card style={{ flexDirection: 'row', gap: space.md, alignItems: 'flex-start' }}>
            <Icon name="users" size={40} />
            <View style={{ flex: 1, gap: 4 }}>
              <H2>Club capacity</H2>
              <P dim style={{ fontSize: 13, lineHeight: 18 }}>
                Starter clubs are free: 30 members, 2 managers, one live table. Owners upgrade capacity with diamonds or a 30-day plan. Members never pay to play in a club.
              </P>
              {wallet.clubTier && <Pill text={`Club ${wallet.clubTier.capacity} until ${new Date(wallet.clubTier.until).toLocaleDateString()}`} tone="ok" />}
            </View>
          </Card>
          {grid(CLUB_PRODUCTS.map((p) => <ProductCard key={p.id} w={cardW} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} art={<ClubhouseScene width="100%" height="100%" />} bg={['#C9F1FF', '#83D6FF']} />))}
        </>
      )}
      <Text style={styles.foot}>
        Prices shown are placeholder USD tiers; your store shows local pricing at checkout. Subscriptions renew until cancelled in your store account settings. This build uses a mock store: purchases are instant and free.
      </Text>
    </ScrollView>
  );
}

function ProductCard({ p, owned, busy, onBuy, onBuyDiamonds, art, bg, w, amount, short }: { p: Product; owned?: boolean; busy: boolean; onBuy: () => void; onBuyDiamonds?: () => void; art: React.ReactNode; bg: readonly [string, string]; w: number; amount?: number; short?: boolean }) {
  const price = `$${p.priceUsd.toFixed(2)}${p.period ? `/${p.period === 'year' ? 'yr' : 'mo'}` : ''}`;
  return (
    <Card style={{ width: w, padding: 8, gap: 6 }}>
      <View style={[styles.window, short && { height: 68 }]}>
        <LinearGradient colors={bg} style={StyleSheet.absoluteFill} />
        <View style={styles.shine} />
        <View style={{ position: 'absolute', left: 4, right: 4, top: 4, bottom: 4 }}>{art}</View>
      </View>
      {p.badge && (
        <View style={styles.ribbon}>
          <Text style={styles.ribbonText}>{p.badge}</Text>
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
          <Text style={styles.title} numberOfLines={2}>
            {p.title}
          </Text>
        )}
        <Text style={[styles.sub, fontFor(amount !== undefined ? p.description : p.titleZh, fonts.body, '700'), amount !== undefined && { textAlign: 'center' }]} numberOfLines={2}>
          {amount !== undefined ? p.description : `${p.titleZh} · ${p.description}`}
        </Text>
      </View>
      {owned ? (
        <View style={styles.owned}>
          <Icon name="check" size={20} color={colors.cta} />
          <Text style={styles.ownedText}>Owned</Text>
        </View>
      ) : (
        <View style={{ gap: 6 }}>
          <Button small title={busy ? '…' : price} onPress={onBuy} disabled={busy} />
          {onBuyDiamonds && <Button small kind="secondary" icon="gem" title={String(p.diamondPrice)} onPress={onBuyDiamonds} disabled={busy} />}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  trust: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  trustText: { flex: 1, fontFamily: fonts.bodyBold, color: colors.ink, fontSize: 12 },
  tabs: { flexDirection: 'row', gap: 6, backgroundColor: 'rgba(16,20,47,0.55)', borderRadius: 18, borderWidth: 3, borderColor: colors.ink, padding: 4, alignSelf: 'flex-start', maxWidth: '100%' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
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
