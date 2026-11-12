import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BOT_SKILLS, DEFAULT_RULES, RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, withSpeed, type BotSkill, type GameSpeed } from '@mjm/engine';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import type { Profile } from '../storage';
import { AccountCard } from './AccountCard';
import { LOCALE_NAMES, SUPPORTED_LOCALES, useT, type LocalePreference } from '../i18n';
import { botLabel, presetName, rulesSummary, speedLabel } from '../logic/rules-text';
import { localized } from '../logic/translate';
import { BUILD_SIGNAL_URL } from '../config';
import { AVATARS } from '../storage';
import { isNameRefused } from '../logic/profile';
import { TABLE_THEMES } from '../themes';
import { hasTier, ownsCosmetic } from '../monetisation/wallet';
import { COSMETICS, productText } from '../monetisation/catalog';
import { EMOTE_PACKS, frameById, tileBackById, type CelebrationId } from '../monetisation/cosmetics';
import { SLOT_ITEMS, type EquipSlot } from '../monetisation/equipped';
import { setEquipped, useOwnedEquipped } from '../monetisation/useEquipped';
import { TileBackPreview } from '../components/Tile';
import { PackEmote } from '../components/EmotePacks';
import { WinCelebration } from '../components/Celebrations';
import { colors, fonts, space } from '../theme';
import { Button, Card, Chip, fontFor, H2, P, Row, ScreenHeader, Stepper, Toggle } from '../components/Ui';
import { AvatarPlate, avatarName } from '../components/Avatars';
import { ThemeScene } from '../components/Scenes';
import { Icon } from '../components/Icons';
import { LegalLinks, NoValueNotice } from '../components/LegalLinks';
import { SoundSettings } from '../components/SoundSettings';
import { PrivacyToggles } from '../components/PrivacyToggles';
import { SupportLink } from '../components/SupportLink';
import { DisplaySettings } from '../components/DisplaySettings';

const SLOT_KEYS: Record<EquipSlot, string> = { tileBack: 'settings.looks.tileBack', frame: 'settings.looks.frame', emotes: 'settings.looks.emotes', celebration: 'settings.looks.celebration' };

/** A small picture of an equippable item (or of the default look when `id` is null). */
function SlotPreview({ slot, id, avatar }: { slot: EquipSlot; id: string | null; avatar: string }) {
  switch (slot) {
    case 'tileBack':
      return <TileBackPreview back={tileBackById(id)} w={30} />;
    case 'frame':
      return <AvatarPlate id={avatar} frame={frameById(id)?.id ?? null} size={40} />;
    case 'emotes':
      return id ? <PackEmote id={EMOTE_PACKS[id as keyof typeof EMOTE_PACKS][0]} size={36} /> : <Icon name="star" size={30} />;
    case 'celebration':
      return id ? (
        <View style={{ width: 72, height: 44 }}>
          <WinCelebration id={id as CelebrationId} width={72} height={44} still />
        </View>
      ) : (
        <Icon name="star" size={30} />
      );
  }
}

export function SettingsScreen() {
  const app = useApp();
  const equipped = useOwnedEquipped();
  const { settings, setSettings, profile } = app;
  const auth = useAuth();
  // Name and avatar stay local; when the device has a server session they are also sent with PATCH /api/me.
  const setProfile = (p: Profile) => {
    app.setProfile(p);
    if (p.name !== profile.name || p.avatar !== profile.avatar) auth.syncProfile(p.name, p.avatar);
  };
  const { t, locale } = useT();
  const nameRefused = isNameRefused(profile);
  const rules = settings.rules;
  const languages: Array<[LocalePreference, string]> = [['auto', t('settings.languageAuto')], ...SUPPORTED_LOCALES.map((l): [LocalePreference, string] => [l, LOCALE_NAMES[l]])];
  const setRule = <K extends keyof typeof rules>(k: K, v: (typeof rules)[K]) => setSettings({ ...settings, rules: { ...rules, [k]: v } });

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('settings.title')} onBack={app.back} right={<Button small kind="primary" icon="check" title={t('settings.done')} onPress={app.back} />} />
      <Card>
        <H2>{t('settings.profile')}</H2>
        <Row gap={12}>
          <AvatarPlate id={profile.avatar} size={56} frame={equipped.frame} />
          <TextInput
            testID="profile-name"
            value={profile.name}
            onChangeText={(name) => setProfile({ ...profile, name })}
            placeholder={t('settings.namePlaceholder')}
            placeholderTextColor="#9AA0BF"
            accessibilityLabel={nameRefused ? `${t('settings.namePlaceholder')}. ${t('settings.nameRefused.field')}` : t('settings.namePlaceholder')}
            style={[styles.input, { flex: 1 }, nameRefused && { borderColor: colors.dangerText }]}
            maxLength={24}
          />
        </Row>
        {nameRefused && (
          // The server refused this name (a guest sign-up's nameRefused, or PATCH /api/me 400 name_not_allowed).
          <View testID="profile-name-refused" accessibilityLiveRegion="polite">
            <P style={{ color: colors.dangerText, fontSize: 13 }}>{t('settings.nameRefused.field')}</P>
          </View>
        )}
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={8}>
          {AVATARS.map((a) => (
            <Pressable
              key={a}
              onPress={() => setProfile({ ...profile, avatar: a })}
              hitSlop={2}
              style={[styles.pick, profile.avatar === a && styles.pickOn]}
              accessibilityRole="button"
              accessibilityLabel={avatarName(a)}
              accessibilityState={{ selected: profile.avatar === a }}
            >
              <AvatarPlate id={a} size={42} />
            </Pressable>
          ))}
        </Row>
      </Card>
      <AccountCard />
      <SoundSettings />
      <PrivacyToggles />
      <DisplaySettings />
      <Card>
        <H2>{t('settings.language')}</H2>
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
          {languages.map(([id, label]) => (
            <Chip key={id} label={label} selected={settings.locale === id} onPress={() => setSettings({ ...settings, locale: id })} />
          ))}
        </Row>
      </Card>
      <Card>
        <H2>{t('settings.tableLook')}</H2>
        <Row style={{ flexWrap: 'wrap', rowGap: 10 }} gap={10}>
          {TABLE_THEMES.map((theme) => {
            const locked = theme.premium && !ownsCosmetic(app.wallet, theme.id);
            const on = settings.tableTheme === theme.id;
            const name = localized(locale, theme.name, theme.nameZh);
            return (
              <Pressable
                key={theme.id}
                onPress={() => (locked ? app.go({ name: 'shop' }) : setSettings({ ...settings, tableTheme: theme.id }))}
                style={[styles.theme, on && styles.themeOn]}
                accessibilityRole="button"
                accessibilityLabel={name}
                accessibilityState={{ selected: on, disabled: locked }}
              >
                <ThemeScene theme={theme} width={96} height={80} />
                <Row gap={4}>
                  {locked && <Icon name="lock" size={16} />}
                  <Text style={[styles.themeName, fontFor(name, fonts.uiBold)]} numberOfLines={1}>
                    {name}
                  </Text>
                </Row>
              </Pressable>
            );
          })}
        </Row>
        {(Object.keys(SLOT_ITEMS) as EquipSlot[]).map((slot) => {
          const owned = SLOT_ITEMS[slot].filter((id) => ownsCosmetic(app.wallet, id));
          return (
            <View key={slot} style={{ gap: 6 }} testID={`equip-${slot}`}>
              <P dim style={{ fontSize: 12 }}>{t(SLOT_KEYS[slot])}</P>
              <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={8}>
                {[null, ...owned].map((id) => {
                  const on = equipped[slot] === id;
                  const product = id ? COSMETICS.find((c) => c.id === id) : undefined;
                  const name = product ? productText(product, t).title : t('settings.looks.default');
                  return (
                    <Pressable
                      key={id ?? 'default'}
                      onPress={() => setEquipped(slot, id, app.wallet)}
                      style={[styles.slot, on && styles.themeOn]}
                      accessibilityRole="button"
                      accessibilityLabel={name}
                      accessibilityState={{ selected: on }}
                    >
                      <SlotPreview slot={slot} id={id} avatar={profile.avatar} />
                      <Text style={[styles.themeName, fontFor(name, fonts.uiBold)]} numberOfLines={1}>
                        {name}
                      </Text>
                    </Pressable>
                  );
                })}
              </Row>
              {owned.length === 0 && <P dim style={{ fontSize: 12 }}>{t('settings.looks.none')}</P>}
            </View>
          );
        })}
        <Row style={{ justifyContent: 'space-between' }}>
          <P dim style={{ fontSize: 12 }}>{t('settings.lockedLooks')}</P>
          <Button small kind="gold" title={t('settings.openShop')} onPress={() => app.go({ name: 'shop' })} />
        </Row>
      </Card>
      <Card>
        <H2>{t('settings.coachBots')}</H2>
        <Toggle label={t('settings.coachToggle')} value={settings.coach} onChange={(coach) => setSettings({ ...settings, coach })} />
        <P dim style={{ fontSize: 12 }}>{t('settings.botStrength')}</P>
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
          {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => {
            // Same lock as the Home screen: Pro bots come with Coach Gold.
            const locked = k === 'pro' && !hasTier(app.wallet, 'gold');
            return <Chip key={k} label={botLabel(k, locale)} selected={settings.botSkill === k} locked={locked} onPress={() => (locked ? app.go({ name: 'shop' }) : setSettings({ ...settings, botSkill: k }))} />;
          })}
        </Row>
        {/* What each tier does, as measured (docs/ARCHITECTURE.md, the bot tiers): no claim that one beats another. */}
        <P dim style={{ fontSize: 12 }}>{t(`settings.botAbout.${settings.botSkill}`)}</P>
      </Card>
      <Card>
        <H2>{t('settings.houseRules')}</H2>
        <P dim style={{ fontSize: 13 }}>{rulesSummary(rules, t, locale)}</P>
        <P dim style={{ fontSize: 12 }}>{t('settings.presets.title')}</P>
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
          {RULE_PRESETS.map((p) => (
            <Chip key={p.id} label={presetName(p, locale)} onPress={() => setSettings({ ...settings, rules: rulesFromPreset(p.id) })} />
          ))}
        </Row>
        <P dim style={{ fontSize: 12 }}>{t('settings.speed')}</P>
        <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
          {(Object.keys(SPEED_PRESETS) as GameSpeed[]).map((sp) => (
            <Chip key={sp} label={t('settings.speedChip', { label: speedLabel(sp, locale), turn: SPEED_PRESETS[sp].turnSeconds, bank: SPEED_PRESETS[sp].timeBankSeconds })} selected={rules.speed === sp} onPress={() => setSettings({ ...settings, rules: withSpeed(rules, sp) })} />
          ))}
        </Row>
        <Stepper label={t('settings.basePoints')} value={rules.basePoints} step={50} min={0} max={5000} onChange={(v) => setRule('basePoints', v)} />
        <Stepper label={t('settings.taiPoints')} value={rules.taiPoints} step={10} min={0} max={2000} onChange={(v) => setRule('taiPoints', v)} />
        <Stepper label={t('settings.maxTai')} value={rules.maxTai} step={1} min={0} max={64} onChange={(v) => setRule('maxTai', v)} />
        <Stepper label={t('settings.dealerStreakTai')} value={rules.dealerStreakTai} step={1} min={0} max={4} onChange={(v) => setRule('dealerStreakTai', v)} />
        <Stepper label={t('settings.handsPerMatch')} value={rules.handsPerMatch} step={4} min={4} max={32} onChange={(v) => setRule('handsPerMatch', v)} format={(v) => t('settings.handsFormat', { hands: v, rounds: v / 4 })} />
        <Stepper label={t('settings.turnSeconds')} value={rules.turnSeconds} step={1} min={3} max={60} onChange={(v) => setRule('turnSeconds', v)} />
        <Stepper label={t('settings.timeBank')} value={rules.timeBankSeconds} step={5} min={0} max={120} onChange={(v) => setRule('timeBankSeconds', v)} />
        <Stepper label={t('settings.deadWall')} value={rules.deadWallSize} step={2} min={0} max={32} onChange={(v) => setRule('deadWallSize', v)} />
        <Toggle label={t('settings.allowChi')} value={rules.allowChi} onChange={(v) => setRule('allowChi', v)} />
        <Toggle label={t('settings.drawKeepsDealer')} value={rules.drawKeepsDealer} onChange={(v) => setRule('drawKeepsDealer', v)} />
        <Toggle label={t('settings.multipleWinners')} value={rules.multipleWinners} onChange={(v) => setRule('multipleWinners', v)} />
        <Toggle label={t('settings.passRule')} value={rules.passRule} onChange={(v) => setRule('passRule', v)} />
        <Toggle label={t('settings.noFlowerTai')} value={rules.noFlowerTai} onChange={(v) => setRule('noFlowerTai', v)} />
        <Button small kind="ghost" title={t('settings.reset')} onPress={() => setSettings({ ...settings, rules: DEFAULT_RULES })} style={{ alignSelf: 'flex-start' }} />
      </Card>
      <Card testID="settings-legal">
        <H2>{t('settings.legal.title')}</H2>
        <P dim style={{ fontSize: 13 }}>
          {t('settings.legal.body')}
        </P>
        <LegalLinks style={{ justifyContent: 'flex-start' }} />
        <SupportLink />
        <NoValueNotice />
      </Card>
      {__DEV__ && (
        <Card>
          <H2>{t('settings.network.title')}</H2>
          <P dim style={{ fontSize: 13 }}>
            {t('settings.network.body', { url: BUILD_SIGNAL_URL })}
          </P>
          <TextInput value={settings.devSignalUrl ?? ''} onChangeText={(v) => setSettings({ ...settings, devSignalUrl: v })} placeholder={BUILD_SIGNAL_URL} placeholderTextColor="#9AA0BF" autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <P dim style={{ fontSize: 12 }}>{t('settings.network.using', { url: app.signalUrl })}</P>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontFamily: fonts.uiBold },
  pick: { borderRadius: 999, padding: 2, borderWidth: 3, borderColor: 'transparent' },
  pickOn: { borderColor: colors.gold, backgroundColor: colors.gold },
  theme: { alignItems: 'center', gap: 2, padding: 4, borderRadius: 16, borderWidth: 3, borderColor: 'transparent', width: 112 },
  themeOn: { borderColor: colors.ink, backgroundColor: colors.gold },
  themeName: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 12, maxWidth: 90 },
  slot: { alignItems: 'center', justifyContent: 'flex-end', gap: 4, padding: 4, borderRadius: 16, borderWidth: 3, borderColor: 'transparent', width: 96, minHeight: 84 },
});
