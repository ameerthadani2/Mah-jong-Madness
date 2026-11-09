/**
 * Quick match (plan decision 3): the server seats this player with strangers in arrival order,
 * Club bots fill empty seats after 20 seconds, and the table starts by itself. The screen starts
 * searching as soon as the online guard lets it (age gate, update block, sign-in), shows the
 * players found and the wait, and joins the table through the usual session code once matched.
 * `age_required` from the server means it has no birth year for this account: the one this
 * device holds is sent and the search tried once more; without one the age gate shows.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { QueueStatus } from '@mjm/net';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { startQuickMatch, type Session } from '../game/session';
import { quickMatchFailure, quickMatchView } from '../game/quickMatch';
import { friendlyError } from '../logic/errors';
import { useT } from '../i18n';
import { useOnlineGuard } from '../legal/useOnlineGuard';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { SignInPrompt } from '../components/SignInPrompt';
import { colors, space } from '../theme';
import { Button, Card, H2, P, Pill, Row, ScreenHeader } from '../components/Ui';
import { Icon } from '../components/Icons';

type Phase = 'connecting' | 'searching' | 'matched' | 'failed';

export function QuickMatchScreen() {
  const app = useApp();
  const auth = useAuth();
  const { t } = useT();
  const { entry, gate } = useOnlineGuard();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [status, setStatus] = useState<{ s: QueueStatus; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const search = useRef<{ cancel(): void } | null>(null);
  const alive = useRef(true);
  const ageRetried = useRef(false);

  const begin = useCallback(async () => {
    setError(null);
    setStatus(null);
    setPhase('connecting');
    if (!(await auth.ensure())) {
      if (!alive.current) return;
      setPhase('failed');
      setError(friendlyError(auth.error ?? new Error('offline'), t));
      return;
    }
    if (!alive.current) return;
    const q = startQuickMatch({
      signalUrl: app.signalUrl,
      name: app.profile.name || t('common.player'),
      avatar: app.profile.avatar,
      userId: auth.user?.id || app.profile.userId || undefined,
      ...auth.tableAuth,
      onStatus: (s) => {
        if (!alive.current) return;
        setPhase('searching');
        setStatus({ s, at: Date.now() });
      },
      onMatched: () => alive.current && setPhase('matched'),
    });
    search.current = q;
    let session: Session;
    try {
      session = await q.session;
    } catch (e) {
      if (!alive.current) return;
      const failure = quickMatchFailure(e);
      if (failure.kind === 'cancelled') return;
      if (failure.kind === 'age') {
        // The server has no birth year for this account: send the one this device holds, then try once more.
        const birthYear = gate.record?.birthYear;
        if (birthYear && !ageRetried.current) {
          ageRetried.current = true;
          try {
            await auth.client.updateMe({ birthYear });
            if (alive.current) void begin();
            return;
          } catch {
            /* falls through to the message */
          }
        }
        setPhase('failed');
        setError(t('quickmatch.errors.ageSync'));
        return;
      }
      setPhase('failed');
      setError(failure.kind === 'message' ? t(failure.message.key, failure.message.params) : friendlyError(e, t));
      return;
    } finally {
      if (search.current === q) search.current = null;
    }
    if (!alive.current) {
      session.close();
      return;
    }
    app.setSession(session);
    // Home, then the table: leaving the table goes home, not back into the queue.
    app.reset({ name: 'home' });
    app.go({ name: 'table' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.signalUrl, app.profile.name, app.profile.avatar, auth, gate.record?.birthYear, t]);

  // Start searching once the guard lets this player online; stop when the screen goes.
  const started = useRef(false);
  useEffect(() => {
    if (entry !== 'ok' || started.current) return;
    started.current = true;
    void begin();
  }, [entry, begin]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      search.current?.cancel();
    };
  }, []);

  // The wait counts up between the server's statuses (every 2 s).
  useEffect(() => {
    if (phase !== 'searching') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const cancel = () => {
    search.current?.cancel();
    app.back();
  };

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask') return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;

  const view = quickMatchView(status?.s ?? null, status ? status.s.waitedMs + Math.max(0, now - status.at) : 0);
  const found = t('quickmatch.humans', { count: view.humans });
  const waited = t('quickmatch.waited', { seconds: view.waitedSeconds });
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('quickmatch.title')} onBack={cancel} />
      <Card style={styles.card} testID="quickmatch-card">
        <Row>
          <Icon name="users" size={30} color={colors.cta} />
          <H2>{phase === 'matched' ? t('quickmatch.matched') : phase === 'connecting' ? t('quickmatch.connecting') : phase === 'failed' ? t('quickmatch.title') : t('quickmatch.searching')}</H2>
        </Row>
        {phase === 'searching' || phase === 'matched' ? (
          <View accessible accessibilityLiveRegion="polite" accessibilityLabel={t('quickmatch.a11y.status', { found, waited })} style={styles.status}>
            <View style={styles.seats}>
              {[0, 1, 2, 3].map((i) => (
                <View key={i} style={[styles.seat, i < view.humans ? styles.seatFound : null]}>
                  <Icon name={i < view.humans ? 'smile' : 'hourglass'} size={22} />
                </View>
              ))}
            </View>
            <P style={styles.big}>{found}</P>
            <P dim>{waited}</P>
          </View>
        ) : null}
        <Pill icon="bot" tone="gold" wrap text={t('quickmatch.botsNote', { seconds: view.fillSeconds })} />
        <P dim style={{ fontSize: 13 }}>
          {t('quickmatch.rules')}
        </P>
        {error ? (
          <Card tone="danger">
            <Row>
              <Icon name="warning" size={24} />
              <P style={{ flex: 1 }}>{error}</P>
            </Row>
          </Card>
        ) : null}
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {phase === 'failed' ? <Button testID="quickmatch-retry" title={t('quickmatch.retry')} onPress={() => void begin()} /> : null}
          <Button testID="quickmatch-cancel" kind={phase === 'failed' ? 'ghost' : 'secondary'} title={t('quickmatch.cancel')} onPress={cancel} disabled={phase === 'matched'} />
        </Row>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: space.lg, gap: space.md, alignItems: 'center' },
  card: { width: '100%', maxWidth: 560, gap: space.md },
  status: { alignItems: 'center', gap: 6 },
  seats: { flexDirection: 'row', gap: 10 },
  seat: { width: 48, height: 48, borderRadius: 24, borderWidth: 3, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  seatFound: { backgroundColor: colors.gold },
  big: { fontSize: 20, fontWeight: '800' },
});
