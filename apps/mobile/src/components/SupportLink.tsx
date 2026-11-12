/**
 * "Contact support": the sentence and the link shown wherever the app tells a player that only support can
 * help (a ban, a birth year typed wrong), and the row in Settings. Renders nothing in a build that names no
 * support address (src/legal/support.ts), so no screen points at a desk that cannot be reached.
 */
import React from 'react';
import { Linking, View, type StyleProp, type ViewStyle } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { APP_NAME } from '../config';
import { useT } from '../i18n';
import { SUPPORT, supportHref } from '../legal/support';
import { Button, P } from './Ui';

export function SupportLink({ reason, style }: { /** The sentence above the link: why support is the way out here. */ reason?: 'mistake' | 'birthYear'; style?: StyleProp<ViewStyle> }) {
  const auth = useAuth();
  const { t } = useT();
  if (!SUPPORT) return null;
  const contact = SUPPORT;
  const open = () => {
    const id = auth.user?.id;
    const href = supportHref(contact, { subject: t('legal.support.subject', { app: t('common.appName', { name: APP_NAME }) }), idLine: id ? t('legal.support.idLine', { id }) : null });
    void Linking.openURL(href).catch(() => undefined);
  };
  return (
    <View style={[{ gap: 6, alignItems: 'flex-start' }, style]} testID="support">
      {reason && <P style={{ fontSize: 13, lineHeight: 18 }}>{t(reason === 'mistake' ? 'legal.support.mistake' : 'legal.support.birthYear')}</P>}
      <Button small kind="secondary" testID="support-contact" title={t('legal.support.contact')} onPress={open} />
    </View>
  );
}
