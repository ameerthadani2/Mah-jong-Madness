import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { BOT_SKILLS, RULE_PRESETS, rulesFromPreset, type BotSkill, type RuleSet } from '@mjm/engine';
import { useApp } from '../app-state';
import { clubErrorText, clubLink, clubListLine, clubMemberCount, clubsApi, httpBase, isMemberView, ownerRestricted, type ClubContext, type ClubListing, type ClubMember, type ClubTable } from '../api/clubs';
import { useAuth } from '../auth/AuthProvider';
import { APP_NAME, APP_SCHEMES, LINK_DOMAIN } from '../config';
import { createOnlineSession } from '../game/session';
import { friendlyError } from '../logic/errors';
import { clubTitleSize } from '../logic/titleFit';
import { messagesAfter, NO_MESSAGES, NOTICE_MS, shownError, type ScreenMessages } from '../logic/screenMessages';
import { botLabel, presetName, rulesSummary, sameRules } from '../logic/rules-text';
import type { Translate } from '../logic/translate';
import { canCreateClubs } from '../monetisation/wallet';
import { useRemoteConfig } from '../telemetry/RemoteConfig';
import { useT } from '../i18n';
import { colors, fonts, nameFont, space } from '../theme';
import { Button, Card, Chip, H2, P, Pill, Row, ScreenHeader, SectionLabel, Toggle } from '../components/Ui';
import { AvatarPlate } from '../components/Avatars';
import { Icon } from '../components/Icons';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { NoValueNotice } from '../components/LegalLinks';
import { ReportPlayerSheet } from '../components/ReportPlayerSheet';
import { RuleEditor } from '../components/RuleEditor';
import { SignInPrompt } from '../components/SignInPrompt';
import { Live } from '../components/Live';
import { NameRefusedNotice } from '../components/NameRefusedNotice';
import { SupportLink } from '../components/SupportLink';
import { acceptedName } from '../logic/profile';
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

/**
 * The screen's error and notice lines (src/logic/screenMessages.ts): what a background refresh reports never
 * wipes the answer to something the player pressed, and a success notice goes after a few seconds.
 */
function useScreenMessages(): [ScreenMessages, React.Dispatch<Parameters<typeof messagesAfter>[1]>] {
  const [messages, tell] = useReducer(messagesAfter, NO_MESSAGES);
  const { notice } = messages;
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => tell({ type: 'noticeExpired' }), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);
  return [messages, tell];
}

/** The error (spoken at once) and the notice (spoken politely) of a club screen, in that order. */
function MessageLines({ messages, errorTone = 'danger' }: { messages: ScreenMessages; errorTone?: 'danger' | 'gold' }) {
  const error = shownError(messages);
  return (
    <>
      {error && (
        <Live message={error} assertive testID="club-error">
          <Pill tone={errorTone} icon="warning" wrap text={error} />
        </Live>
      )}
      {messages.notice && (
        <Live message={messages.notice} testID="club-notice">
          <Pill tone="ok" icon="check" wrap text={messages.notice} />
        </Live>
      )}
    </>
  );
}

export function ClubsScreen() {
  const app = useApp();
  const auth = useAuth();
  const { t, locale } = useT();
  const ctx = useClubContext();
  const user = { userId: auth.user?.id ?? '', name: acceptedName(app.profile) || t('common.player'), avatar: app.profile.avatar };
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
  // Once the store is live, running a club comes with The Four Winds Club; joining is always free.
  const { config } = useRemoteConfig();
  const [planNeeded, setPlanNeeded] = useState(false);
  const mayCreate = !planNeeded && (config?.storeEnabled !== true || canCreateClubs(app.wallet));
  const [clubs, setClubs] = useState<ClubListing[] | null>(null);
  const [messages, tell] = useScreenMessages();
  const [loading, setLoading] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [presetId, setPresetId] = useState('taiwan-standard');
  const [approval, setApproval] = useState(false);

  const refresh = useCallback(async () => {
    if (connection !== 'ready' || !user.userId) return;
    setLoading(true);
    try {
      setClubs(await clubsApi.mine(ctx, user.userId));
      tell({ type: 'loaded' });
    } catch (e) {
      tell({ type: 'loadFailed', text: friendlyError(e, t) });
    } finally {
      setLoading(false);
    }
  }, [ctx, connection, user.userId, t, tell]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    tell({ type: 'actionStarted' });
    try {
      const club = await clubsApi.create(ctx, name, rulesFromPreset(presetId), { joinRequiresApproval: approval });
      setCreating(false);
      app.clubJoined('create');
      setName('');
      await refresh();
      app.go({ name: 'club', code: club.code });
    } catch (e) {
      // The server knows the plan better than this device: show the offer instead of an error.
      if ((e as { code?: unknown } | null)?.code === 'fourwinds_required') {
        setPlanNeeded(true);
        setCreating(false);
        return;
      }
      tell({ type: 'actionFailed', text: clubErrorText(e, t) });
    }
  };
  const join = async () => {
    tell({ type: 'actionStarted' });
    try {
      const r = await clubsApi.join(ctx, joinCode.trim().toUpperCase());
      setJoinCode('');
      app.clubJoined('join', r.status);
      await refresh();
      if (r.status === 'pending') tell({ type: 'actionDone', notice: t('clubs.join.requestSent') });
      else app.go({ name: 'club', code: r.club.code });
    } catch (e) {
      tell({ type: 'actionFailed', text: clubErrorText(e, t) });
      // A refusal can mean the list on screen is stale (a request turned down, a ban): read it again.
      void refresh();
    }
  };

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;

  // A banned account can do nothing here: one card says so, instead of forms that would each be refused.
  if (auth.banned) {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <ScreenHeader title={t('clubs.title')} onBack={app.back} />
        <Card tone="danger" testID="clubs-banned" style={{ gap: 8 }}>
          <Row>
            <Icon name="warning" size={24} />
            <P style={{ flex: 1, fontSize: 14, lineHeight: 20 }}>{t('settings.account.banned')}</P>
          </Row>
          <SupportLink reason="mistake" />
        </Card>
      </ScrollView>
    );
  }

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
          {connection === 'offline' && auth.error ? <Pill tone="gold" icon="warning" wrap text={friendlyError(auth.error, t)} /> : null}
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
      <NameRefusedNotice />
      <MessageLines messages={messages} errorTone="gold" />
      <View style={styles.cols}>
        <Card style={styles.col}>
          <H2>{t('clubs.join.title')}</H2>
          <TextInput value={joinCode} onChangeText={(v) => setJoinCode(v.toUpperCase())} autoCapitalize="characters" placeholder={t('clubs.join.placeholder')} placeholderTextColor="#9AA0BF" style={styles.codeInput} maxLength={8} />
          <Button kind="secondary" title={t('clubs.join.button')} onPress={() => void join()} disabled={joinCode.trim().length < 4} />
        </Card>
        <Card style={styles.col}>
          <H2>{t('clubs.create.title')}</H2>
          {!mayCreate ? (
            <View testID="club-fourwinds-offer" style={{ gap: 8 }}>
              <Row>
                <Icon name="crown" size={24} />
                <P style={{ flex: 1, fontSize: 14 }}>{t('clubs.create.fourWindsTitle')}</P>
              </Row>
              <P dim style={{ fontSize: 12, lineHeight: 17 }}>
                {t('clubs.create.fourWindsBody')}
              </P>
              <Button kind="premium" icon="crown" title={t('clubs.create.fourWindsButton')} onPress={() => app.go({ name: 'shop', focus: 'fourwinds' })} />
            </View>
          ) : !creating ? (
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
      {clubs === null && !messages.loadError && <Pill text={t('common.loading')} icon="hourglass" />}
      {clubs === null && messages.loadError && <Button testID="clubs-retry" kind="secondary" title={loading ? t('common.loading') : t('clubs.retry')} onPress={() => void refresh()} disabled={loading} style={{ alignSelf: 'flex-start' }} />}
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
                {/* A club this player has only asked to join comes as the public view: no rules or tables to show. */}
                {clubListLine(c, t)}
              </P>
            </View>
            {pending ? <Pill text={t('clubs.pending')} /> : <Pill text={roleName(me.role, t)} tone={me.role === 'owner' ? 'gold' : 'neutral'} />}
            {!pending && <Button small kind="secondary" title={t('clubs.open')} accessibilityLabel={t('clubs.openNamed', { name: c.name })} onPress={() => app.go({ name: 'club', code: c.code })} />}
          </Card>
        );
      })}
    </ScrollView>
  );
}

/** An owner action waiting for the "are you sure" answer. */
type Pending =
  | { kind: 'close'; table: ClubTable }
  | { kind: 'evict'; table: ClubTable; userId: string; name: string }
  | { kind: 'remove' | 'ban' | 'transfer'; userId: string; name: string }
  | { kind: 'rejectAll'; userIds: string[] }
  | { kind: 'leave' };

export function ClubScreen({ code, notice: linkNotice }: { code: string; /** Why a link to one of this club's tables could not be followed. */ notice?: string }) {
  const app = useApp();
  const auth = useAuth();
  const { t, locale } = useT();
  const ctx = useClubContext();
  const user = { userId: auth.user?.id ?? '', name: acceptedName(app.profile) || t('common.player'), avatar: app.profile.avatar };
  const [club, setClub] = useState<ClubListing | null>(null);
  const [messages, tell] = useScreenMessages();
  const error = shownError(messages);
  /** True once a refresh has turned the member's view into the public one: removed, banned, or the club passed on without them. */
  const [lostMembership, setLostMembership] = useState(false);
  const wasMember = useRef(false);
  /** A request to join sent from this screen is waiting for an owner or admin. */
  const [asked, setAsked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'tables' | 'standings' | 'members' | 'rules'>('tables');
  const [view, setView] = useState<StandingsView>('season');
  const [confirmSeason, setConfirmSeason] = useState(false);
  const [reporting, setReporting] = useState<ReportTarget | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  /** Rules for a variant table being set up (owners and admins), or null. */
  const [variant, setVariant] = useState<RuleSet | null>(null);
  /** House rules being edited in the rules tab, or null while nothing has changed. */
  const [draft, setDraft] = useState<RuleSet | null>(null);
  /** Bumped after a save so the editor takes the saved rules as its new baseline. */
  const [saves, setSaves] = useState(0);
  // A club reached from a notification or a link is gated like the Clubs list: no server call before 'ok'.
  const { entry } = useOnlineGuard();

  const userId = user.userId;
  const refresh = useCallback(async () => {
    try {
      const next = await clubsApi.get(ctx, code);
      const member = isMemberView(next, userId);
      if (wasMember.current && !member) setLostMembership(true);
      if (member) setLostMembership(false);
      wasMember.current = member;
      setClub(next);
      tell({ type: 'loaded' });
    } catch (e) {
      tell({ type: 'loadFailed', text: friendlyError(e, t) });
    }
  }, [ctx, code, t, tell, userId]);
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
  // Not a member (a shared link, a notification, or removed since): the server sends the public view, which has no
  // rules, settings, members or tables. One card with the way in, and none of the tabs that read them.
  if (!isMemberView(club, user.userId)) {
    const approval = club.joinRequiresApproval === true;
    const joinClub = async () => {
      setBusy(true);
      tell({ type: 'actionStarted' });
      try {
        const r = await clubsApi.join(ctx, club.code);
        app.clubJoined('join', r.status);
        if (r.status === 'pending') setAsked(true);
        else await refresh();
      } catch (e) {
        tell({ type: 'actionFailed', text: clubErrorText(e, t) });
      } finally {
        setBusy(false);
      }
    };
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <ScreenHeader title={club.name} titleSize={clubTitleSize(club.name)} titleLines={0} onBack={app.back} />
        <NameRefusedNotice />
        {linkNotice && !error && (
          <Live message={linkNotice} assertive testID="club-link-notice">
            <Pill tone="danger" icon="warning" wrap text={linkNotice} />
          </Live>
        )}
        {lostMembership && (
          <Live message={t('clubs.guest.removed')} assertive testID="club-removed">
            <Pill tone="gold" icon="warning" wrap text={t('clubs.guest.removed')} />
          </Live>
        )}
        <Card testID="club-join-card" style={{ gap: 10 }}>
          <Row style={{ flexWrap: 'wrap', rowGap: 6 }} gap={6}>
            <Pill text={t('clubs.code', { code: club.code })} tone="gold" size="sm" />
            <Pill text={t('clubs.memberCount', { count: clubMemberCount(club) })} icon="users" size="sm" />
          </Row>
          <P style={{ fontSize: 14, lineHeight: 20 }}>{t(approval ? 'clubs.guest.approvalBody' : 'clubs.guest.body')}</P>
          {asked ? (
            <Live message={t('clubs.guest.requested')} testID="club-join-asked">
              <Pill tone="ok" icon="check" wrap text={t('clubs.guest.requested')} />
            </Live>
          ) : (
            <Button testID="club-join" title={busy ? '…' : t(approval ? 'clubs.guest.ask' : 'clubs.guest.join')} accessibilityLabel={t(approval ? 'clubs.guest.ask' : 'clubs.guest.join')} onPress={() => void joinClub()} disabled={busy} style={{ alignSelf: 'flex-start' }} />
          )}
          <MessageLines messages={messages} />
        </Card>
      </ScrollView>
    );
  }
  const members = club.members ?? [];
  const pendingList = club.pending ?? [];
  const bans = club.bans ?? [];
  const me = members.find((m) => m.userId === user.userId);
  const isOwner = me?.role === 'owner';
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canOpen = !!me && (isAdmin || club.settings.membersCanOpenTables);
  const roleOf = (userId: string) => members.find((m) => m.userId === userId)?.role;
  /** Whether I may remove, ban or take this account off a table (the server checks the same). */
  const outranks = (userId: string) => {
    if (!isAdmin || userId === user.userId || userId === club.ownerId) return false;
    return isOwner || roleOf(userId) !== 'admin';
  };

  /** Run an owner action; a club in the reply replaces the one shown. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    tell({ type: 'actionStarted' });
    try {
      const next = await run();
      if (next && typeof next === 'object' && 'code' in next && 'name' in next) setClub(next as ClubListing);
      else await refresh();
      tell({ type: 'actionDone', notice: done });
      return true;
    } catch (e) {
      tell({ type: 'actionFailed', text: clubErrorText(e, t) });
      return false;
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const openTable = async (rules?: RuleSet) => {
    setBusy(true);
    // A refusal from the last try (the server allows one new table every few seconds) is not left standing over this one.
    tell({ type: 'actionStarted' });
    try {
      // The server opens a member's table under the house rules and the club's bots; only owners and admins send rules.
      const table = await clubsApi.openTable(ctx, club.code, { label: t('clubs.tableLabel', { name: user.name }), ...(rules ? { rules } : {}) });
      setVariant(null);
      await joinTable(table.code, table.rules);
    } catch (e) {
      tell({ type: 'actionFailed', text: clubErrorText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const joinTable = async (tableCode: string, rules: RuleSet = club.rules) => {
    setBusy(true);
    try {
      const session = await createOnlineSession({ signalUrl: app.signalUrl, name: user.name, avatar: user.avatar, userId: user.userId, rules, action: 'join', code: tableCode, clubCode: club.code, ...auth.tableAuth });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      tell({ type: 'actionFailed', text: clubErrorText(e, t) });
    } finally {
      setBusy(false);
    }
  };
  const saveRules = async () => {
    if (!draft) return;
    if (await act(() => clubsApi.update(ctx, club.code, { rules: draft }), t('clubs.ruleEditor.saved'))) {
      setDraft(null);
      setSaves((n) => n + 1);
    }
  };
  const share = () =>
    void Share.share({
      message: t('clubs.share.message', { name: club.name, app: t('common.appName', { name: APP_NAME }), code: club.code, link: clubLink(club.code, { scheme: APP_SCHEMES[0] ?? 'mahjongmania', domain: LINK_DOMAIN }) }),
    });

  const season = club.season ?? 1;
  const startSeason = async () => {
    setBusy(true);
    tell({ type: 'actionStarted' });
    try {
      await clubsApi.startSeason(ctx, club.code);
      const next = await clubsApi.get(ctx, club.code);
      setClub(next);
      setConfirmSeason(false);
      setView('season');
      tell({ type: 'actionDone', notice: t('clubs.season.started', { n: next.season ?? season + 1 }) });
    } catch (e) {
      tell({ type: 'actionFailed', text: friendlyError(e, t) });
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (p: Pending): string => {
    switch (p.kind) {
      case 'close':
        return t('clubs.tables.closeConfirm', { label: p.table.label });
      case 'evict':
        return t('clubs.tables.evictConfirm', { name: p.name });
      case 'remove':
        return t('clubs.members.removeConfirm', { name: p.name });
      case 'ban':
        return t('clubs.members.banConfirm', { name: p.name });
      case 'transfer':
        return t('clubs.members.transferConfirm', { name: p.name });
      case 'rejectAll':
        return t('clubs.tables.rejectAllConfirm', { n: p.userIds.length });
      case 'leave':
        return t('clubs.members.leaveConfirm', { name: club.name });
    }
  };
  const runPending = async (p: Pending) => {
    switch (p.kind) {
      case 'close':
        return void act(() => clubsApi.closeTable(ctx, club.code, p.table.code), t('clubs.tables.closed'));
      case 'evict':
        return void act(() => clubsApi.evict(ctx, club.code, p.table.code, p.userId), t('clubs.tables.evicted', { name: p.name }));
      case 'remove':
        return void act(() => clubsApi.remove(ctx, club.code, p.userId));
      case 'ban':
        return void act(() => clubsApi.ban(ctx, club.code, p.userId));
      case 'transfer':
        return void act(() => clubsApi.setRole(ctx, club.code, p.userId, 'owner'));
      case 'rejectAll':
        // Only the requests that were on screen when the button was pressed: one that arrived since stays.
        return void act(async () => (await clubsApi.rejectAll(ctx, club.code, p.userIds)).club, t('clubs.tables.rejectedAll'));
      case 'leave':
        if (await act(() => clubsApi.leave(ctx, club.code, user.userId))) app.back();
        return;
    }
  };
  const deleteClub = async () => {
    if (await act(() => clubsApi.deleteClub(ctx, club.code, deleteName))) app.back();
  };

  /** The "are you sure" card, shown right where the action was asked for. */
  const confirmHere = (match: (p: Pending) => boolean) =>
    pending && match(pending) ? (
      <Card tone="gold" style={{ gap: 8 }} testID="club-confirm">
        <P style={{ fontSize: 13, lineHeight: 18 }}>{confirmText(pending)}</P>
        <Row>
          <Button small kind="danger" title={busy ? '…' : t('clubs.members.confirm')} onPress={() => void runPending(pending)} disabled={busy} />
          <Button small kind="ghost" title={t('common.cancel')} onPress={() => setPending(null)} />
        </Row>
      </Card>
    ) : null;
  const aboutUser = (userId: string) => (p: Pending) => p.kind !== 'close' && p.kind !== 'evict' && p.kind !== 'leave' && p.kind !== 'rejectAll' && p.userId === userId;

  const live = (club.tables ?? []).filter((t) => t.status !== 'finished');
  const restricted = ownerRestricted(club);
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={club.name} titleSize={clubTitleSize(club.name)} titleLines={0} onBack={app.back} />
      {/* Under the title at full width, so a long name is never cut and no pill runs under the Share button. */}
      <Row gap={6} style={{ flexWrap: 'wrap', rowGap: 6 }}>
        <Pill text={t('clubs.code', { code: club.code })} tone="gold" size="sm" />
        <Pill text={t('clubs.memberCount', { count: members.length })} icon="users" size="sm" />
        <Pill text={roleName(me ? me.role : 'guest', t)} size="sm" />
        <Button small kind="secondary" icon="share" title={t('clubs.share.button')} onPress={share} testID="club-share" style={{ marginLeft: 'auto' }} />
      </Row>
      <NameRefusedNotice />
      {linkNotice && !error && (
        <Live message={linkNotice} assertive testID="club-link-notice">
          <Pill tone="danger" icon="warning" wrap text={linkNotice} />
        </Live>
      )}
      <MessageLines messages={messages} />
      {restricted && (
        <Card tone="gold" style={{ gap: 6 }}>
          <P style={{ fontSize: 13, lineHeight: 18 }}>{t('clubs.owner.restricted')}</P>
          {isOwner && <Button small kind="premium" icon="crown" title={t('clubs.owner.renew')} onPress={() => app.go({ name: 'shop', focus: 'fourwinds' })} style={{ alignSelf: 'flex-start' }} />}
        </Card>
      )}
      <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
        {(['tables', 'standings', 'members', 'rules'] as const).map((id) => (
          <Chip
            key={id}
            label={id === 'tables' ? t('clubs.tabs.tables', { n: live.length }) : id === 'members' ? t('clubs.tabs.members', { n: members.length }) : id === 'standings' ? t('clubs.tabs.standings') : t('clubs.tabs.rules')}
            selected={tab === id}
            onPress={() => {
              setTab(id);
              tell({ type: 'moved' });
            }}
          />
        ))}
      </Row>

      {tab === 'tables' && (
        <>
          {canOpen && (
            <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
              <Button title={busy ? t('clubs.tables.opening') : t('clubs.tables.open')} onPress={() => void openTable()} disabled={busy} />
              {isAdmin && !variant && <Button kind="secondary" title={t('clubs.tables.openVariant')} onPress={() => setVariant({ ...club.rules })} disabled={busy} />}
            </Row>
          )}
          {isAdmin && variant && (
            <Card style={{ gap: 8 }}>
              <H2>{t('clubs.tables.openVariant')}</H2>
              <P dim style={{ fontSize: 12, lineHeight: 17 }}>
                {t('clubs.tables.variantNote')}
              </P>
              <RuleEditor value={variant} onChange={setVariant} baseline={club.rules} />
              <P dim style={{ fontSize: 12 }}>
                {rulesSummary(variant, t, locale)}
              </P>
              <Row>
                <Button title={t('clubs.tables.openWithRules')} onPress={() => void openTable(variant)} disabled={busy} />
                <Button kind="ghost" title={t('common.cancel')} onPress={() => setVariant(null)} />
              </Row>
            </Card>
          )}
          {live.length === 0 && <Pill text={canOpen ? t('clubs.tables.noneCanOpen') : t('clubs.tables.none')} icon="play" />}
          {live.map((table) => {
            const humans = table.players.filter((p) => !p.isBot);
            return (
              <Card key={table.code} style={{ gap: 4 }}>
                <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 4 }}>
                  <H2>{table.label}</H2>
                  <Row gap={6}>
                    {table.variant && <Pill text={t('clubs.tables.variant')} tone="gold" size="sm" />}
                    <Pill text={table.status === 'open' ? t('clubs.tables.waiting') : t('clubs.tables.hand', { n: table.handNumber + 1 })} tone={table.status === 'open' ? 'ok' : 'gold'} />
                  </Row>
                </Row>
                <P dim style={{ fontSize: 12 }}>
                  {rulesSummary(table.rules, t, locale)}
                </P>
                <Row style={{ flexWrap: 'wrap' }}>
                  {table.players.map((p) => (
                    <Pill key={p.seat} icon={p.isBot ? 'bot' : undefined} text={p.connected ? p.name : t('clubs.tables.away', { name: p.name })} />
                  ))}
                  {humans.length < 4 && <Pill text={t('clubs.tables.seats', { n: 4 - humans.length })} tone="ok" />}
                </Row>
                <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
                  <Button small kind="secondary" title={busy ? '…' : t('clubs.tables.join')} onPress={() => void joinTable(table.code, table.rules)} disabled={busy || !me} />
                  {isAdmin && <Button small kind="danger" title={t('clubs.tables.close')} onPress={() => setPending({ kind: 'close', table })} disabled={busy} />}
                  {humans
                    .filter((p): p is typeof p & { userId: string } => !!p.userId && outranks(p.userId))
                    .map((p) => (
                      <Button key={p.seat} small kind="ghost" title={t('clubs.tables.evict', { name: p.name })} onPress={() => setPending({ kind: 'evict', table, userId: p.userId, name: p.name })} disabled={busy} />
                    ))}
                </Row>
                {confirmHere((p) => (p.kind === 'close' || p.kind === 'evict') && p.table.code === table.code)}
              </Card>
            );
          })}
          {pendingList.length > 0 && isAdmin && (
            <Card>
              <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 6 }}>
                <H2>{t('clubs.tables.pendingRequests')}</H2>
                {pendingList.length > 1 && (
                  <Button
                    small
                    kind="ghost"
                    testID="club-reject-all"
                    title={t('clubs.tables.rejectAll')}
                    onPress={() => setPending({ kind: 'rejectAll', userIds: pendingList.map((p) => p.userId) })}
                    disabled={busy}
                  />
                )}
              </Row>
              {confirmHere((p) => p.kind === 'rejectAll')}
              {pendingList.map((p) => (
                <Row key={p.userId} style={{ justifyContent: 'space-between', flexWrap: 'wrap', rowGap: 6 }}>
                  <Row>
                    <AvatarPlate id={p.avatar} size={34} />
                    <P>{p.name}</P>
                  </Row>
                  <Row gap={6}>
                    <Button small title={t('clubs.tables.approve')} onPress={() => void act(() => clubsApi.approve(ctx, club.code, p.userId))} disabled={busy} />
                    <Button small kind="ghost" title={t('clubs.tables.reject')} onPress={() => void act(() => clubsApi.reject(ctx, club.code, p.userId))} disabled={busy} />
                    <Button small kind="ghost" title={t('clubs.tables.ban')} onPress={() => setPending({ kind: 'ban', userId: p.userId, name: p.name })} disabled={busy} />
                  </Row>
                  {confirmHere(aboutUser(p.userId))}
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

      {tab === 'members' && (
        <>
          <Card>
            {members.map((m) => (
              <View key={m.userId} style={styles.standing}>
                <Row>
                  <AvatarPlate id={m.avatar} size={34} />
                  <Text style={[{ color: colors.ink, flex: 1 }, nameFont(m.name)]}>{m.name}</Text>
                  <Pill text={roleName(m.role, t)} tone={m.role === 'owner' ? 'gold' : 'neutral'} size="sm" />
                </Row>
                {outranks(m.userId) && (
                  <Row style={{ flexWrap: 'wrap', rowGap: 6, marginTop: 4 }}>
                    {isOwner && m.role === 'member' && <Button small kind="secondary" title={t('clubs.members.makeAdmin')} onPress={() => void act(() => clubsApi.setRole(ctx, club.code, m.userId, 'admin'))} disabled={busy} />}
                    {isOwner && m.role === 'admin' && <Button small kind="secondary" title={t('clubs.members.makeMember')} onPress={() => void act(() => clubsApi.setRole(ctx, club.code, m.userId, 'member'))} disabled={busy} />}
                    {isOwner && <Button small kind="ghost" title={t('clubs.members.transfer')} onPress={() => setPending({ kind: 'transfer', userId: m.userId, name: m.name })} disabled={busy} />}
                    <Button small kind="ghost" title={t('clubs.members.remove')} onPress={() => setPending({ kind: 'remove', userId: m.userId, name: m.name })} disabled={busy} />
                    <Button small kind="danger" title={t('clubs.members.ban')} onPress={() => setPending({ kind: 'ban', userId: m.userId, name: m.name })} disabled={busy} />
                  </Row>
                )}
                {confirmHere(aboutUser(m.userId))}
              </View>
            ))}
          </Card>
          {isAdmin && (
            <Card>
              <H2>{t('clubs.members.bannedTitle')}</H2>
              {bans.length === 0 && <P dim style={{ fontSize: 12 }}>{t('clubs.members.noBans')}</P>}
              {bans.map((b) => (
                <Row key={b.userId} style={{ justifyContent: 'space-between' }}>
                  <P>{b.name}</P>
                  <Button small kind="ghost" title={t('clubs.members.unban')} onPress={() => void act(() => clubsApi.unban(ctx, club.code, b.userId))} disabled={busy} />
                </Row>
              ))}
            </Card>
          )}
          {me && (
            <Card style={{ gap: 8 }}>
              <H2>{t('clubs.members.danger')}</H2>
              {isOwner ? (
                <P dim style={{ fontSize: 12 }}>
                  {t('clubs.members.ownerLeave')}
                </P>
              ) : (
                <Button small kind="secondary" title={t('clubs.members.leave')} onPress={() => setPending({ kind: 'leave' })} disabled={busy} style={{ alignSelf: 'flex-start' }} />
              )}
              {confirmHere((p) => p.kind === 'leave')}
              {isOwner &&
                (deleting ? (
                  <Card tone="danger" style={{ gap: 8 }}>
                    <P style={{ fontSize: 13, lineHeight: 18 }}>{t('clubs.members.deleteBody')}</P>
                    <TextInput testID="club-delete-name" value={deleteName} onChangeText={setDeleteName} placeholder={t('clubs.members.deletePlaceholder')} placeholderTextColor="#9AA0BF" style={styles.input} maxLength={40} autoCorrect={false} />
                    <Row>
                      <Button small kind="danger" title={t('clubs.members.deleteConfirm')} onPress={() => void deleteClub()} disabled={busy || deleteName.trim().toLowerCase() !== club.name.trim().toLowerCase()} />
                      <Button small kind="ghost" title={t('common.cancel')} onPress={() => setDeleting(false)} />
                    </Row>
                  </Card>
                ) : (
                  <Button small kind="danger" title={t('clubs.members.delete')} onPress={() => setDeleting(true)} style={{ alignSelf: 'flex-start' }} />
                ))}
            </Card>
          )}
        </>
      )}

      {tab === 'rules' && (
        <Card style={{ gap: 8 }}>
          <P>{rulesSummary(draft ?? club.rules, t, locale)}</P>
          <P dim style={{ fontSize: 12 }}>
            {t('clubs.rules.houseNote')}
          </P>
          {isAdmin ? (
            <>
              <Toggle label={t('clubs.rules.membersCanOpen')} value={club.settings.membersCanOpenTables} onChange={(v) => void act(() => clubsApi.update(ctx, club.code, { settings: { membersCanOpenTables: v } }))} />
              <Toggle label={t('clubs.rules.approveNew')} value={club.settings.joinRequiresApproval} onChange={(v) => void act(() => clubsApi.update(ctx, club.code, { settings: { joinRequiresApproval: v } }))} />
              <SectionLabel>{t('clubs.rules.botSkill')}</SectionLabel>
              <P dim style={{ fontSize: 12 }}>
                {t('clubs.rules.botSkillNote')}
              </P>
              <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
                {(Object.keys(BOT_SKILLS) as BotSkill[]).map((k) => (
                  <Chip key={k} label={botLabel(k, locale, true)} selected={(club.settings.botSkill ?? 'club') === k} onPress={() => void act(() => clubsApi.update(ctx, club.code, { settings: { botSkill: k } }))} />
                ))}
              </Row>
              <RuleEditor key={saves} value={draft ?? club.rules} baseline={club.rules} onChange={(r) => setDraft(sameRules(r, club.rules) ? null : r)} />
              {draft && (
                <Row style={{ flexWrap: 'wrap', rowGap: 6 }}>
                  <Pill text={t('clubs.ruleEditor.unsaved')} tone="gold" size="sm" />
                  <Button title={t('clubs.ruleEditor.save')} onPress={() => void saveRules()} disabled={busy} />
                  <Button kind="ghost" title={t('clubs.ruleEditor.undo')} onPress={() => setDraft(null)} />
                </Row>
              )}
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
