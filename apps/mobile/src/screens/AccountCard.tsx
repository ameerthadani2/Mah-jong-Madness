/**
 * Settings → Account: who this device is on the game server, sign-in with Apple or Google,
 * signing out (guests are warned first) and account deletion behind a typed confirmation.
 * Everything here works offline: with no server answer there are simply no provider buttons.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { useT } from '../i18n';
import { friendlyError } from '../logic/errors';
import type { SignInProvider } from '../logic/auth-config';
import { colors, fonts } from '../theme';
import { Button, Card, H2, P, Pill, Row } from '../components/Ui';

const LINKED_KEY: Record<SignInProvider, string> = { apple: 'settings.account.linkedApple', google: 'settings.account.linkedGoogle' };
const SIGN_IN_KEY: Record<SignInProvider, string> = { apple: 'settings.account.apple', google: 'settings.account.google' };

export function AccountCard() {
  const auth = useAuth();
  const { t } = useT();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [word, setWord] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { refresh } = auth;
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const online = auth.status !== 'offline';
  const deleteWord = t('settings.account.deleteWord');
  const signIn = (p: SignInProvider) => void (p === 'apple' ? auth.signInApple() : auth.signInGoogle());

  return (
    <Card>
      <H2>{t('settings.account.title')}</H2>
      {auth.status === 'offline' && <P dim style={styles.small}>{t('settings.account.offline')}</P>}
      {auth.status === 'guest' && (
        <>
          <Pill text={t('settings.account.guest')} icon="shield" tone="gold" style={{ alignSelf: 'flex-start' }} />
          <P dim style={styles.small}>{t('settings.account.guestBody')}</P>
        </>
      )}
      {auth.status === 'account' && <Pill text={t('settings.account.signedIn')} icon="check" tone="ok" style={{ alignSelf: 'flex-start' }} />}
      {auth.user && <P dim style={styles.tiny}>{t('settings.account.id', { id: auth.user.id })}</P>}

      <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={8}>
        {auth.providers.map((p) =>
          p.linked ? (
            <Row key={p.id} gap={6}>
              <Pill text={t(LINKED_KEY[p.id])} icon="check" tone="ok" />
              {auth.linkedCount > 1 && <Button small kind="ghost" title={t('settings.account.unlink')} onPress={() => void auth.unlink(p.id)} disabled={auth.busy} />}
            </Row>
          ) : (
            <Button key={p.id} small kind={p.id === 'apple' ? 'secondary' : 'primary'} title={t(SIGN_IN_KEY[p.id])} onPress={() => signIn(p.id)} disabled={auth.busy} />
          ),
        )}
      </Row>
      {online && auth.providers.length === 0 && <P dim style={styles.tiny}>{t('settings.account.noProviders')}</P>}
      {auth.busy && <P dim style={styles.tiny}>{t('settings.account.busy')}</P>}
      {auth.error ? <Pill tone="danger" icon="warning" text={friendlyError(auth.error, t)} /> : null}
      {notice && <Pill tone="ok" icon="check" text={notice} />}

      {online && !confirmSignOut && !deleting && (
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }} gap={8}>
          <Button
            small
            kind="ghost"
            icon="exit"
            title={t('settings.account.signOut')}
            disabled={auth.busy}
            onPress={() => {
              setNotice(null);
              if (auth.status === 'guest') setConfirmSignOut(true);
              else void auth.signOut();
            }}
          />
          <Button
            small
            kind="danger"
            title={t('settings.account.delete')}
            disabled={auth.busy}
            onPress={() => {
              setNotice(null);
              setWord('');
              setDeleting(true);
            }}
          />
        </Row>
      )}

      {confirmSignOut && (
        <Card tone="gold">
          <P style={styles.small}>{t('settings.account.signOutGuestWarning')}</P>
          <Row gap={8}>
            <Button
              small
              kind="danger"
              title={t('settings.account.signOutConfirm')}
              disabled={auth.busy}
              onPress={() => {
                setConfirmSignOut(false);
                void auth.signOut();
              }}
            />
            <Button small kind="ghost" title={t('settings.account.cancel')} onPress={() => setConfirmSignOut(false)} />
          </Row>
        </Card>
      )}

      {deleting && (
        <Card tone="danger">
          <P style={styles.small}>{t('settings.account.deleteBody', { word: deleteWord })}</P>
          <TextInput value={word} onChangeText={setWord} placeholder={deleteWord} placeholderTextColor="#9AA0BF" autoCapitalize="characters" autoCorrect={false} style={styles.input} />
          <Row gap={8}>
            <Button
              small
              kind="danger"
              title={t('settings.account.deleteConfirm')}
              disabled={auth.busy || word.trim() !== deleteWord}
              onPress={() => {
                void (async () => {
                  if (!(await auth.deleteAccount())) return;
                  setDeleting(false);
                  setWord('');
                  setNotice(t('settings.account.deleted'));
                })();
              }}
            />
            <Button small kind="ghost" title={t('settings.account.cancel')} onPress={() => setDeleting(false)} />
          </Row>
        </Card>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 13 },
  tiny: { fontSize: 12 },
  input: { backgroundColor: '#FFFFFF', color: colors.ink, borderWidth: 3, borderColor: colors.ink, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontFamily: fonts.uiBold },
});
