/**
 * Settings card: product analytics and crash reports, each on or off, and whether the player is
 * shown on the puzzle leaderboards. Only the services this build has keys for are listed; the
 * leaderboard switch needs a session (the server keeps the choice). With none of them the card is
 * not shown at all.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useT } from '../i18n';
import { consent, telemetryAvailable, useConsent } from '../telemetry';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { httpBase } from '../api/http';
import { storeServer } from '../monetisation/server';
import { puzzleErrorText, puzzlesApi } from '../api/puzzles';
import { Card, H2, P, Toggle } from './Ui';

export function PrivacyToggles() {
  const { t } = useT();
  const { effective } = useConsent();
  const app = useApp();
  const auth = useAuth();
  const hasSession = auth.client.snapshot().hasSession && !auth.banned;
  if (!telemetryAvailable.analytics && !telemetryAvailable.crash && !hasSession) return null;
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
      {hasSession && <LeaderboardToggle />}
      <P dim>{t('privacy.never')}</P>
    </Card>
  );
}

/** "Show me on leaderboards": read from the server, on unless the player turned it off; a failed change is undone. */
function LeaderboardToggle() {
  const { t } = useT();
  const app = useApp();
  const auth = useAuth();
  const ctx = useMemo(() => ({ base: httpBase(app.signalUrl), auth: auth.client }), [app.signalUrl, auth.client]);
  // On by default, as the server sets it, until the server's answer arrives.
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    puzzlesApi
      .getLeaderboardVisible(ctx)
      .then((v) => live && setVisible(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ctx]);
  const change = (on: boolean) => {
    setVisible(on);
    setError(null);
    puzzlesApi
      .setLeaderboardVisible(ctx, on)
      .then(setVisible)
      .catch((e: unknown) => {
        setVisible(!on);
        setError(e);
      });
  };
  return (
    <View style={styles.item} testID="leaderboard-toggle">
      <Toggle label={t('privacy.leaderboards')} value={visible} onChange={change} />
      <P dim>{t('privacy.leaderboardsHelp')}</P>
      {error !== null && <P dim>{puzzleErrorText(error, t)}</P>}
    </View>
  );
}

const styles = StyleSheet.create({
  item: { gap: 2 },
});
