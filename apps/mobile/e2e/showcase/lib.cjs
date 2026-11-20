/**
 * Shared pieces of the showcase scripts (docs/SCREENSHOTS.md): the static server for the web export, the browser, a
 * seeded deal, and tapping like a finger.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

/**
 * The page origin the scripts serve the web export on. The app keeps its account in the origin's storage, so the boot
 * run and the capture runs must all use the same one (SHOWCASE_PORT, default 19961).
 */
const PORT = Number(process.env.SHOWCASE_PORT || 19961);

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };

/** Serves the web export at `root` on `port` (0: any free port); resolves to the server once it listens. */
function serve(root, port = PORT) {
  const dir = path.resolve(root);
  const server = http.createServer((req, res) => {
    let p = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
    if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** Chromium, at PW_CHROMIUM when set (as the e2e scripts do). */
const launch = (args = []) => chromium.launch({ ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}), args });

/**
 * Init script: randomness is seeded from the moment the page calls `window.__arm(seed)` (just before Play is tapped),
 * so whatever the app draws before that (sign-in, storage, the network) never shifts the deal; and the bots' 650 ms
 * think time (game/session.ts botDelayMs) is cut to 60 ms. Bot moves follow from the deal and the table's state, so a
 * seed deals and plays the same hand at either speed when the player's moves are the same.
 */
const SEEDED_DEAL = () => {
  const origRandom = Math.random.bind(Math);
  const origGetRandomValues = crypto.getRandomValues.bind(crypto);
  let armed = false;
  let a = 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = () => (armed ? next() : origRandom());
  const fill = (arr) => {
    if (!armed) return origGetRandomValues(arr);
    const max = 2 ** (8 * (arr.BYTES_PER_ELEMENT || 1));
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(next() * max);
    return arr;
  };
  Object.defineProperty(crypto, 'getRandomValues', { value: fill, configurable: true, writable: true });
  window.__arm = (seed) => {
    a = seed >>> 0;
    armed = true;
  };
  const setTimeoutOrig = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) => setTimeoutOrig(fn, ms === 650 ? 60 : ms, ...rest);
};

const visible = async (page, sel) => {
  for (const el of await page.$$(sel)) if (await el.isVisible().catch(() => false)) return el;
  return null;
};

// Tap by screen position like a finger: stroked labels are stacked text copies that Playwright's element click refuses.
const tap = async (page, el) => {
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  const bb = await el.boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  return !!bb;
};

/** Taps the first visible match of `sel` (waiting up to 6 s for one), then waits `wait` ms. */
const tapSel = async (page, sel, wait = 900) => {
  for (let i = 0; i < 30; i++) {
    const el = await visible(page, sel);
    if (el) {
      await tap(page, el);
      await page.waitForTimeout(wait);
      return true;
    }
    await page.waitForTimeout(200);
  }
  console.log('  not found:', sel);
  return false;
};

/**
 * The tile in my hand that the coach rings green (given up to 1.6 s to appear), else the lowest, right-most one. Waiting
 * for the ring matters: the fallback depends on the layout, so a phone and a tablet would play different hands.
 */
async function coachTile(page) {
  for (let i = 0; i < 8; i++) {
    const boxes = await page.$$eval('[data-testid="hand-discard"] [data-testid^="tile-"]', (els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        const coach = [...e.querySelectorAll('div')].some((d) => getComputedStyle(d).borderTopColor === 'rgb(53, 208, 74)');
        return { x: r.x, y: r.y, w: r.width, h: r.height, coach };
      }),
    );
    const hand = boxes.filter((b) => b.w > 0).sort((p, q) => q.y - p.y || q.x - p.x);
    const pick = hand.find((b) => b.coach);
    if (pick) return pick;
    if (i === 7) return hand[0];
    await page.waitForTimeout(200);
  }
  return undefined;
}

/**
 * Plays my side of the hand the way the showcase does: every win taken, every other claim passed, and the tile the coach
 * rings discarded. `on(event)` runs before each move ('win', 'claim', 'turn') so the caller can take a picture first.
 */
async function playHand(page, { on = async () => undefined, limitMs = 300000 } = {}) {
  const started = Date.now();
  let discards = 0;
  while (Date.now() - started < limitMs) {
    if (await visible(page, '[data-testid="result-sheet"]')) return { done: true, discards };
    await on('tick', discards);
    let el;
    if ((el = await visible(page, '[data-testid="claim-win"]'))) {
      await on('win', discards);
      el = await visible(page, '[data-testid="claim-win"]');
      if (el) await tap(page, el);
      await page.waitForTimeout(300);
      continue;
    }
    if ((el = await visible(page, '[data-testid="claim-pass"]'))) {
      await on('claim', discards);
      el = await visible(page, '[data-testid="claim-pass"]');
      if (el) await tap(page, el);
      await page.waitForTimeout(250);
      continue;
    }
    if ((el = await visible(page, '[data-testid="claim-discard"]'))) {
      await tap(page, el);
      discards++;
      await page.waitForTimeout(250);
      continue;
    }
    if (await visible(page, '[data-testid="hand-discard"]')) {
      await page.waitForTimeout(200);
      const pick = await coachTile(page);
      await on('turn', discards);
      if (pick) await page.mouse.click(pick.x + pick.w / 2, pick.y + pick.h / 2);
      await page.waitForTimeout(200);
      continue;
    }
    await page.waitForTimeout(150);
  }
  return { done: false, discards };
}

/** A key of the app's locale files, e.g. t('zh', 'learn', 'daily.cta'). */
const LOCALES = path.join(__dirname, '../../src/i18n/locales');
function t(lang, ns, key) {
  const j = JSON.parse(fs.readFileSync(path.join(LOCALES, lang === 'zh' ? 'zh-TW' : 'en', ns + '.json'), 'utf8'));
  return key.split('.').reduce((o, k) => (o ? o[k] : undefined), j);
}

module.exports = { PORT, serve, launch, SEEDED_DEAL, visible, tap, tapSel, coachTile, playHand, t };
