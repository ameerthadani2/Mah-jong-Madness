import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { describeRules, RULE_PRESETS, rulesFromPreset, SPEED_PRESETS, withSpeed, type GameSpeed, type RuleSet } from '@mjm/engine';
import { useApp } from '../app-state';
import { clubsApi, httpBase, type Club } from '../api/clubs';
import { createOnlineSession } from '../game/session';
import { colors, space } from '../theme';
import { Button, Card, H1, H2, P, Pill, Row, Toggle } from '../components/Ui';

export function ClubsScreen() {
  const app = useApp();
  const base = httpBase(app.settings.signalUrl);
  const user = { userId: app.profile.userId, name: app.profile.name || 'Player', avatar: app.profile.avatar };
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
      setError((e as Error).message);
    }
  }, [base, user.userId]);
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
      setError((e as Error).message);
    }
  };
  const join = async () => {
    try {
      const r = await clubsApi.join(base, joinCode.trim().toUpperCase(), user);
      setJoinCode('');
      await refresh();
      if (r.status === 'pending') setError('Request sent — an admin must approve you.');
      else app.go({ name: 'club', code: r.club.code });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <H1>Clubs</H1>
        <Row>
          <Button small kind="ghost" title="Quick table" onPress={() => app.go({ name: 'online' })} />
          <Button small kind="ghost" title="Back" onPress={app.back} />
        </Row>
      </Row>
      <P dim>A club is your private room: your rules, your members, your standings. Share the code and play from anywhere.</P>
      {error && <P style={{ color: colors.gold }}>{error}</P>}
      <View style={styles.cols}>
        <Card style={styles.col}>
          <H2>Join a club</H2>
          <TextInput value={joinCode} onChangeText={(t) => setJoinCode(t.toUpperCase())} autoCapitalize="characters" placeholder="CLUB CODE" placeholderTextColor={colors.textDim} style={styles.codeInput} maxLength={8} />
          <Button kind="secondary" title="Join" onPress={() => void join()} disabled={joinCode.trim().length < 4} />
        </Card>
        <Card style={styles.col}>
          <H2>Create a club</H2>
          {!creating ? (
            <Button title="New club" onPress={() => setCreating(true)} />
          ) : (
            <>
              <TextInput value={name} onChangeText={setName} placeholder="Club name" placeholderTextColor={colors.textDim} style={styles.input} maxLength={40} />
              <P dim style={{ fontSize: 12 }}>
                House rules preset
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {RULE_PRESETS.map((p) => (
                  <Text key={p.id} onPress={() => setPresetId(p.id)} style={[styles.chip, presetId === p.id && styles.chipOn]}>
                    {p.name}
                  </Text>
                ))}
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {describeRules(rulesFromPreset(presetId))}
              </P>
              <Toggle label="Approve members before they join" value={approval} onChange={setApproval} />
              <Row>
                <Button title="Create" onPress={() => void create()} disabled={!name.trim()} />
                <Button kind="ghost" title="Cancel" onPress={() => setCreating(false)} />
              </Row>
            </>
          )}
        </Card>
      </View>
      <H2>My clubs</H2>
      {clubs === null && !error && <P dim>Loading…</P>}
      {clubs?.length === 0 && <P dim>You are not in any club yet.</P>}
      {clubs?.map((c) => {
        const me = c.members.find((m) => m.userId === user.userId);
        const pending = !me;
        return (
          <Card key={c.code} style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.clubName}>
                {c.name} <Text style={{ color: colors.textDim }}>{c.code}</Text>
              </Text>
              <P dim style={{ fontSize: 12 }}>
                {c.members.length} members · {c.tables.filter((t) => t.status !== 'finished').length} tables open · {describeRules(c.rules).split(' · ')[0]}
              </P>
            </View>
            {pending ? <Pill text="Pending approval" /> : <Pill text={me.role} tone={me.role === 'owner' ? 'gold' : 'neutral'} />}
            {!pending && <Button small kind="secondary" title="Open" onPress={() => app.go({ name: 'club', code: c.code })} />}
          </Card>
        );
      })}
    </ScrollView>
  );
}

export function ClubScreen({ code }: { code: string }) {
  const app = useApp();
  const base = httpBase(app.settings.signalUrl);
  const user = { userId: app.profile.userId, name: app.profile.name || 'Player', avatar: app.profile.avatar };
  const [club, setClub] = useState<Club | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'tables' | 'standings' | 'rules'>('tables');

  const refresh = useCallback(async () => {
    try {
      setClub(await clubsApi.get(base, code));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, code]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!club) {
    return (
      <View style={styles.center}>
        <P>{error ?? 'Loading club…'}</P>
        <Button title="Back" onPress={app.back} />
      </View>
    );
  }
  const me = club.members.find((m) => m.userId === user.userId);
  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const canOpen = !!me && (isAdmin || club.settings.membersCanOpenTables);

  const openTable = async () => {
    setBusy(true);
    try {
      const t = await clubsApi.openTable(base, club.code, user, { label: `${user.name}'s table`, botSkill: app.settings.botSkill });
      await joinTable(t.code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const joinTable = async (tableCode: string) => {
    setBusy(true);
    try {
      const session = await createOnlineSession({ signalUrl: app.settings.signalUrl, name: user.name, avatar: user.avatar, userId: user.userId, rules: club.rules, action: 'join', code: tableCode, clubCode: club.code });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setRules = async (rules: Partial<RuleSet>) => {
    try {
      setClub(await clubsApi.update(base, club.code, user, { rules }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const live = club.tables.filter((t) => t.status !== 'finished');
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Row style={{ justifyContent: 'space-between' }}>
        <View>
          <H1 style={{ fontSize: 22 }}>{club.name}</H1>
          <P dim style={{ fontSize: 12 }}>
            Code <Text style={{ color: colors.gold, fontWeight: '800' }}>{club.code}</Text> · {club.members.length} members · {me ? me.role : 'guest'}
          </P>
        </View>
        <Button small kind="ghost" title="Back" onPress={app.back} />
      </Row>
      {error && <P style={{ color: colors.danger }}>{error}</P>}
      <Row>
        {(['tables', 'standings', 'rules'] as const).map((t) => (
          <Text key={t} onPress={() => setTab(t)} style={[styles.chip, tab === t && styles.chipOn]}>
            {t === 'tables' ? `Tables (${live.length})` : t === 'standings' ? 'Standings' : 'Rules'}
          </Text>
        ))}
      </Row>

      {tab === 'tables' && (
        <>
          {canOpen && <Button title={busy ? 'Opening…' : 'Open a table'} onPress={() => void openTable()} disabled={busy} />}
          {live.length === 0 && <P dim>No open tables. {canOpen ? 'Open one and share the club code.' : ''}</P>}
          {live.map((t) => (
            <Card key={t.code} style={{ gap: 4 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <H2>{t.label}</H2>
                <Pill text={t.status === 'open' ? 'Waiting' : `Hand ${t.handNumber + 1}`} tone={t.status === 'open' ? 'ok' : 'gold'} />
              </Row>
              <P dim style={{ fontSize: 12 }}>
                {describeRules(t.rules)}
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {t.players.map((p) => (
                  <Pill key={p.seat} text={`${p.isBot ? '🤖 ' : ''}${p.name}${p.connected ? '' : ' (away)'}`} />
                ))}
                {t.players.filter((p) => !p.isBot).length < 4 && <Pill text={`${4 - t.players.filter((p) => !p.isBot).length} seats`} tone="ok" />}
              </Row>
              <Button small kind="secondary" title={busy ? '…' : 'Join table'} onPress={() => void joinTable(t.code)} disabled={busy || !me} />
            </Card>
          ))}
          {club.pending.length > 0 && isAdmin && (
            <Card>
              <H2>Pending requests</H2>
              {club.pending.map((p) => (
                <Row key={p.userId} style={{ justifyContent: 'space-between' }}>
                  <P>
                    {p.avatar ?? ''} {p.name}
                  </P>
                  <Button small title="Approve" onPress={() => void clubsApi.approve(base, club.code, user, p.userId).then(setClub).catch((e: Error) => setError(e.message))} />
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
                <Text style={styles.rank}>{i + 1}</Text>
                <Text style={{ fontSize: 20 }}>{m.avatar ?? '🀄'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '800' }}>
                    {m.name} {m.role !== 'member' ? <Text style={{ color: colors.gold, fontSize: 11 }}>{m.role}</Text> : null}
                  </Text>
                  <P dim style={{ fontSize: 12 }}>
                    {m.matchesPlayed} matches · {m.matchesWon} wins
                  </P>
                </View>
                <Text style={{ color: m.points >= 0 ? colors.ok : colors.danger, fontWeight: '900' }}>
                  {m.points >= 0 ? '+' : ''}
                  {m.points}
                </Text>
              </Row>
            ))}
        </Card>
      )}

      {tab === 'rules' && (
        <Card>
          <P>{describeRules(club.rules)}</P>
          {isAdmin ? (
            <>
              <P dim style={{ fontSize: 12 }}>
                Presets
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {RULE_PRESETS.map((p) => (
                  <Text key={p.id} onPress={() => void setRules(rulesFromPreset(p.id))} style={styles.chip}>
                    {p.name}
                  </Text>
                ))}
              </Row>
              <P dim style={{ fontSize: 12 }}>
                Speed
              </P>
              <Row style={{ flexWrap: 'wrap' }}>
                {(Object.keys(SPEED_PRESETS) as GameSpeed[]).map((sp) => (
                  <Text key={sp} onPress={() => void setRules(withSpeed(club.rules, sp))} style={[styles.chip, club.rules.speed === sp && styles.chipOn]}>
                    {SPEED_PRESETS[sp].label} {SPEED_PRESETS[sp].turnSeconds}s
                  </Text>
                ))}
              </Row>
              <Toggle label="Members can open tables" value={club.settings.membersCanOpenTables} onChange={(v) => void clubsApi.update(base, club.code, user, { settings: { membersCanOpenTables: v } }).then(setClub)} />
              <Toggle label="Approve new members" value={club.settings.joinRequiresApproval} onChange={(v) => void clubsApi.update(base, club.code, user, { settings: { joinRequiresApproval: v } }).then(setClub)} />
              <Toggle label="一炮多響 multiple winners" value={club.rules.multipleWinners} onChange={(v) => void setRules({ multipleWinners: v })} />
              <Toggle label="過水 pass rule" value={club.rules.passRule} onChange={(v) => void setRules({ passRule: v })} />
              <Toggle label="Allow chi" value={club.rules.allowChi} onChange={(v) => void setRules({ allowChi: v })} />
            </>
          ) : (
            <P dim style={{ fontSize: 12 }}>
              Only the owner and admins can change rules.
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
  input: { backgroundColor: colors.panelStrong, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  codeInput: { backgroundColor: colors.panelStrong, color: colors.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, fontSize: 22, letterSpacing: 5, fontWeight: '800', textAlign: 'center' },
  chip: { color: colors.text, backgroundColor: colors.panelStrong, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, fontSize: 13, fontWeight: '700', overflow: 'hidden' },
  chipOn: { backgroundColor: colors.gold, color: colors.ink },
  clubName: { color: colors.text, fontWeight: '900', fontSize: 16 },
  standing: { paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.textDim },
  rank: { color: colors.gold, fontWeight: '900', width: 22 },
});
