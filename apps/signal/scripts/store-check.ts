/**
 * The owner's sandbox store run (docs/QA.md section 11), checked on the server one step at a time.
 *
 *   ADMIN_TOKEN=... npm run store-check -w @mjm/signal -- --url https://mahjong-signal.fly.dev --user <account id>
 *
 * `--user` is the game account signed in on the phone, which must be on the server's TESTER_USER_IDS. For each step
 * it says what to do on the phone and waits for Enter, then polls GET /api/admin/users/:id/wallet (every few seconds,
 * for up to two minutes) for the change that step should make, and prints PASS or FAIL with what it saw. At the end
 * it prints a summary and exits non-zero if any step failed. The steps:
 *
 *   1. pack         buy the smallest diamond pack: a purchase credit on the ledger and the balance up by it
 *   2. subscribe    subscribe to Coach Gold monthly: a live Coach Gold plan bought in the store
 *   3. upgrade      upgrade to The Four Winds Club: a live Four Winds plan bought in the store
 *   4. restore      Restore purchases on a second phone (same store and game account): nothing credited twice, every
 *                   plan still live (watched for --settle seconds, 20 by default, since nothing should change)
 *   5. refund-plan  refund the Coach Gold charge: a refund on the ledger, Coach Gold no longer live, Four Winds still is
 *   6. refund-pack  refund the diamond pack: a refund taking diamonds back on the ledger, the balance down by it
 *   7. non-tester   buy the smallest pack signed in as `--other-user`, an account NOT on TESTER_USER_IDS: the purchase
 *                   reaches the server and is ignored as sandbox, nothing credited (skipped without --other-user)
 *
 * Options: --other-user <id>, --only <step,step> (run some steps; a later step's check assumes the earlier ones were
 * done), --timeout <seconds> (default 120), --poll <seconds> (default 5), --settle <seconds> (default 20), --json.
 * ADMIN_TOKEN is read from the environment and never printed.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export interface WalletReport {
  userId: string;
  wallet: { diamonds: number; bonusDiamonds: number };
  entitlements: Array<{ entitlement: string; product: string; plan: string | null; store: string | null; source: string; expiresAt: string | null; live: boolean }>;
  ledger: Array<{ id: number; delta: number; bonus: number; reason: string; ref: string | null; at: string }>;
  storeEvents: Array<{ eventId: string; type: string; productId: string | null; environment: string | null; outcome: string; at: string }>;
}

/** What a step's check found: `ok` ends the wait with PASS; `bad` ends it at once with FAIL (something that must not happen did). */
export interface Verdict {
  ok: boolean;
  bad?: boolean;
  saw: string;
}

export interface StoreCheckStep {
  name: string;
  /** What to do on the phone. */
  ask: string;
  /** The account the step watches: the tester (`user`) or the account not on the tester list (`other`). */
  account: 'user' | 'other';
  /** Watched for the whole settle time and passes only if nothing went wrong meanwhile (no change is expected). */
  steady?: boolean;
  check(before: WalletReport, now: WalletReport): Verdict;
}

export class StoreCheckError extends Error {}

const newSince = (before: WalletReport, now: WalletReport) => {
  const last = Math.max(0, ...before.ledger.map((l) => l.id));
  return now.ledger.filter((l) => l.id > last);
};
const balance = (r: WalletReport) => r.wallet.diamonds + r.wallet.bonusDiamonds;
const balanceText = (r: WalletReport) => `balance ${r.wallet.diamonds} + ${r.wallet.bonusDiamonds} bonus`;
const storePlan = (r: WalletReport, plan: string) => r.entitlements.filter((e) => e.plan === plan && e.source === 'store');
const planText = (e: WalletReport['entitlements'][number]) => `${e.entitlement} ${e.live ? 'live' : 'ended'}${e.expiresAt ? ` until ${e.expiresAt}` : ''}${e.store ? ` (${e.store})` : ''}`;
const plansText = (r: WalletReport) => (r.entitlements.length ? r.entitlements.map(planText).join(', ') : 'no plans');

function planLive(plan: string, label: string) {
  return (before: WalletReport, now: WalletReport): Verdict => {
    const live = storePlan(now, plan).filter((e) => e.live);
    const fresh = live.find((e) => !storePlan(before, plan).some((b) => b.entitlement === e.entitlement && b.live && b.expiresAt === e.expiresAt));
    if (fresh) return { ok: true, saw: `${label}: ${planText(fresh)}` };
    if (live.length) return { ok: false, saw: `${label} was already live before this step and has not changed (${live.map(planText).join(', ')}); refund or let it expire first` };
    return { ok: false, saw: `no live ${label} bought in the store yet (${plansText(now)})` };
  };
}

export const STORE_CHECK_STEPS: readonly StoreCheckStep[] = [
  {
    name: 'pack',
    account: 'user',
    ask: 'In the Shop, buy the smallest diamond pack.',
    check(before, now) {
      const credit = newSince(before, now).find((l) => l.reason === 'purchase' && l.delta + l.bonus > 0);
      if (!credit) return { ok: false, saw: `no purchase credit on the ledger yet (${balanceText(now)})` };
      const up = balance(now) - balance(before);
      if (up < credit.delta + credit.bonus) return { ok: false, saw: `a credit of ${credit.delta + credit.bonus} (${credit.ref}) but the balance rose by ${up}` };
      return { ok: true, saw: `+${credit.delta} diamonds${credit.bonus ? ` and ${credit.bonus} bonus` : ''} (${credit.ref}); ${balanceText(now)}` };
    },
  },
  { name: 'subscribe', account: 'user', ask: 'Subscribe to Coach Gold monthly. Check that Pro bots and unlimited Puzzle Rush unlock.', check: planLive('gold', 'Coach Gold') },
  {
    name: 'upgrade',
    account: 'user',
    ask: 'Upgrade to The Four Winds Club. Check that unlimited hand reviews and New club unlock.',
    check: planLive('fourwinds', 'The Four Winds Club'),
  },
  {
    name: 'restore',
    account: 'user',
    steady: true,
    ask: 'On the second phone (or a fresh install), signed in to the same store account and game account, tap Restore purchases. Check that the plans come back.',
    check(before, now) {
      const again = newSince(before, now).filter((l) => l.reason === 'purchase');
      if (again.length) return { ok: false, bad: true, saw: `credited again: ${again.map((l) => `+${l.delta + l.bonus} (${l.ref})`).join(', ')}` };
      const lost = before.entitlements.filter((b) => b.live && !now.entitlements.some((e) => e.entitlement === b.entitlement && e.live));
      if (lost.length) return { ok: false, bad: true, saw: `no longer live: ${lost.map((e) => e.entitlement).join(', ')}` };
      if (balance(now) < balance(before)) return { ok: false, bad: true, saw: `the balance fell: ${balanceText(now)}` };
      return { ok: true, saw: `nothing credited twice, ${balanceText(now)}; ${plansText(now)}` };
    },
  },
  {
    name: 'refund-plan',
    account: 'user',
    ask: 'Refund the Coach Gold charge (iOS: a sandbox or StoreKit refund request; Android: Play Console > Order management > refund the test order).',
    check(before, now) {
      const refund = newSince(before, now).find((l) => l.reason === 'refund' && l.delta === 0 && l.bonus === 0);
      const gold = storePlan(now, 'gold');
      if (!refund) return { ok: false, saw: `no refund on the ledger yet (${plansText(now)})` };
      if (gold.some((e) => e.live)) return { ok: false, saw: `a refund (${refund.ref}) but Coach Gold is still live: ${gold.map(planText).join(', ')}` };
      const keptBefore = storePlan(before, 'fourwinds').filter((e) => e.live);
      const lost = keptBefore.filter((b) => !now.entitlements.some((e) => e.entitlement === b.entitlement && e.live));
      if (lost.length) return { ok: false, bad: true, saw: `the refund also ended ${lost.map((e) => e.entitlement).join(', ')}` };
      return { ok: true, saw: `refund ${refund.ref}; ${gold.map(planText).join(', ') || 'no Coach Gold row'}${keptBefore.length ? `; still live: ${keptBefore.map((e) => e.entitlement).join(', ')}` : ''}` };
    },
  },
  {
    name: 'refund-pack',
    account: 'user',
    ask: 'Refund the diamond pack order the same way.',
    check(before, now) {
      const refund = newSince(before, now).find((l) => l.reason === 'refund' && l.delta + l.bonus < 0);
      if (!refund) return { ok: false, saw: `no refund taking diamonds back yet (${balanceText(now)})` };
      const down = balance(before) - balance(now);
      if (down < -(refund.delta + refund.bonus)) return { ok: false, saw: `a refund of ${-(refund.delta + refund.bonus)} (${refund.ref}) but the balance fell by ${down}` };
      return { ok: true, saw: `${refund.delta + refund.bonus} diamonds (${refund.ref}); ${balanceText(now)}${now.wallet.diamonds < 0 ? ' (below zero: spending is blocked until a purchase covers it)' : ''}` };
    },
  },
  {
    name: 'non-tester',
    account: 'other',
    ask: 'Sign in to the app as the account given with --other-user (NOT on TESTER_USER_IDS) and buy the smallest diamond pack.',
    check(before, now) {
      const credited = newSince(before, now).filter((l) => l.delta + l.bonus > 0);
      if (credited.length || balance(now) > balance(before)) return { ok: false, bad: true, saw: `granted: ${credited.map((l) => `+${l.delta + l.bonus} (${l.ref})`).join(', ') || balanceText(now)}` };
      const seen = new Set(before.storeEvents.map((e) => e.eventId));
      const fresh = now.storeEvents.filter((e) => !seen.has(e.eventId));
      const ignored = fresh.find((e) => e.outcome === 'ignored_sandbox');
      if (ignored) return { ok: true, saw: `${ignored.type} ${ignored.productId ?? ''} recorded as ignored_sandbox; nothing credited (${balanceText(now)})` };
      if (fresh.length) return { ok: false, bad: true, saw: `the purchase arrived as ${fresh.map((e) => `${e.type} ${e.outcome} (${e.environment ?? '?'})`).join(', ')}, not ignored_sandbox` };
      return { ok: false, saw: 'no store event for this account yet' };
    },
  },
];

export interface StoreCheckOptions {
  url: string;
  token: string;
  user: string;
  otherUser?: string;
  only?: string[];
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  /** Shows a step's instruction and resolves when the owner presses Enter. */
  prompt: (step: StoreCheckStep, index: number, count: number) => Promise<void>;
  print?: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface StoreCheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  saw: string;
  ms: number;
}

/** Reads the wallet report. Errors name the status, never the token. */
export async function fetchReport(url: string, token: string, userId: string, fetchFn: typeof fetch = fetch): Promise<WalletReport> {
  const res = await fetchFn(`${new URL(url).origin}/api/admin/users/${encodeURIComponent(userId)}/wallet`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new StoreCheckError('The server refused ADMIN_TOKEN (401)');
  if (res.status === 404) throw new StoreCheckError(`No account ${userId} on this server (404)`);
  if (res.status === 503) throw new StoreCheckError('The server has no ADMIN_TOKEN set (503)');
  if (res.status !== 200) throw new StoreCheckError(`The wallet report answered ${res.status}`);
  return (await res.json()) as WalletReport;
}

export async function runStoreCheck(o: StoreCheckOptions): Promise<{ ok: boolean; steps: StoreCheckResult[] }> {
  const print = o.print ?? ((line: string) => console.log(line));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 120_000;
  const pollMs = o.pollMs ?? 5_000;
  const settleMs = o.settleMs ?? 20_000;
  const steps = STORE_CHECK_STEPS.filter((s) => !o.only || o.only.includes(s.name));
  const read = (account: StoreCheckStep['account']) => fetchReport(o.url, o.token, account === 'user' ? o.user : o.otherUser!, o.fetch);
  // Both accounts are read once before anything is asked: a wrong token or account id stops the run here.
  await read('user');
  if (o.otherUser) await read('other');

  const results: StoreCheckResult[] = [];
  for (const [i, step] of steps.entries()) {
    if (step.account === 'other' && !o.otherUser) {
      results.push({ name: step.name, status: 'SKIP', saw: 'no --other-user given', ms: 0 });
      print(`SKIP ${step.name}: no --other-user given`);
      continue;
    }
    const before = await read(step.account);
    await o.prompt(step, i, steps.length);
    const start = now();
    const limit = step.steady ? settleMs : timeoutMs;
    let verdict: Verdict = { ok: false, saw: 'not read yet' };
    for (;;) {
      try {
        verdict = step.check(before, await read(step.account));
      } catch (e) {
        verdict = { ok: false, saw: (e as Error).message };
      }
      if (verdict.bad) break;
      if (verdict.ok && !step.steady) break;
      if (now() - start >= limit) break;
      await sleep(pollMs);
    }
    const status = verdict.ok && !verdict.bad ? 'PASS' : 'FAIL';
    results.push({ name: step.name, status, saw: verdict.saw, ms: now() - start });
    print(`${status} ${step.name}: ${verdict.saw}`);
  }
  const count = (s: StoreCheckResult['status']) => results.filter((r) => r.status === s).length;
  print(`\nStore check: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  for (const r of results.filter((x) => x.status === 'FAIL')) print(`  FAIL ${r.name}: ${r.saw}`);
  return { ok: count('FAIL') === 0, steps: results };
}

export interface StoreCheckArgs {
  url?: string;
  user?: string;
  otherUser?: string;
  only?: string[];
  timeoutMs?: number;
  pollMs?: number;
  settleMs?: number;
  json: boolean;
}

export function parseArgs(argv: string[]): StoreCheckArgs {
  const out: StoreCheckArgs = { json: false };
  const seconds = (flag: string, v: string | undefined) => {
    const n = Number(v);
    if (!(n > 0)) throw new StoreCheckError(`${flag} takes a number of seconds`);
    return n * 1000;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--other-user') out.otherUser = argv[++i];
    else if (a === '--timeout') out.timeoutMs = seconds(a, argv[++i]);
    else if (a === '--poll') out.pollMs = seconds(a, argv[++i]);
    else if (a === '--settle') out.settleMs = seconds(a, argv[++i]);
    else if (a === '--only') {
      out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = out.only.filter((s) => !STORE_CHECK_STEPS.some((x) => x.name === s));
      if (unknown.length || !out.only.length) throw new StoreCheckError(`--only takes steps from: ${STORE_CHECK_STEPS.map((s) => s.name).join(', ')}`);
    } else throw new StoreCheckError(`Unknown option '${a}'`);
  }
  return out;
}

const USAGE = 'Usage: ADMIN_TOKEN=... npm run store-check -w @mjm/signal -- --url <server> --user <account id> [--other-user <account id>] [--only <step,step>] [--timeout <s>] [--poll <s>] [--settle <s>] [--json]';

async function main(): Promise<void> {
  let args: StoreCheckArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const token = (process.env.ADMIN_TOKEN ?? '').trim();
  if (!args.url || !args.user || !token) {
    console.error(token ? USAGE : `ADMIN_TOKEN is not set in the environment.\n${USAGE}`);
    process.exit(2);
  }
  const rl = createInterface({ input: process.stdin });
  // Lines are buffered, so Enter pressed (or piped) before the question is asked still counts.
  const lines = rl[Symbol.asyncIterator]();
  try {
    console.log(`Store check against ${new URL(args.url).origin} for account ${args.user}${args.otherUser ? ` (non-tester ${args.otherUser})` : ''}\n`);
    const res = await runStoreCheck({
      url: args.url,
      token,
      user: args.user,
      otherUser: args.otherUser,
      only: args.only,
      timeoutMs: args.timeoutMs,
      pollMs: args.pollMs,
      settleMs: args.settleMs,
      prompt: async (step, i, n) => {
        process.stdout.write(`\n[${i + 1}/${n}] ${step.name}: ${step.ask}\nDo this on the phone, then press Enter. `);
        if ((await lines.next()).done) throw new StoreCheckError('The input closed before Enter was pressed');
        console.log(step.steady ? 'Watching the account for changes that must not happen...' : 'Waiting for the server to see it (up to two minutes)...');
      },
    });
    if (args.json) console.log(JSON.stringify(res, null, 2));
    process.exitCode = res.ok ? 0 : 1;
  } catch (e) {
    console.error(e instanceof StoreCheckError ? e.message : `Store check stopped: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
