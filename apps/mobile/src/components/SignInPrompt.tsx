/**
 * Shown wherever online play is asked for while the device's account is signed out (the game server
 * refused its session and the app never replaces an account with a new guest on its own). Offers the
 * same provider sign-in as Settings → Account, and, behind a warning, a fresh guest.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { useT } from '../i18n';
import { friendlyError } from '../logic/errors';
import type { SignInProvider } from '../logic/auth-config';
import { colors, space } from '../theme';
import { Button, Card, H2, P, Row, ScreenHeader } from './Ui';

const SIGN_IN_KEY: Record<SignInProvider, string> = { apple: 'settings.account.apple', google: 'settings.account.google' };

export function SignInPrompt({ onBack }: { onBack?: () => void }) {
  const auth = useAuth();
  const { t } = useT();
  const [confirmFresh, setConfirmFresh] = useState(false);
  const name = auth.user?.displayName || t('common.player');
  const signIn = (p: SignInProvider) => void (p === 'apple' ? auth.signInApple() : auth.signInGoogle());
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="sign-in-prompt">
      <ScreenHeader title={t('settings.account.prompt.title')} onBack={onBack} />
      <Card>
        <H2>{t('settings.account.signedOut')}</H2>
        <P dim style={styles.small}>
          {t('settings.account.prompt.body', { name })}
        </P>
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={8}>
          {auth.providers.map((p) => (
            <Button key={p.id} small kind={p.id === 'apple' ? 'secondary' : 'primary'} title={t(SIGN_IN_KEY[p.id])} onPress={() => signIn(p.id)} disabled={auth.busy} />
          ))}
        </Row>
        {auth.providers.length === 0 && <P dim style={styles.tiny}>{t('settings.account.noProviders')}</P>}
        {auth.busy && <P dim style={styles.tiny}>{t('settings.account.busy')}</P>}
        {auth.error ? <P style={styles.danger}>{friendlyError(auth.error, t)}</P> : null}
        {!confirmFresh ? (
          <Button small kind="ghost" title={t('settings.account.prompt.startFresh')} onPress={() => setConfirmFresh(true)} disabled={auth.busy} />
        ) : (
          <Card tone="gold">
            <P style={styles.small}>{t('settings.account.prompt.startFreshWarning', { name })}</P>
            <Row gap={8} style={{ flexWrap: 'wrap', rowGap: 8 }}>
              <Button small kind="danger" title={t('settings.account.prompt.startFreshConfirm')} disabled={auth.busy} onPress={() => void auth.startFresh()} />
              <Button small kind="ghost" title={t('settings.account.cancel')} onPress={() => setConfirmFresh(false)} />
            </Row>
          </Card>
        )}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, flexGrow: 1 },
  small: { fontSize: 13 },
  tiny: { fontSize: 12 },
  danger: { fontSize: 13, color: colors.dangerText },
});
