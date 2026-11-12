/**
 * Shown wherever online play is asked for while the device's account is signed out (the game server
 * refused its session and the app never replaces an account with a new guest on its own). Offers the
 * same provider sign-in as Settings → Account, and, behind a warning, a fresh guest.
 *
 * Not after a ban (`auth.banned`: a 403 `banned`, or a socket closed with 4403): the ban covers this
 * device, so a new guest would get the same refusal. The prompt says so instead of offering one.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { offersStartFresh } from '../auth/client';
import { useT } from '../i18n';
import { friendlyError } from '../logic/errors';
import type { SignInProvider } from '../logic/auth-config';
import { colors, space } from '../theme';
import { Button, Card, H2, P, Row, ScreenHeader } from './Ui';
import { SupportLink } from './SupportLink';

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
        {auth.error && !auth.banned ? <P style={styles.danger}>{friendlyError(auth.error, t)}</P> : null}
        {auth.banned ? (
          <Card tone="danger" testID="sign-in-banned">
            <P style={styles.small}>{t('settings.account.banned')}</P>
            <SupportLink reason="mistake" />
          </Card>
        ) : null}
        {!offersStartFresh(auth) ? null : !confirmFresh ? (
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
