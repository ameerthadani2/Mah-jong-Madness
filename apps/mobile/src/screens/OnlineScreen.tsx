import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../app-state';
import { createOnlineSession } from '../game/session';
import { useAuth } from '../auth/AuthProvider';
import { friendlyError } from '../logic/errors';
import { tableError } from '../components/table/tableErrors';
import { rulesSummary } from '../logic/rules-text';
import { useT } from '../i18n';
import { useOnlineGuard } from '../legal/useOnlineGuard';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { SignInPrompt } from '../components/SignInPrompt';
import { NameRefusedNotice } from '../components/NameRefusedNotice';
import { acceptedName } from '../logic/profile';
import { colors, fonts, space } from '../theme';
import { Button, Card, H2, P, Row, ScreenHeader } from '../components/Ui';
import { Icon } from '../components/Icons';

export function OnlineScreen() {
  const app = useApp();
  const auth = useAuth();
  const { t, locale } = useT();
  // Nothing reaches the server until the age gate (and the account) let it: src/legal/online.ts.
  const { entry } = useOnlineGuard();
  const [code, setCode] = useState('');
  // Opening Online is the first moment the app needs the server: bootstrap the guest now (quietly; failures show below).
  const { ensure } = auth;
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (entry !== 'ok') return;
    void ensure().finally(() => setChecking(false));
  }, [ensure, entry]);
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'create' | 'join') => {
    setBusy(action);
    setError(null);
    try {
      const session = await createOnlineSession({
        signalUrl: app.signalUrl,
        name: acceptedName(app.profile) || t('common.player'),
        avatar: app.profile.avatar,
        userId: auth.user?.id || app.profile.userId || undefined,
        rules: app.settings.rules,
        action,
        code: code.trim().toUpperCase(),
        botSkill: app.settings.botSkill,
        ...auth.tableAuth,
      });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      // Join and create refusals (one seat per account, table gone or full, server or account at its limit) by code.
      setError(tableError(e, t));
    } finally {
      setBusy(null);
    }
  };

  // Installs that predate the age gate are asked before their first online table.
  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('online.title')} onBack={app.back} right={<Button small kind="ghost" icon="users" title={t('online.clubs')} onPress={() => app.go({ name: 'clubs' })} />} />
      <View style={styles.note}>
        <Icon name="shield" size={20} />
        <P style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>
          {t('online.note')}
        </P>
      </View>
      <NameRefusedNotice />
      <Card tone="gold" testID="online-quickmatch">
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
          <Icon name="users" size={26} color={colors.cta} />
          <View style={{ flex: 1, minWidth: 180 }}>
            <H2>{t('online.quick.title')}</H2>
            <P dim style={{ fontSize: 13 }}>{t('online.quick.body')}</P>
          </View>
          <Button testID="online-quickmatch-button" title={t('online.quick.button')} onPress={() => app.go({ name: 'quickmatch' })} disabled={busy !== null} />
        </Row>
      </Card>
      <View style={styles.cols}>
        <Card style={styles.col}>
          <Row>
            <Icon name="play" size={26} color={colors.cta} />
            <H2>{t('online.create.title')}</H2>
          </Row>
          <P dim style={{ fontSize: 13 }}>{rulesSummary(app.settings.rules, t, locale)}</P>
          <P dim style={{ fontSize: 12 }}>{t('online.create.body')}</P>
          <Button title={busy === 'create' ? t('online.create.busy') : t('online.create.button')} onPress={() => void run('create')} disabled={busy !== null} />
        </Card>
        <Card style={styles.col}>
          <Row>
            <Icon name="users" size={26} />
            <H2>{t('online.join.title')}</H2>
          </Row>
          <TextInput value={code} onChangeText={(v) => setCode(v.toUpperCase())} autoCapitalize="characters" placeholder="ABC123" placeholderTextColor="#9AA0BF" style={styles.input} maxLength={8} />
          <Button title={busy === 'join' ? t('online.join.busy') : t('online.join.button')} kind="secondary" onPress={() => void run('join')} disabled={busy !== null || code.trim().length < 4} />
        </Card>
      </View>
      {checking && auth.status === 'offline' && <P dim style={{ fontSize: 12 }}>{t('online.connecting')}</P>}
      {!error && !checking && auth.status === 'offline' && auth.error ? (
        <Card tone="danger">
          <Row>
            <Icon name="warning" size={24} />
            <P style={{ flex: 1 }}>{friendlyError(auth.error, t)}</P>
            {/* A ban is the server's final word: asking again gets the same answer. */}
            {!auth.banned && <Button small kind="secondary" title={t('online.retry')} onPress={() => void ensure()} disabled={auth.busy} />}
          </Row>
        </Card>
      ) : null}
      {error && (
        <Card tone="danger">
          <Row>
            <Icon name="warning" size={24} />
            <P style={{ flex: 1 }}>{error}</P>
          </Row>
          {__DEV__ && (
            <P dim style={{ fontSize: 12 }}>
              {t('online.devServer', { url: app.signalUrl })}
            </P>
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md },
  note: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(255,255,255,0.75)', borderWidth: 2, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  cols: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md },
  col: { flexGrow: 1, flexBasis: '45%', minWidth: 240 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 26, letterSpacing: 6, fontFamily: fonts.display, textAlign: 'center' },
});
