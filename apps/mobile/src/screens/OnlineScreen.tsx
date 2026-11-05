import React, { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../app-state';
import { createOnlineSession } from '../game/session';
import { friendlyError } from '../logic/errors';
import { rulesSummary } from '../logic/rules-text';
import { useT } from '../i18n';
import { colors, fonts, space } from '../theme';
import { Button, Card, H2, P, Row, ScreenHeader } from '../components/Ui';
import { Icon } from '../components/Icons';

export function OnlineScreen() {
  const app = useApp();
  const { t, locale } = useT();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'create' | 'join' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: 'create' | 'join') => {
    setBusy(action);
    setError(null);
    try {
      const session = await createOnlineSession({
        signalUrl: app.signalUrl,
        name: app.profile.name || t('common.player'),
        avatar: app.profile.avatar,
        userId: app.profile.userId,
        rules: app.settings.rules,
        action,
        code: code.trim().toUpperCase(),
        botSkill: app.settings.botSkill,
      });
      app.setSession(session);
      app.go({ name: 'lobby' });
    } catch (e) {
      setError(friendlyError(e, t));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('online.title')} onBack={app.back} right={<Button small kind="ghost" icon="users" title={t('online.clubs')} onPress={() => app.go({ name: 'clubs' })} />} />
      <View style={styles.note}>
        <Icon name="shield" size={20} />
        <P style={{ flex: 1, fontSize: 13, lineHeight: 18 }}>
          {t('online.note')}
        </P>
      </View>
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
