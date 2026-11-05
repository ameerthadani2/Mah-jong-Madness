/**
 * Layout screenshots: serves a web export and captures the main screens at the five reference viewports
 * (phone portrait, phone landscape, small phone landscape, small Android portrait, tablet landscape).
 *
 *   CI=1 npx expo export --platform web --output-dir dist-e2e   (from apps/mobile)
 *   node e2e/screens.cjs dist-e2e [screenshot-dir]
 *   npm run e2e:screens                                           (both steps)
 *
 * Writes <dir>/<width>x<height>-<screen>.png for home, table-mid, table-selected, table-claim (when a claim
 * came up), result, review, learn, lesson, shop and settings. Each viewport plays one hand against bots in
 * its own browser context, all in parallel. Set SCREENS_SIZES=390x844,667x375 to capture a subset.
 * Exits non-zero if a viewport cannot reach the result sheet or the page throws.
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

  await tapSel(page, '[data-testid="start-match"]', 300);
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });
  let discards = 0;
  const done = new Set();
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (await visible(page, 'text=Next hand')) break;
    let el;
    if ((el = await visible(page, 'text=/胡!/'))) { await tap(page, el); await page.waitForTimeout(400); continue; }
    if ((el = await visible(page, 'text="過"'))) {
      if (!done.has('claim')) { done.add('claim'); await shot('table-claim'); }
      await tap(page, el);
      await page.waitForTimeout(300);
      continue;
    }
    if ((el = await visible(page, 'text="打"'))) {
      if (discards >= 3 && !done.has('selected')) { done.add('selected'); await shot('table-selected'); }
      await tap(page, el);
      discards++;
      if (discards === 6) { await page.waitForTimeout(900); await shot('table-mid'); done.add('mid'); }
      await page.waitForTimeout(300);
      continue;
    }
    if (await visible(page, 'text=Tap a tile, tap again to discard')) {
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
    if (!(await tapSel(page, 'text=Leave table', 1200))) await tapSel(page, '[data-testid="leave-table"]', 1200);
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
    await shot('shop');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no shop button');

  if ((await tapSel(page, '[data-testid="open-settings"]', 1000)) || (await tapSel(page, 'text=Tester', 1000))) {
    await shot('settings');
    await tapSel(page, '[data-testid="back"]', 800);
  } else notes.push('no settings button');

  await ctx.close();
  return { size: tag, finished, discards, claim: done.has('claim'), notes, errors };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const results = await Promise.all(SIZES.map((s) => run(browser, port, s).catch((e) => ({ size: `${s[0]}x${s[1]}`, finished: false, notes: [e.message], errors: [] }))));
  for (const r of results) console.log(JSON.stringify(r));
  await browser.close();
  server.close();
  process.exit(results.every((r) => r.finished && r.errors.length === 0) ? 0 : 1);
})().catch((e) => {
  console.error('SCREENS FAIL', e.message);
  process.exit(1);
});
