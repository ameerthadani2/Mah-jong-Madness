import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, withSpeed, type GameSpeed, type RuleSet } from '@mjm/engine';
import { useApp } from '../app-state';
import { clubsApi, httpBase, type Club, type ClubMember } from '../api/clubs';
import { createOnlineSession } from '../game/session';
import { friendlyError } from '../logic/errors';
import { presetName, rulesStakes, rulesSummary, speedLabel } from '../logic/rules-text';
import type { Translate } from '../logic/translate';
import { useT } from '../i18n';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, Chip, H2, P, Pill, Row, ScreenHeader, SectionLabel, Toggle } from '../components/Ui';
import { AvatarPlate } from '../components/Avatars';
import { Icon } from '../components/Icons';

const roleName = (role: ClubMember['role'] | 'guest', t: Translate) => t(`common.roles.${role}`);

export function ClubsScreen() {
  const app = useApp();
  const { t, locale } = useT();
  const base = httpBase(app.signalUrl);
  const user = { userId: app.profile.userId, name: app.profile.name || t('common.player'), avatar: app.profile.avatar, secret: app.profile.userSecret };
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('taiwan-standard');
  const [approval, setApproval] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setClubs(await clubsApi.mine(base, user.userId));
      setError(null);
    } catch (e) {
      setError(friendlyError(e, t));
    }
  }, [base, user.userId, t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    try {
      const club = await clubsApi.create(base, user, name, rulesFromPreset(presetId), { joinRequiresApproval: approval });
      setCreating(false);
      setName('');
      await refresh();
      app.go({ name: 'club', code: club.code });
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };
  const join = async () => {
    try {
      const r = await clubsApi.join(base, joinCode.trim().toUpperCase(), user);
      setJoinCode('');
      await refresh();
      if (r.status === 'pending') setError(t('clubs.join.requestSent'));
      else app.go({ name: 'club', code: r.club.code });
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('clubs.title')} onBack={app.back} right={<Button small kind="ghost" icon="play" title={t('clubs.quickTable')} onPress={() => app.go({ name: 'online' })} />} />
      <View style={styles.note}>
        <Icon name="users" size={22} />
        <P style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>{t('clubs.note')}</P>
      </View>
      {error && <Pill tone="gold" icon="warning" text={error} />}
      <View style={styles.cols}>
        <Card style={styles.col}>
          <H2>{t('clubs.join.title')}</H2>
          <TextInput value={joinCode} onChangeText={(v) => setJoinCode(v.toUpperCase())} autoCapitalize="characters" placeholder={t('clubs.join.placeholder')} placeholderTextColor="#9AA0BF" style={styles.codeInput} maxLength={8} />
          <Button kind="secondary" title={t('clubs.join.button')} onPress={() => void join()} disabled={joinCode.trim().length < 4} />
        </Card>
        <Card style={styles.col}>
          <H2>{t('clubs.create.title')}</H2>
          {!creating ? (
            <Button title={t('clubs.create.new')} onPress={() => setCreating(true)} />
          ) : (
            <>
              <TextInput value={name} onChangeText={setName} placeholder={t('clubs.create.namePlaceholder')} placeholderTextColor="#9AA0BF" style={styles.input} maxLength={40} />
              <P dim style={{ fontSize: 12 }}>
                {t('clubs.create.preset')}
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {RULE_PRESETS.map((p) => (
                  <Chip key={p.id} label={presetName(p, locale)} selected={presetId === p.id} onPress={() => setPresetId(p.id)} />
                ))}
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {rulesSummary(rulesFromPreset(presetId), t, locale)}
              </P>
              <Toggle label={t('clubs.create.approval')} value={approval} onChange={setApproval} />
              <Row>
                <Button title={t('clubs.create.button')} onPress={() => void create()} disabled={!name.trim()} />
                <Button kind="ghost" title={t('common.cancel')} onPress={() => setCreating(false)} />
              </Row>
            </>
          )}
        </Card>
      </View>
      <SectionLabel>{t('clubs.mine')}</SectionLabel>
      {clubs === null && !error && <Pill text={t('common.loading')} icon="hourglass" />}
      {clubs?.length === 0 && <Pill text={t('clubs.none')} icon="users" />}
      {clubs?.map((c) => {
        const me = c.members.find((m) => m.userId === user.userId);
        const pending = !me;
        return (
          <Card key={c.code} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={styles.clubBadge}>
              <Icon name="users" size={30} />
            </View>
            <View style={{ flex: 1 }}>
              <Row gap={6}>
                <Text style={[styles.clubName, nameFont(c.name)]}>{c.name}</Text>
                <Pill text={c.code} size="sm" />
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {t('clubs.summary', { members: c.members.length, tables: c.tables.filter((tb) => tb.status !== 'finished').length, stakes: rulesStakes(c.rules) })}
              </P>
            </View>
            {pending ? <Pill text={t('clubs.pending')} /> : <Pill text={roleName(me.role, t)} tone={me.role === 'owner' ? 'gold' : 'neutral'} />}
            {!pending && <Button small kind="secondary" title={t('clubs.open')} onPress={() => app.go({ name: 'club', code: c.code })} />}
          </Card>
        );
      })}
    </ScrollView>
  );
}

export function ClubScreen({ code }: { code: string }) {
  const app = useApp();
  const { t, locale } = useT();
  const base = httpBase(app.signalUrl);
  const user = { userId: app.profile.userId, name: app.profile.name || t('common.player'), avatar: app.profile.avatar, secret: app.profile.userSecret };
  const [club, setClub] = useState<Club | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'tables' | 'standings' | 'rules'>('tables');

  const refresh = useCallback(async () => {
    try {
      setClub(await clubsApi.get(base, code));
      setError(null);
    } catch (e) {
      setError(friendlyError(e, t));
    }
  }, [base, code, t]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!club) {
    return (
      <View style={styles.center}>
        <P>{error ?? t('clubs.loadingClub')}</P>
        <Button title={t('common.back')} onPress={app.back} />
      </View>
    );
  }
  const me = club.members.find((m) => m.userId === user.userId);
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canOpen = !!me && (isAdmin || club.settings.membersCanOpenTables);

  const openTable = async () => {
    setBusy(true);
    try {
      const table = await clubsApi.openTable(base, club.code, user, { label: t('clubs.tableLabel', { name: user.name }), botSkill: app.settings.botSkill });
      await joinTable(table.code);
    } catch (e) {
      setError(friendlyError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const joinTable = async (tableCode: string) => {
    setBusy(true);
    try {
      const session = await createOnlineSession({ signalUrl: app.signalUrl, name: user.name, avatar: user.avatar, userId: user.userId, rules: club.rules, action: 'join', code: tableCode, clubCode: club.code });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      setError(friendlyError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const setRules = async (rules: Partial<RuleSet>) => {
    try {
      setClub(await clubsApi.update(base, club.code, user, { rules }));
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };

  const live = club.tables.filter((t) => t.status !== 'finished');
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader
        title={club.name}
        onBack={app.back}
        sub={
          <Row gap={6} style={{ marginTop: 2 }}>
            <Pill text={t('clubs.code', { code: club.code })} tone="gold" size="sm" />
            <Pill text={t('clubs.members', { n: club.members.length })} icon="users" size="sm" />
            <Pill text={roleName(me ? me.role : 'guest', t)} size="sm" />
          </Row>
        }
      />
      {error && <Pill tone="danger" icon="warning" text={error} />}
      <Row>
        {(['tables', 'standings', 'rules'] as const).map((id) => (
          <Chip key={id} label={id === 'tables' ? t('clubs.tabs.tables', { n: live.length }) : id === 'standings' ? t('clubs.tabs.standings') : t('clubs.tabs.rules')} selected={tab === id} onPress={() => setTab(id)} />
        ))}
      </Row>

      {tab === 'tables' && (
        <>
          {canOpen && <Button title={busy ? t('clubs.tables.opening') : t('clubs.tables.open')} onPress={() => void openTable()} disabled={busy} />}
          {live.length === 0 && <Pill text={canOpen ? t('clubs.tables.noneCanOpen') : t('clubs.tables.none')} icon="play" />}
          {live.map((table) => (
            <Card key={table.code} style={{ gap: 4 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <H2>{table.label}</H2>
                <Pill text={table.status === 'open' ? t('clubs.tables.waiting') : t('clubs.tables.hand', { n: table.handNumber + 1 })} tone={table.status === 'open' ? 'ok' : 'gold'} />
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {rulesSummary(table.rules, t, locale)}
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {table.players.map((p) => (
                  <Pill key={p.seat} icon={p.isBot ? 'bot' : undefined} text={p.connected ? p.name : t('clubs.tables.away', { name: p.name })} />
                ))}
                {table.players.filter((p) => !p.isBot).length < 4 && <Pill text={t('clubs.tables.seats', { n: 4 - table.players.filter((p) => !p.isBot).length })} tone="ok" />}
              </Row>
              <Button small kind="secondary" title={busy ? '…' : t('clubs.tables.join')} onPress={() => void joinTable(table.code)} disabled={busy || !me} />
            </Card>
          ))}
          {club.pending.length > 0 && isAdmin && (
            <Card>
              <H2>{t('clubs.tables.pendingRequests')}</H2>
              {club.pending.map((p) => (
                <Row key={p.userId} style={{ justifyContent: 'space-between' }}>
                  <Row>
                    <AvatarPlate id={p.avatar} size={34} />
                    <P>{p.name}</P>
                  </Row>
                  <Button small title={t('clubs.tables.approve')} onPress={() => void clubsApi.approve(base, club.code, user, p.userId).then(setClub).catch((e: unknown) => setError(friendlyError(e, t)))} />
                </Row>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'standings' && (
        <Card>
          {[...club.members]
            .sort((a, b) => b.points - a.points)
            .map((m, i) => (
              <Row key={m.userId} style={styles.standing}>
                <View style={[styles.rankBadge, i === 0 && { backgroundColor: colors.gold }]}>
                  <Text style={styles.rank}>{i + 1}</Text>
                </View>
                <AvatarPlate id={m.avatar} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: colors.ink }, nameFont(m.name)]}>
                    {m.name} {m.role !== 'member' ? <Text style={{ color: colors.goldDim, fontSize: 11 }}>{roleName(m.role, t)}</Text> : null}
                  </Text>
                  <P dim style={{ fontSize: 12 }}>
                    {t('clubs.standing', { played: m.matchesPlayed, won: m.matchesWon })}
                  </P>
                </View>
                <Text style={{ color: m.points >= 0 ? colors.okText : colors.dangerText, fontFamily: fonts.display, fontSize: 18 }}>
                  {m.points >= 0 ? '+' : ''}
                  {m.points}
                </Text>
              </Row>
            ))}
        </Card>
      )}

      {tab === 'rules' && (
        <Card>
          <P>{rulesSummary(club.rules, t, locale)}</P>
          {isAdmin ? (
            <>
              <P dim style={{ fontSize: 12 }}>
                {t('clubs.rules.presets')}
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {RULE_PRESETS.map((p) => (
                  <Chip key={p.id} label={presetName(p, locale)} onPress={() => void setRules(rulesFromPreset(p.id))} />
                ))}
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {t('clubs.rules.speed')}
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {(Object.keys(SPEED_PRESETS) as GameSpeed[]).map((sp) => (
                  <Chip key={sp} label={t('clubs.rules.speedChip', { label: speedLabel(sp, locale), turn: SPEED_PRESETS[sp].turnSeconds })} selected={club.rules.speed === sp} onPress={() => void setRules(withSpeed(club.rules, sp))} />
                ))}
              </Row>
              <Toggle label={t('clubs.rules.membersCanOpen')} value={club.settings.membersCanOpenTables} onChange={(v) => void clubsApi.update(base, club.code, user, { settings: { membersCanOpenTables: v } }).then(setClub)} />
              <Toggle label={t('clubs.rules.approveNew')} value={club.settings.joinRequiresApproval} onChange={(v) => void clubsApi.update(base, club.code, user, { settings: { joinRequiresApproval: v } }).then(setClub)} />
              <Toggle label={t('clubs.rules.multipleWinners')} value={club.rules.multipleWinners} onChange={(v) => void setRules({ multipleWinners: v })} />
              <Toggle label={t('clubs.rules.passRule')} value={club.rules.passRule} onChange={(v) => void setRules({ passRule: v })} />
              <Toggle label={t('clubs.rules.allowChi')} value={club.rules.allowChi} onChange={(v) => void setRules({ allowChi: v })} />
            </>
          ) : (
            <P dim style={{ fontSize: 12 }}>
              {t('clubs.rules.adminOnly')}
            </P>
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  cols: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  col: { flexGrow: 1, flexBasis: '45%', minWidth: 240 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontFamily: fonts.uiBold },
  codeInput: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 24, letterSpacing: 5, fontFamily: fonts.display, textAlign: 'center' },
  clubName: { color: colors.ink, fontSize: 17 },
  clubBadge: { width: 52, height: 52, borderRadius: 16, backgroundColor: colors.info, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  standing: { paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: colors.creamDeep },
  rankBadge: { width: 28, height: 28, borderRadius: 14, borderWidth: 2.5, borderColor: colors.ink, backgroundColor: colors.creamDeep, alignItems: 'center', justifyContent: 'center' },
  rank: { color: colors.ink, fontFamily: fonts.display, fontSize: 14 },
});
