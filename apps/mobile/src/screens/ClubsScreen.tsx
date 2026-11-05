import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, withSpeed, type GameSpeed, type RuleSet } from '@mjm/engine';
import { useApp } from '../app-state';
import { clubsApi, httpBase, type Club, type ClubContext, type ClubMember } from '../api/clubs';
import { useAuth } from '../auth/AuthProvider';
import { createOnlineSession } from '../game/session';
import { friendlyError } from '../logic/errors';
import { presetName, rulesStakes, rulesSummary, speedLabel } from '../logic/rules-text';
import type { Translate } from '../logic/translate';
import { useT } from '../i18n';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, Chip, H2, P, Pill, Row, ScreenHeader, SectionLabel, Toggle } from '../components/Ui';
import { AvatarPlate } from '../components/Avatars';
import { Icon } from '../components/Icons';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { NoValueNotice } from '../components/LegalLinks';
import { ReportPlayerSheet } from '../components/ReportPlayerSheet';
import { SignInPrompt } from '../components/SignInPrompt';
import type { ReportTarget } from '../legal/reports';
import { canStartSeason, sortStandings, standingPoints, type StandingsView } from '../legal/standings';
import { useOnlineGuard } from '../legal/useOnlineGuard';

const roleName = (role: ClubMember['role'] | 'guest', t: Translate) => t(`common.roles.${role}`);

/** Club calls authenticated with the signed-in session. */
function useClubContext(): ClubContext {
  const app = useApp();
  const auth = useAuth();
  const base = httpBase(app.signalUrl);
  return useMemo(() => ({ base, auth: auth.client }), [base, auth.client]);
}

export function ClubsScreen() {
  const app = useApp();
  const auth = useAuth();
  const { t, locale } = useT();
  const ctx = useClubContext();
  const user = { userId: auth.user?.id ?? '', name: app.profile.name || t('common.player'), avatar: app.profile.avatar };
  // Clubs need the server: the guest account is made here the first time, never at launch.
  const [connection, setConnection] = useState<'checking' | 'ready' | 'offline'>('checking');
  const { ensure } = auth;
  const connect = useCallback(async () => {
    setConnection('checking');
    setConnection((await ensure()) ? 'ready' : 'offline');
  }, [ensure]);
  // Nothing reaches the server (no guest account is made) until the age gate has been passed (src/legal/online.ts).
  const { entry } = useOnlineGuard();
  const ageOk = entry === 'ok';
  useEffect(() => {
    if (ageOk) void connect();
  }, [connect, ageOk]);
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('taiwan-standard');
  const [approval, setApproval] = useState(false);

  const refresh = useCallback(async () => {
    if (connection !== 'ready' || !user.userId) return;
    try {
      setClubs(await clubsApi.mine(ctx, user.userId));
      setError(null);
    } catch (e) {
      setError(friendlyError(e, t));
    }
  }, [ctx, connection, user.userId, t]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    try {
      const club = await clubsApi.create(ctx, name, rulesFromPreset(presetId), { joinRequiresApproval: approval });
      setCreating(false);
      app.clubJoined('create');
      setName('');
      await refresh();
      app.go({ name: 'club', code: club.code });
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };
  const join = async () => {
    try {
      const r = await clubsApi.join(ctx, joinCode.trim().toUpperCase());
      setJoinCode('');
      app.clubJoined('join', r.status);
      await refresh();
      if (r.status === 'pending') setError(t('clubs.join.requestSent'));
      else app.go({ name: 'club', code: r.club.code });
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;

  if (connection !== 'ready') {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <ScreenHeader title={t('clubs.title')} onBack={app.back} />
        <Card>
          <Row>
            <Icon name="users" size={26} />
            <H2>{t('clubs.signIn.title')}</H2>
          </Row>
          <P dim style={{ fontSize: 13 }}>
            {t('clubs.signIn.body')}
          </P>
          {connection === 'offline' && auth.error ? <Pill tone="gold" icon="warning" text={friendlyError(auth.error, t)} /> : null}
          <Button title={connection === 'checking' ? t('clubs.signIn.connecting') : t('clubs.signIn.retry')} onPress={() => void connect()} disabled={connection === 'checking'} />
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('clubs.title')} onBack={app.back} right={<Button small kind="ghost" icon="play" title={t('clubs.quickTable')} onPress={() => app.go({ name: 'online' })} />} />
      <View style={styles.note}>
        <Icon name="users" size={22} />
        <P style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>{t('clubs.note')}</P>
      </View>
      <NoValueNotice />
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
        const me = (c.members ?? []).find((m) => m.userId === user.userId);
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
                {t('clubs.summary', { members: c.members?.length ?? c.memberCount ?? 0, tables: (c.tables ?? []).filter((tb) => tb.status !== 'finished').length, stakes: rulesStakes(c.rules) })}
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
  const auth = useAuth();
  const { t, locale } = useT();
  const ctx = useClubContext();
  const user = { userId: auth.user?.id ?? '', name: app.profile.name || t('common.player'), avatar: app.profile.avatar };
  const [club, setClub] = useState<Club | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'tables' | 'standings' | 'rules'>('tables');
  const [view, setView] = useState<StandingsView>('season');
  const [confirmSeason, setConfirmSeason] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  // A club reached from a notification or a link is gated like the Clubs list: no server call before 'ok'.
  const { entry } = useOnlineGuard();

  const refresh = useCallback(async () => {
    try {
      setClub(await clubsApi.get(ctx, code));
      setError(null);
    } catch (e) {
      setError(friendlyError(e, t));
    }
  }, [ctx, code, t]);
  useEffect(() => {
    if (entry !== 'ok') return;
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh, entry]);

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;
  if (!club) {
    return (
      <View style={styles.center}>
        <P>{error ?? t('clubs.loadingClub')}</P>
        <Button title={t('common.back')} onPress={app.back} />
      </View>
    );
  }
  const members = club.members ?? [];
  const pendingList = club.pending ?? [];
  const me = members.find((m) => m.userId === user.userId);
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canOpen = !!me && (isAdmin || club.settings.membersCanOpenTables);

  const openTable = async () => {
    setBusy(true);
    try {
      const table = await clubsApi.openTable(ctx, club.code, { label: t('clubs.tableLabel', { name: user.name }), botSkill: app.settings.botSkill });
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
      const session = await createOnlineSession({ signalUrl: app.signalUrl, name: user.name, avatar: user.avatar, userId: user.userId, rules: club.rules, action: 'join', code: tableCode, clubCode: club.code, ...auth.tableAuth });
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
      setClub(await clubsApi.update(ctx, club.code, { rules }));
    } catch (e) {
      setError(friendlyError(e, t));
    }
  };

  const season = club.season ?? 1;
  const startSeason = async () => {
    setBusy(true);
    try {
      await clubsApi.startSeason(ctx, club.code);
      const next = await clubsApi.get(ctx, club.code);
      setClub(next);
      setConfirmSeason(false);
      setView('season');
      setNotice(t('clubs.season.started', { n: next.season ?? season + 1 }));
    } catch (e) {
      setError(friendlyError(e, t));
    } finally {
      setBusy(false);
    }
  };

  const live = (club.tables ?? []).filter((t) => t.status !== 'finished');
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader
        title={club.name}
        onBack={app.back}
        sub={
          <Row gap={6} style={{ marginTop: 2 }}>
            <Pill text={t('clubs.code', { code: club.code })} tone="gold" size="sm" />
            <Pill text={t('clubs.members', { n: club.members?.length ?? club.memberCount ?? 0 })} icon="users" size="sm" />
            <Pill text={roleName(me ? me.role : 'guest', t)} size="sm" />
          </Row>
        }
      />
      {error && <Pill tone="danger" icon="warning" text={error} />}
      {notice && <Pill tone="ok" icon="check" text={notice} />}
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
          {pendingList.length > 0 && isAdmin && (
            <Card>
              <H2>{t('clubs.tables.pendingRequests')}</H2>
              {pendingList.map((p) => (
                <Row key={p.userId} style={{ justifyContent: 'space-between' }}>
                  <Row>
                    <AvatarPlate id={p.avatar} size={34} />
                    <P>{p.name}</P>
                  </Row>
                  <Button small title={t('clubs.tables.approve')} onPress={() => void clubsApi.approve(ctx, club.code, p.userId).then(setClub).catch((e: unknown) => setError(friendlyError(e, t)))} />
                </Row>
              ))}
            </Card>
          )}
        </>
      )}

      {tab === 'standings' && (
        <Card>
          <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
            <Chip label={t('clubs.season.current', { n: season })} selected={view === 'season'} onPress={() => setView('season')} />
            <Chip label={t('clubs.season.lifetime')} selected={view === 'lifetime'} onPress={() => setView('lifetime')} />
          </Row>
          <NoValueNotice />
          {sortStandings(members, view).map((m, i) => (
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
                <Text style={{ color: standingPoints(m, view) >= 0 ? colors.okText : colors.dangerText, fontFamily: fonts.display, fontSize: 18 }}>
                  {standingPoints(m, view) >= 0 ? '+' : ''}
                  {standingPoints(m, view)}
                </Text>
                {m.userId !== user.userId && <Button small kind="ghost" title={t('clubs.report')} onPress={() => setReporting({ userId: m.userId, name: m.name })} />}
              </Row>
            ))}
          {canStartSeason(me?.role) &&
            (confirmSeason ? (
              <Card tone="gold" style={{ gap: 8 }}>
                <P style={{ fontSize: 13, lineHeight: 18 }}>{t('clubs.season.confirmBody', { n: season + 1 })}</P>
                <Row>
                  <Button small testID="season-confirm" kind="danger" title={busy ? '…' : t('clubs.season.confirm', { n: season + 1 })} onPress={() => void startSeason()} disabled={busy} />
                  <Button small kind="ghost" title={t('common.cancel')} onPress={() => setConfirmSeason(false)} />
                </Row>
              </Card>
            ) : (
              <Button small testID="season-start" kind="secondary" title={t('clubs.season.start')} onPress={() => setConfirmSeason(true)} style={{ alignSelf: 'flex-start' }} />
            ))}
        </Card>
      )}
      <ReportPlayerSheet visible={reporting !== null} target={reporting} onClose={() => setReporting(null)} />

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
              <Toggle label={t('clubs.rules.membersCanOpen')} value={club.settings.membersCanOpenTables} onChange={(v) => void clubsApi.update(ctx, club.code, { settings: { membersCanOpenTables: v } }).then(setClub)} />
              <Toggle label={t('clubs.rules.approveNew')} value={club.settings.joinRequiresApproval} onChange={(v) => void clubsApi.update(ctx, club.code, { settings: { joinRequiresApproval: v } }).then(setClub)} />
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
