/**
 * Quick match (plan decision 3): the server seats this player with strangers in arrival order,
 * Club bots fill empty seats after 20 seconds, and the table starts by itself. The screen starts
 * searching as soon as the online guard lets it (age gate, update block, sign-in), shows the
 * players found and the wait, and joins the table through the usual session code once matched.
 *
 * What a refusal leads to is decided in src/game/quickMatch.ts (`runQuickMatch`): `age_missing`
 * sends the birth year this device holds once and queues again (the age gate first when it holds
 * none), `age_under` and `banned` are final, and `seated` takes the player back to the table the
 * account still sits at (src/game/session.ts) instead of showing anything.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { QueueStatus } from '@mjm/net';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { startQuickMatch, type Session } from '../game/session';
import { quickMatchView, retryWaitSeconds, runQuickMatch, savedRejoinToken } from '../game/quickMatch';
import { friendlyError } from '../logic/errors';
import { useT } from '../i18n';
import { useOnlineGuard } from '../legal/useOnlineGuard';
import { AgeBlocked, AgeGate } from '../components/AgeGate';
import { SignInPrompt } from '../components/SignInPrompt';
import { NameRefusedNotice } from '../components/NameRefusedNotice';
import { acceptedName } from '../logic/profile';
import { colors, space } from '../theme';
import { Button, Card, H2, P, Pill, Row, ScreenHeader } from '../components/Ui';
import { Icon } from '../components/Icons';

type Phase = 'connecting' | 'searching' | 'matched' | 'returning' | 'failed';

/** What went wrong, in the player's language. `final`: trying again cannot help. `retryAt`: when the retry is offered. */
interface Failure {
  text: string;
  final: boolean;
  retryAt: number;
}

const HEADING: Record<Phase, string> = {
  connecting: 'quickmatch.connecting',
  searching: 'quickmatch.searching',
  matched: 'quickmatch.matched',
  returning: 'quickmatch.returning',
  failed: 'quickmatch.title',
};

export function QuickMatchScreen() {
  const app = useApp();
  const auth = useAuth();
  const { t } = useT();
  const { entry, gate } = useOnlineGuard();
  const [phase, setPhase] = useState<Phase>('connecting');
  const [status, setStatus] = useState<{ s: QueueStatus; at: number } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [needAge, setNeedAge] = useState(false);
  const [now, setNow] = useState(Date.now());
  const search = useRef<{ cancel(): void } | null>(null);
  const alive = useRef(true);
  // Read when the server answers, which can be long after this render.
  const latest = useRef({ gate, saved: app.activeSession });
  latest.current = { gate, saved: app.activeSession };

  const begin = useCallback(async () => {
    const fail = (text: string, final = false, retryAfterMs = 0) => {
      setFailure({ text, final, retryAt: Date.now() + retryAfterMs });
      setNow(Date.now());
      setPhase('failed');
    };
    setFailure(null);
    setStatus(null);
    setPhase('connecting');
    try {
      await auth.client.ensureSession();
    } catch (e) {
      // No account to queue with: the server is out of reach, or it refuses this device (a ban is final).
      if (alive.current) fail(friendlyError(e, t), (e as { code?: unknown } | null)?.code === 'banned');
      return;
    }
    if (!alive.current) return;
    const outcome = await runQuickMatch<Session>({
      search: () => {
        const q = startQuickMatch({
          signalUrl: app.signalUrl,
          name: acceptedName(app.profile) || t('common.player'),
          avatar: app.profile.avatar,
          userId: auth.user?.id || app.profile.userId || undefined,
          ...auth.tableAuth,
          onStatus: (s) => {
            if (!alive.current) return;
            setPhase('searching');
            setStatus({ s, at: Date.now() });
          },
          onMatched: () => alive.current && setPhase('matched'),
          onSeated: () => alive.current && setPhase('returning'),
          savedToken: (room) => savedRejoinToken(latest.current.saved, app.signalUrl, room),
        });
        search.current = q;
        return q.session.finally(() => {
          if (search.current === q) search.current = null;
        });
      },
      birthYear: () => latest.current.gate.record?.birthYear,
      sendBirthYear: () => latest.current.gate.sendToServer(),
    });
    if (outcome.kind === 'session') {
      if (!alive.current) return outcome.session.close();
      app.setSession(outcome.session);
      // Home, then the table: leaving the table goes home, not back into the queue.
      app.reset({ name: 'home' });
      app.go({ name: 'table' });
      return;
    }
    if (!alive.current || outcome.kind === 'cancelled') return;
    if (outcome.kind === 'ask_age') {
      setPhase('failed');
      setNeedAge(true);
      return;
    }
    fail(outcome.message ? t(outcome.message.key, outcome.message.params) : friendlyError(outcome.error, t), outcome.final, outcome.retryAfterMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.signalUrl, app.profile.name, app.profile.refusedName, app.profile.avatar, auth, t]);

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

  // The server had no birth year and neither had this device: once the age gate has one, search again.
  const hasYear = gate.record !== null;
  useEffect(() => {
    if (!needAge || !hasYear) return;
    setNeedAge(false);
    void begin();
  }, [needAge, hasYear, begin]);

  // The wait counts up between the server's statuses (every 2 s), and down to the retry after "too many tries".
  const waitingToRetry = failure !== null && !failure.final && now < failure.retryAt;
  useEffect(() => {
    if (phase !== 'searching' && !waitingToRetry) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase, waitingToRetry]);

  const cancel = () => {
    search.current?.cancel();
    app.back();
  };

  if (entry === 'blocked') return <AgeBlocked onBack={app.back} />;
  if (entry === 'ask' || needAge) return <AgeGate onBack={app.back} />;
  if (entry === 'sign_in') return <SignInPrompt onBack={app.back} />;

  const view = quickMatchView(status?.s ?? null, status ? status.s.waitedMs + Math.max(0, now - status.at) : 0);
  const found = t('quickmatch.humans', { count: view.humans });
  const waited = t('quickmatch.waited', { seconds: view.waitedSeconds });
  const retryIn = failure ? retryWaitSeconds(failure.retryAt, now) : 0;
  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <ScreenHeader title={t('quickmatch.title')} onBack={cancel} />
      <View style={styles.card}>
        <NameRefusedNotice />
      </View>
      <Card style={styles.card} testID="quickmatch-card">
        <Row>
          <Icon name="users" size={30} color={colors.cta} />
          <H2>{t(HEADING[phase])}</H2>
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
        {failure ? (
          <Card tone="danger" testID="quickmatch-error">
            <Row>
              <Icon name="warning" size={24} />
              <P style={{ flex: 1 }}>{failure.text}</P>
            </Row>
          </Card>
        ) : null}
        <Row style={{ flexWrap: 'wrap', rowGap: 8 }}>
          {phase === 'failed' && failure && !failure.final ? (
            <Button testID="quickmatch-retry" title={retryIn > 0 ? t('quickmatch.retryIn', { seconds: retryIn }) : t('quickmatch.retry')} onPress={() => void begin()} disabled={retryIn > 0} />
          ) : null}
          <Button
            testID="quickmatch-cancel"
            kind={phase === 'failed' && !failure?.final ? 'ghost' : 'secondary'}
            title={phase === 'failed' ? t('common.back') : t('quickmatch.cancel')}
            onPress={cancel}
            disabled={phase === 'matched' || phase === 'returning'}
          />
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
