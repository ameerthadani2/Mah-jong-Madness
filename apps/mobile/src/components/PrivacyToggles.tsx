/**
 * Settings card: product analytics and crash reports, each on or off. Only the services this
 * build has keys for are listed; with neither configured the card is not shown at all.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { consent, telemetryAvailable, useConsent } from '../telemetry';
import { Card, H2, P, Toggle } from './Ui';

export function PrivacyToggles() {
  const { t } = useT();
  const { effective } = useConsent();
  if (!telemetryAvailable.analytics && !telemetryAvailable.crash) return null;
  return (
    <Card testID="privacy-toggles">
      <H2>{t('privacy.title')}</H2>
      {telemetryAvailable.analytics && (
        <View style={styles.item}>
          <Toggle label={t('privacy.analytics')} value={effective.analytics} onChange={(on) => consent.dispatch({ type: 'analytics', on })} />
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
