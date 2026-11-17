/**
 * The owner's store check (scripts/store-check.ts) run without a person: a memory game server on port 0 receives the
 * RevenueCat webhook events each step of docs/QA.md section 11 makes the store send (payloads shaped like
 * webhook.test.ts's), the prompt sends them instead of waiting for Enter, and the script polls the admin wallet report.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';
import { parseArgs, runStoreCheck, STORE_CHECK_STEPS, StoreCheckError, type StoreCheckStep } from '../scripts/store-check';

const ADMIN = 'admin-token-store-check-0123456789';
const SECRET = 'rc_webhook_secret_0123456789';
const DAY = 86_400_000;

const servers: SignalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.unstubAllEnvs();
});

async function start() {
  const handle = createRepos();
  const tester = (await handle.repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: Date.now() })).id;
  const other = (await handle.repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: Date.now() })).id;
  // The server's wallet reads the tester list when it is built.
  vi.stubEnv('TESTER_USER_IDS', tester);
  const server = await createSignalServer({
    port: 0,
    host: '127.0.0.1',
    repos: handle,
    sessions: new SessionService(handle.repos, { pepper: 'store-check-pepper-0123456789abcdef' }),
    providers: {},
    config: loadConfig({ REVENUECAT_WEBHOOK_SECRET: SECRET }),
    adminToken: ADMIN,
    log: () => undefined,
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  /** A RevenueCat v1 webhook, as the sandbox store sends it. */
  const hook = async (type: string, appUserId: string, event: Record<string, unknown>) => {
    const at = Date.now();
    const body = {
      api_version: '1.0',
      event: {
        id: randomUUID().toUpperCase(),
        type,
        app_user_id: appUserId,
        original_app_user_id: appUserId,
        aliases: [appUserId],
        event_timestamp_ms: at,
        purchased_at_ms: at,
        environment: 'SANDBOX',
        store: 'APP_STORE',
        currency: 'TWD',
        price_in_purchased_currency: 30,
        ...event,
      },
    };
    const res = await fetch(`${base}/api/webhooks/revenuecat`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
  };
  return { base, tester, other, hook };
}

/** What the store sends for each step when the owner does it on the phone. */
function storeFor(s: Awaited<ReturnType<typeof start>>, skip: string[] = []) {
  const until = () => Date.now() + 30 * DAY;
  const steps: Record<string, () => Promise<void>> = {
    pack: () => s.hook('NON_RENEWING_PURCHASE', s.tester, { product_id: 'diamonds.60', transaction_id: '2000000000000101' }),
    subscribe: () => s.hook('INITIAL_PURCHASE', s.tester, { product_id: 'coach.gold.month', transaction_id: '2000000000000102', original_transaction_id: '2000000000000102', expiration_at_ms: until() }),
    upgrade: () => s.hook('INITIAL_PURCHASE', s.tester, { product_id: 'fourwinds.month', transaction_id: '2000000000000103', original_transaction_id: '2000000000000103', expiration_at_ms: until() }),
    // Restore on the second phone sends nothing new: the purchases are already on the account.
    restore: async () => {},
    'refund-plan': () => s.hook('CANCELLATION', s.tester, { product_id: 'coach.gold.month', transaction_id: '2000000000000102', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: Date.now() }),
    'refund-pack': () => s.hook('CANCELLATION', s.tester, { product_id: 'diamonds.60', transaction_id: '2000000000000101', cancel_reason: 'CUSTOMER_SUPPORT' }),
    'non-tester': () => s.hook('NON_RENEWING_PURCHASE', s.other, { product_id: 'diamonds.60', transaction_id: '2000000000000104' }),
  };
  return async (step: StoreCheckStep) => {
    if (!skip.includes(step.name)) await steps[step.name]();
  };
}

const fast = { timeoutMs: 400, pollMs: 20, settleMs: 100 };

describe('the store check script', () => {
  it('passes every section 11 step when the store sends what each one should, and never prints the token', async () => {
    const s = await start();
    const lines: string[] = [];
    const asked: string[] = [];
    const store = storeFor(s);
    const res = await runStoreCheck({
      url: s.base,
      token: ADMIN,
      user: s.tester,
      otherUser: s.other,
      ...fast,
      prompt: async (step) => {
        asked.push(step.name);
        await store(step);
      },
      print: (l) => lines.push(l),
    });
    expect(asked).toEqual(STORE_CHECK_STEPS.map((x) => x.name));
    expect(res.steps.map((x) => `${x.status} ${x.name}`)).toEqual(STORE_CHECK_STEPS.map((x) => `PASS ${x.name}`));
    expect(res.ok).toBe(true);
    const out = lines.join('\n');
    expect(out).toMatch(/PASS pack: \+60 diamonds \(app_store:2000000000000101\); balance 60 \+ 0 bonus/);
    expect(out).toMatch(/PASS subscribe: Coach Gold: coach\.gold\.month live until .* \(app_store\)/);
    expect(out).toMatch(/PASS refund-plan: refund refund:2000000000000102; coach\.gold\.month ended .*; still live: fourwinds\.month/);
    expect(out).toMatch(/PASS refund-pack: -60 diamonds \(refund:2000000000000101\); balance 0 \+ 0 bonus/);
    expect(out).toMatch(/PASS non-tester: NON_RENEWING_PURCHASE diamonds\.60 recorded as ignored_sandbox/);
    expect(out).toContain('Store check: 7 passed, 0 failed, 0 skipped');
    expect(out).not.toContain(ADMIN);
  });

  it('fails a step the store never answers, with what it saw, and carries on', async () => {
    const s = await start();
    const lines: string[] = [];
    const store = storeFor(s, ['subscribe']);
    const res = await runStoreCheck({ url: s.base, token: ADMIN, user: s.tester, only: ['pack', 'subscribe', 'non-tester'], ...fast, prompt: store, print: (l) => lines.push(l) });
    expect(res.ok).toBe(false);
    expect(res.steps.map((x) => `${x.status} ${x.name}`)).toEqual(['PASS pack', 'FAIL subscribe', 'SKIP non-tester']);
    expect(res.steps[1].saw).toBe('no live Coach Gold bought in the store yet (no plans)');
    expect(lines.join('\n')).toContain('Store check: 1 passed, 1 failed, 1 skipped');
  });

  it('fails the pack step for an account the server does not treat as a tester (a sandbox purchase grants nothing)', async () => {
    const s = await start();
    const store = storeFor(s);
    // The owner gives the wrong account: the phone buys as the non-tester.
    const res = await runStoreCheck({ url: s.base, token: ADMIN, user: s.other, only: ['pack'], ...fast, prompt: () => store({ name: 'non-tester' } as StoreCheckStep), print: () => {} });
    expect(res.steps[0]).toMatchObject({ status: 'FAIL', saw: 'no purchase credit on the ledger yet (balance 0 + 0 bonus)' });
  });

  it('fails the restore step at once when a restore credits a pack again', async () => {
    const s = await start();
    const store = storeFor(s);
    const res = await runStoreCheck({
      url: s.base,
      token: ADMIN,
      user: s.tester,
      only: ['pack', 'restore'],
      ...fast,
      settleMs: 60_000,
      // A broken restore: the same pack arrives again under a new transaction id.
      prompt: (step) => (step.name === 'restore' ? s.hook('NON_RENEWING_PURCHASE', s.tester, { product_id: 'diamonds.60', transaction_id: '2000000000000999' }) : store(step)),
      print: () => {},
    });
    expect(res.steps[1]).toMatchObject({ status: 'FAIL', saw: 'credited again: +60 (app_store:2000000000000999)' });
    expect(res.steps[1].ms).toBeLessThan(60_000);
  });

  it('stops before asking anything when the token or the account is wrong, without printing the token', async () => {
    const s = await start();
    const prompt = vi.fn(async () => {});
    await expect(runStoreCheck({ url: s.base, token: 'wrong-token-abc', user: s.tester, prompt, print: () => {} })).rejects.toThrow('The server refused ADMIN_TOKEN (401)');
    await expect(runStoreCheck({ url: s.base, token: ADMIN, user: randomUUID(), prompt, print: () => {} })).rejects.toThrow(/No account .* on this server \(404\)/);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('reads its options', () => {
    expect(parseArgs(['--url', 'https://x.example', '--user', 'u1', '--other-user', 'u2', '--only', 'pack,restore', '--timeout', '60', '--poll', '2', '--settle', '10', '--json'])).toEqual({
      url: 'https://x.example',
      user: 'u1',
      otherUser: 'u2',
      only: ['pack', 'restore'],
      timeoutMs: 60_000,
      pollMs: 2_000,
      settleMs: 10_000,
      json: true,
    });
    expect(() => parseArgs(['--only', 'pack,dance'])).toThrow(StoreCheckError);
    expect(() => parseArgs(['--timeout', 'soon'])).toThrow('--timeout takes a number of seconds');
    expect(() => parseArgs(['--token', 'x'])).toThrow("Unknown option '--token'");
  });
});
