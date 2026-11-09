/**
 * Settings card: product analytics and crash reports, each on or off. Only the services this
 * build has keys for are listed; with neither configured the card is not shown at all.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { consent, telemetryAvailable, useConsent } from '../telemetry';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { httpBase } from '../api/http';
import { storeServer } from '../monetisation/server';
import { Card, H2, P, Toggle } from './Ui';

export function PrivacyToggles() {
  const { t } = useT();
  const { effective } = useConsent();
  const app = useApp();
  const auth = useAuth();
  if (!telemetryAvailable.analytics && !telemetryAvailable.crash) return null;
  return (
    <Card testID="privacy-toggles">
      <H2>{t('privacy.title')}</H2>
      {telemetryAvailable.analytics && (
        <View style={styles.item}>
          <Toggle label={t('privacy.analytics')} value={effective.analytics} onChange={(on) => {
              consent.dispatch({ type: 'analytics', on });
              // The server keeps the choice too, so its own events (purchases, reports) follow it.
              if (auth.client.snapshot().hasSession) void storeServer.sendAnalyticsConsent({ base: httpBase(app.signalUrl), auth: auth.client }, on).catch(() => undefined);
            }} />
          <P dim>{t('privacy.analyticsHelp')}</P>
        </View>
      )}
      {telemetryAvailable.crash && (
        <View style={styles.item}>
          <Toggle label={t('privacy.crash')} value={effective.crash} onChange={(on) => consent.dispatch({ type: 'crash', on })} />
          <P dim>{t('privacy.crashHelp')}</P>
        </View>
      )}
      <P dim>{t('privacy.never')}</P>
    </Card>
  );
}

const styles = StyleSheet.create({
  item: { gap: 2 },
});
