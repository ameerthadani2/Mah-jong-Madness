import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../app-state';
import { CLUB_PRODUCTS, COSMETICS, DIAMOND_PACKS, SUBSCRIPTIONS, VIP_CARDS, type Product } from '../monetisation/catalog';
import { buyWithDiamonds, coachTier, hasVip, ownsCosmetic, store, totalDiamonds } from '../monetisation/store';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Pill, Row } from '../components/Ui';

type Tab = 'diamonds' | 'looks' | 'coach' | 'vip' | 'club';

export function ShopScreen() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('looks');
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

  const tabs: Array<[Tab, string]> = [
    ['looks', 'Looks'],
    ['diamonds', 'Diamonds'],
    ['coach', 'Coach'],
    ['vip', 'VIP'],
    ['club', 'Clubs'],
  ];
  const tier = coachTier(wallet);

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Shop</H1>
        <Row>
          <Pill text={`💎 ${totalDiamonds(wallet)}`} tone="gold" />
          <Button testID="back" small kind="ghost" title="Back" onPress={app.back} />
        </Row>
      </Row>
      <P dim style={{ fontSize: 12 }}>
        Everything here is cosmetic, coaching or club capacity. Nothing in the shop can change the tiles you draw.
      </P>
      <Row>
        {tabs.map(([t, label]) => (
          <Text key={t} onPress={() => setTab(t)} style={[styles.chip, tab === t && styles.chipOn]}>
            {label}
          </Text>
        ))}
      </Row>
      {msg && <P style={{ color: colors.gold }}>{msg}</P>}

      {tab === 'diamonds' &&
        DIAMOND_PACKS.map((p) => (
          <ProductRow key={p.id} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} />
        ))}

      {tab === 'looks' &&
        COSMETICS.map((p) => {
          const owned = p.unlocks ? ownsCosmetic(wallet, p.unlocks) : false;
          return <ProductRow key={p.id} p={p} owned={owned} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} />;
        })}

      {tab === 'coach' && (
        <>
          <Card>
            <H2>{tier === 'free' ? 'Coaching tiers' : `Coach ${tier[0].toUpperCase()}${tier.slice(1)} is active`}</H2>
            <P dim style={{ fontSize: 13 }}>
              Free: coach at the table, daily puzzle, drills, lessons 1–3, 1 hand review and 1 Puzzle Rush per day, Beginner and Club bots.{'\n'}Gold: all lessons, unlimited Puzzle Rush, Pro bots, review history.{'\n'}Platinum: unlimited hand reviews, puzzle battles, luck dashboard.{'\n'}Diamond: move-by-move explanations, insights, club-table discounts.
            </P>
            {tier !== 'free' && <Pill text={`Renews ${new Date(wallet.subscription!.until).toLocaleDateString()}`} tone="ok" />}
          </Card>
          {SUBSCRIPTIONS.map((p) => (
            <ProductRow key={p.id} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} />
          ))}
        </>
      )}

      {tab === 'vip' && (
        <>
          <Card>
            <H2>{hasVip(wallet) ? 'VIP is active' : 'VIP cards'}</H2>
            <P dim style={{ fontSize: 13 }}>
              Prepaid, no auto-renew. Every table look while active, an emote allowance, one extra club slot and one extra review per day. Days carry over when you upgrade.
            </P>
            {hasVip(wallet) && <Pill text={`Until ${new Date(wallet.vip!.until).toLocaleDateString()}`} tone="ok" />}
          </Card>
          {VIP_CARDS.map((p) => (
            <ProductRow key={p.id} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} />
          ))}
        </>
      )}

      {tab === 'club' && (
        <>
          <Card>
            <H2>Club capacity</H2>
            <P dim style={{ fontSize: 13 }}>
              Starter clubs are free: 30 members, 2 managers, one live table. Owners upgrade capacity with diamonds or a 30-day plan. Members never pay to play in a club.
            </P>
            {wallet.clubTier && <Pill text={`Club ${wallet.clubTier.capacity} until ${new Date(wallet.clubTier.until).toLocaleDateString()}`} tone="ok" />}
          </Card>
          {CLUB_PRODUCTS.map((p) => (
            <ProductRow key={p.id} p={p} busy={busy === p.id} onBuy={() => void buy(p, 'money')} onBuyDiamonds={p.diamondPrice ? () => void buy(p, 'diamonds') : undefined} />
          ))}
        </>
      )}
      <P dim style={{ fontSize: 11 }}>
        Prices shown are placeholder USD tiers; your store shows local pricing at checkout. Subscriptions renew until cancelled in your store account settings. This build uses a mock store: purchases are instant and free.
      </P>
    </ScrollView>
  );
}

function ProductRow({ p, owned, busy, onBuy, onBuyDiamonds }: { p: Product; owned?: boolean; busy: boolean; onBuy: () => void; onBuyDiamonds?: () => void }) {
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
      <View style={{ flex: 1 }}>
        <Row>
          <Text style={styles.title}>{p.title}</Text>
          {p.badge && <Pill text={p.badge} tone="gold" />}
        </Row>
        <P dim style={{ fontSize: 12 }}>
          {p.titleZh} · {p.description}
        </P>
      </View>
      {owned ? (
        <Pill text="Owned" tone="ok" />
      ) : (
        <View style={{ gap: 6, alignItems: 'flex-end' }}>
          <Button small title={busy ? '…' : `$${p.priceUsd.toFixed(2)}${p.period ? `/${p.period === 'year' ? 'yr' : 'mo'}` : ''}`} onPress={onBuy} disabled={busy} />
          {onBuyDiamonds && <Button small kind="secondary" title={`💎 ${p.diamondPrice}`} onPress={onBuyDiamonds} disabled={busy} />}
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  title: { color: colors.ink, fontWeight: '900', fontSize: 15 },
  chip: { color: colors.text, backgroundColor: colors.panelStrong, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
  chipOn: { backgroundColor: colors.gold, borderColor: colors.goldDim, color: colors.ink },
});
