import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { BOT_SKILLS, DEFAULT_RULES, describeRules, RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, withSpeed, type BotSkill, type GameSpeed } from '@mjm/engine';
import { useApp } from '../app-state';
import { AVATARS } from '../storage';
import { TABLE_THEMES } from '../themes';
import { ownsCosmetic } from '../monetisation/store';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Row, Stepper, Toggle } from '../components/Ui';

export function SettingsScreen() {
  const app = useApp();
  const { settings, setSettings, profile, setProfile } = app;
  const rules = settings.rules;
  const setRule = <K extends keyof typeof rules>(k: K, v: (typeof rules)[K]) => setSettings({ ...settings, rules: { ...rules, [k]: v } });

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Settings</H1>
        <Button small kind="ghost" title="Done" onPress={app.back} />
      </Row>
      <Card>
        <H2>Profile</H2>
        <TextInput value={profile.name} onChangeText={(name) => setProfile({ ...profile, name })} placeholder="Name" placeholderTextColor={colors.textDim} style={styles.input} maxLength={24} />
        <Row style={{ flexWrap: 'wrap' }}>
          {AVATARS.map((a) => (
            <Text key={a} onPress={() => setProfile({ ...profile, avatar: a })} style={[styles.avatar, profile.avatar === a && styles.avatarOn]}>
              {a}
            </Text>
          ))}
        </Row>
      </Card>
      <Card>
        <H2>Table look</H2>
        <Row style={{ flexWrap: 'wrap' }}>
          {TABLE_THEMES.map((t) => {
            const locked = t.premium && !ownsCosmetic(app.wallet, t.id);
            return (
              <Text key={t.id} onPress={() => (locked ? app.go({ name: 'shop' }) : setSettings({ ...settings, tableTheme: t.id }))} style={[styles.chip, { backgroundColor: t.felt, color: t.accent, borderWidth: 2, borderColor: settings.tableTheme === t.id ? t.accent : 'transparent' }]}>
                {locked ? '🔒 ' : ''}
                {t.name}
              </Text>
            );
          })}
        </Row>
        <Row style={{ justifyContent: 'space-between' }}>
          <P dim style={{ fontSize: 12 }}>Locked looks are unlocked in the Shop.</P>
          <Button small kind="ghost" title="Open Shop" onPress={() => app.go({ name: 'shop' })} />
        </Row>
      </Card>
      <Card>
        <H2>Coach & bots</H2>
        <Toggle label="Show coach panel at the table" value={settings.coach} onChange={(coach) => setSettings({ ...settings, coach })} />
        <P dim style={{ fontSize: 12 }}>Bot strength</P>
        <Row style={{ flexWrap: 'wrap' }}>
          {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => (
            <Text key={k} onPress={() => setSettings({ ...settings, botSkill: k })} style={[styles.chip, settings.botSkill === k && styles.chipOn]}>
              {BOT_SKILLS[k].label} ({BOT_SKILLS[k].rating})
            </Text>
          ))}
        </Row>
        <P dim style={{ fontSize: 12 }}>{BOT_SKILLS[settings.botSkill].description}</P>
      </Card>
      <Card>
        <H2>House rules (台灣麻將)</H2>
        <P dim style={{ fontSize: 13 }}>{describeRules(rules)}</P>
        <P dim style={{ fontSize: 12 }}>Presets</P>
        <Row style={{ flexWrap: 'wrap' }}>
          {RULE_PRESETS.map((p) => (
            <Text key={p.id} onPress={() => setSettings({ ...settings, rules: rulesFromPreset(p.id) })} style={styles.chip}>
              {p.name}
            </Text>
          ))}
        </Row>
        <P dim style={{ fontSize: 12 }}>Speed (seconds per move + time bank per hand)</P>
        <Row style={{ flexWrap: 'wrap' }}>
          {(Object.keys(SPEED_PRESETS) as GameSpeed[]).map((sp) => (
            <Text key={sp} onPress={() => setSettings({ ...settings, rules: withSpeed(rules, sp) })} style={[styles.chip, rules.speed === sp && styles.chipOn]}>
              {SPEED_PRESETS[sp].label} {SPEED_PRESETS[sp].turnSeconds}s+{SPEED_PRESETS[sp].timeBankSeconds}s
            </Text>
          ))}
        </Row>
        <Stepper label="底 Base points" value={rules.basePoints} step={50} min={0} max={5000} onChange={(v) => setRule('basePoints', v)} />
        <Stepper label="台 Points per tai" value={rules.taiPoints} step={10} min={0} max={2000} onChange={(v) => setRule('taiPoints', v)} />
        <Stepper label="Max 台 (0 = none)" value={rules.maxTai} step={1} min={0} max={64} onChange={(v) => setRule('maxTai', v)} />
        <Stepper label="Dealer streak 台 per 連莊" value={rules.dealerStreakTai} step={1} min={0} max={4} onChange={(v) => setRule('dealerStreakTai', v)} />
        <Stepper label="Dealer rotations per match" value={rules.handsPerMatch} step={4} min={4} max={32} onChange={(v) => setRule('handsPerMatch', v)} format={(v) => `${v} (${v / 4} 圈)`} />
        <Stepper label="Seconds per move" value={rules.turnSeconds} step={1} min={3} max={60} onChange={(v) => setRule('turnSeconds', v)} />
        <Stepper label="Time bank per hand (s)" value={rules.timeBankSeconds} step={5} min={0} max={120} onChange={(v) => setRule('timeBankSeconds', v)} />
        <Stepper label="Dead wall (剩牌流局)" value={rules.deadWallSize} step={2} min={0} max={32} onChange={(v) => setRule('deadWallSize', v)} />
        <Toggle label="Allow chi (吃)" value={rules.allowChi} onChange={(v) => setRule('allowChi', v)} />
        <Toggle label="Draw keeps dealer (流局連莊)" value={rules.drawKeepsDealer} onChange={(v) => setRule('drawKeepsDealer', v)} />
        <Toggle label="Multiple winners on one discard (一炮多響)" value={rules.multipleWinners} onChange={(v) => setRule('multipleWinners', v)} />
        <Toggle label="過水 (pass on a win → no ron until next draw)" value={rules.passRule} onChange={(v) => setRule('passRule', v)} />
        <Toggle label="無花 1 台" value={rules.noFlowerTai} onChange={(v) => setRule('noFlowerTai', v)} />
        <Button small kind="ghost" title="Reset to defaults" onPress={() => setSettings({ ...settings, rules: DEFAULT_RULES })} />
      </Card>
      <Card>
        <H2>Network</H2>
        <P dim style={{ fontSize: 13 }}>
          Signaling server (WebSocket). Only used to exchange room codes and connection details; the game itself runs between the phones.
        </P>
        <TextInput value={settings.signalUrl} onChangeText={(signalUrl) => setSettings({ ...settings, signalUrl })} autoCapitalize="none" autoCorrect={false} style={styles.input} />
        <Toggle label="Prefer neutral server-hosted tables" value={settings.hostedTables} onChange={(hostedTables) => setSettings({ ...settings, hostedTables })} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  input: { backgroundColor: colors.panelStrong, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  avatar: { fontSize: 26, padding: 4, borderRadius: 8 },
  avatarOn: { backgroundColor: colors.gold },
  chip: { color: colors.text, backgroundColor: colors.panelStrong, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, fontSize: 12, fontWeight: '700', overflow: 'hidden' },
  chipOn: { backgroundColor: colors.gold, color: colors.ink },
});
