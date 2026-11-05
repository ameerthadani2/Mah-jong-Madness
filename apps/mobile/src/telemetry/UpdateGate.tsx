/**
 * What the remote config shows: a blocking 'Update required' screen for a build below the server's
 * `minBuild`, and the maintenance message on Home.
 */
import React from 'react';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { STORE_URLS } from '../config';
import { space } from '../theme';
import { Button, Card, H1, P } from '../components/Ui';
import { Logo } from '../components/Logo';
import { storeUrlFor } from './remote-config';

export function UpdateRequired() {
  const { t } = useT();
  const url = storeUrlFor(Platform.OS, STORE_URLS);
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="update-required">
      <Logo size={1.1} stacked />
      <Card style={styles.card}>
        <H1>{t('privacy.update.title')}</H1>
        <P>{t('privacy.update.body')}</P>
        {url && <Button large kind="primary" icon="play" title={t(Platform.OS === 'ios' ? 'privacy.update.appStore' : 'privacy.update.playStore')} onPress={() => void Linking.openURL(url).catch(() => undefined)} />}
      </Card>
    </ScrollView>
  );
}

export function MaintenanceBanner({ message }: { message: string }) {
  const { t } = useT();
  return (
    <View style={styles.banner} accessibilityRole="alert" testID="maintenance-banner">
      <Card tone="gold">
        <P>
          {t('privacy.maintenance.title')} {message}
        </P>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.xl },
  card: { maxWidth: 480, width: '100%', gap: space.md },
  banner: { paddingHorizontal: space.lg, paddingTop: space.sm },
});
