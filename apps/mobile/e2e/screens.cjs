/**
 * Layout screenshots: serves a web export and captures the main screens at the five reference viewports
 * (phone portrait, phone landscape, small phone landscape, small Android portrait, tablet landscape).
 *
 *   CI=1 npx expo export --platform web --output-dir dist-e2e   (from apps/mobile)
 *   node e2e/screens.cjs dist-e2e [screenshot-dir]
 *   npm run e2e:screens                                           (both steps)
 *
 * Writes <dir>/<width>x<height>-<screen>.png for home, table-mid, table-selected, table-claim (when a claim
 * came up), callout and win-hold (when they came up), result, review, learn, lesson, age-gate (the birth-year
 * question a new player answers before the Shop), shop and settings, plus exit-sheet (the red exit icon's
 * confirmation) and, for each landscape viewport, table-xl (Extra-large tiles).
 * Each viewport plays one hand against bots in its own browser context, all in parallel. Set
 * SCREENS_SIZES=390x844,667x375 to capture a subset.
 * Exits non-zero if a viewport cannot reach the result sheet, the page throws, or a hard check fails (one tap on
 * the exit icon leaves the table, the English claim buttons carry no gloss, an Extra-large hand scrolls or runs
 * off screen, the Shop does not open, a Home card button clips its label).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'dist-e2e');
const out = path.resolve(process.argv[3] || 'e2e-shots');
fs.mkdirSync(out, { recursive: true });

const ALL_SIZES = [
  [390, 844],
  [844, 390],
  [667, 375],
  [360, 740],
  [1024, 768],
];
const wanted = (process.env.SCREENS_SIZES || '').split(',').filter(Boolean);
const SIZES = wanted.length ? ALL_SIZES.filter(([w, h]) => wanted.includes(`${w}x${h}`)) : ALL_SIZES;

const types = { '.html': 'text/html', '.js': 'application/javascript', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.wav': 'audio/wav' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// Tap by screen position like a finger: stroked labels are stacked text copies that Playwright's element click refuses.
const tap = async (page, el) => {
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  const bb = await el.boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  return !!bb;
};
const visible = async (page, sel) => {
  for (const el of await page.$$(sel)) if (await el.isVisible().catch(() => false)) return el;
  return null;
};
const tapSel = async (page, sel, wait = 900) => {
  const el = await visible(page, sel);
  if (!el) return false;
  await tap(page, el);
  await page.waitForTimeout(wait);
  return true;
};

async function run(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const notes = [];
  // Hard checks: any entry fails the run.
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shot = async (name) => page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });

  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  await shot('home');
  // Home's card buttons are as wide as their card: a label (with its icon) wider than the button is cut off at both ends.
  const clipped = await page.evaluate(() => {
    const bad = [];
    for (const id of ['start-match', 'open-clubs', 'open-quickmatch']) {
      const el = [...document.querySelectorAll(`[data-testid="${id}"]`)].find((e) => e.getBoundingClientRect().width > 0);
      if (!el) continue;
      const parts = [...el.querySelectorAll('div[dir="auto"], svg')].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0);
      if (!parts.length) continue;
      const content = Math.max(...parts.map((r) => r.right)) - Math.min(...parts.map((r) => r.left));
      // The button's 3 px border on each side is not room for the label.
      if (content > el.getBoundingClientRect().width - 6) bad.push(`${id} (${Math.round(content)} in ${Math.round(el.getBoundingClientRect().width)})`);
    }
    return bad;
  });
  if (clipped.length) fails.push(`Home buttons clip their label: ${clipped.join(', ')}`);

  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const done = new Set();
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (await visible(page, 'text=Next hand')) break;
    // The feel: a call-out banner, and the winner's hand face up during the hold before the result sheet.
    if (!done.has('win-hold') && (await visible(page, '[data-testid="win-reveal"]'))) { done.add('win-hold'); await page.waitForTimeout(700); await shot('win-hold'); }
    if (!done.has('callout') && (await visible(page, '[data-testid="call-banner"]'))) { done.add('callout'); await shot('callout'); }
    let el;
    if ((el = await visible(page, 'text=/胡!/'))) { await tap(page, el); await page.waitForTimeout(400); continue; }
    if ((el = await visible(page, 'text="過"'))) {
      if (!done.has('claim')) {
        done.add('claim');
        await shot('table-claim');
        // English players see a gloss on the Chinese claim verbs ("Pass 過").
        if (!(await visible(page, '[data-testid="claim-pass"] >> text=Pass'))) fails.push('claim buttons carry no English gloss');
      }
      await tap(page, el);
      await page.waitForTimeout(300);
      continue;
    }
    if ((el = await visible(page, 'text="打"'))) {
      if (discards >= 3 && !done.has('selected')) { done.add('selected'); await shot('table-selected'); }
      await tap(page, el);
      discards++;
      if (discards === 6) { await page.waitForTimeout(900); await shot('table-mid'); done.add('mid'); }
      if (discards === 4 && !done.has('exit-sheet')) {
        // The red exit icon asks first: one tap must not leave the table.
        done.add('exit-sheet');
        await tapSel(page, '[data-testid="leave-table"]', 700);
        if (!(await visible(page, '[data-testid="leave-sheet"]'))) fails.push('exit icon left without asking');
        await shot('exit-sheet');
        await tapSel(page, '[data-testid="leave-stay"]', 500);
        if (!(await visible(page, '[data-testid="leave-table"]'))) fails.push('keep playing did not return to the table');
      }
      await page.waitForTimeout(300);
      continue;
    }
    // My discard turn: the first-game tap hint, or (once it has retired) the hand marked for discarding.
    if ((await visible(page, 'text=Tap a tile, tap again to discard')) || (await visible(page, '[data-testid="hand-discard"]'))) {
      const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) =>
        els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const maxW = Math.max(...boxes.map((b) => b.w));
      // The hand is the row of largest tiles; take the lowest, right-most one (the drawn tile in landscape).
      const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.y - a.y || b.x - a.x);
      if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(300);
  }
  if (!done.has('mid')) await shot('table-mid');
  const finished = !!(await visible(page, 'text=Next hand'));
  await page.waitForTimeout(600);
  await shot('result');
  if (!finished) notes.push('hand did not finish');

  if (finished) {
    if ((await tapSel(page, 'text=Review my hand', 1500)) || (await tapSel(page, 'text="Review"', 1500))) {
      await shot('review');
      await tapSel(page, '[data-testid="back"]', 900);
    } else notes.push('no review button');
    if (!(await tapSel(page, 'text=Leave table', 1200))) {
      await tapSel(page, '[data-testid="leave-table"]', 700);
      await tapSel(page, '[data-testid="leave-confirm"]', 1200);
    }
  }
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 15000 }).catch(() => notes.push('did not return home'));

  if (await tapSel(page, '[data-testid="open-learn"]', 1000)) {
    await shot('learn');
    if (await tapSel(page, 'text="Start"', 1000)) {
      await shot('lesson');
      await tapSel(page, '[data-testid="back"]', 800);
    } else notes.push('no lesson start button');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no learn button');

  if (await tapSel(page, '[data-testid="open-shop"]', 1000)) {
    // A new player is asked their birth year before the Shop opens: capture the question, answer it as an adult.
    if (await visible(page, '[data-testid="age-gate"]')) {
      await shot('age-gate');
      await page.fill('[data-testid="age-year"]', '1990');
      await tapSel(page, '[data-testid="age-continue"]', 1000);
    }
    if (await visible(page, '[data-testid="shop"]')) await shot('shop');
    else fails.push('the Shop did not open from Home (the "shop" screenshot would show another screen)');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no shop button');

  if ((await tapSel(page, '[data-testid="open-settings"]', 1000)) || (await tapSel(page, 'text=Tester', 1000))) {
    await shot('settings');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no settings button');

  await ctx.close();
  return { size: tag, finished, discards, shots: [...done], notes, fails, errors };
}

/**
 * Extra-large tiles in landscape: a table at Settings → Display → Tiles: Extra large, a few turns in, captured as
 * <size>-table-xl.png. Fails if the hand rail scrolls sideways (a hand tile off the rail) or a hand tile is off screen.
 */
async function runXL(browser, port, [w, h]) {
  const tag = `${w}x${h}`;
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
    localStorage.setItem('mjm.display', JSON.stringify({ tileScale: 1.5, textScale: 1.3 }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const started = Date.now();
  while (discards < 5 && Date.now() - started < 90000) {
    if (await visible(page, 'text=Next hand')) break;
    let el;
    if ((el = await visible(page, 'text="過"'))) { await tap(page, el); await page.waitForTimeout(300); continue; }
    if ((el = await visible(page, 'text="打"'))) { await tap(page, el); discards++; await page.waitForTimeout(300); continue; }
    if ((await visible(page, 'text=Tap a tile, tap again to discard')) || (await visible(page, '[data-testid="hand-discard"]'))) {
      const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const maxW = Math.max(...boxes.map((b) => b.w));
      const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.y - a.y || b.x - a.x);
      if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `${tag}-table-xl.png`) });
  if (await page.$('[data-testid="hand-scroll"]')) fails.push('extra-large hand scrolls sideways');
  const off = await page.$$eval('[data-testid="hand"] [data-testid^="tile-"], [data-testid="hand-discard"] [data-testid^="tile-"]', (els) =>
    els.filter((e) => { const r = e.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1; }).length,
  );
  if (off) fails.push(`${off} extra-large hand tiles off screen`);
  await ctx.close();
  return { size: `${tag} xl`, finished: true, discards, shots: ['table-xl'], notes: [], fails, errors };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  // Large tiles in landscape: the landscape viewports again at Extra-large.
  const XL = SIZES.filter(([w, h]) => w > h);
  const results = await Promise.all([
    ...SIZES.map((s) => run(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]}`, finished: false, notes: [e.message], errors: [] }))),
    ...XL.map((s) => runXL(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]} xl`, finished: false, notes: [e.message], errors: [] }))),
  ]);
  for (const r of results) console.log(JSON.stringify(r));
  await browser.close();
  server.close();
  process.exit(results.every((r) => r.finished && r.errors.length === 0 && (r.fails || []).length === 0) ? 0 : 1);
})().catch((e) => {
  console.error('SCREENS FAIL', e.message);
  process.exit(1);
});
