/**
 * End-to-end smoke test: serves a web export, plays a full hand through the real UI
 * (tap tiles to discard, answer claims), then opens the hand review and the fair-play audit.
 *
 *   CI=1 npx expo export --platform web --output-dir dist-e2e   (from apps/mobile)
 *   node e2e/play-hand.cjs dist-e2e [screenshot-dir]
 *
 * Exits non-zero if the hand does not finish, a screen fails to open, or the page throws.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'dist-e2e');
const out = path.resolve(process.argv[3] || 'e2e-shots');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'application/javascript', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

// Tap by screen position like a finger: stroked labels are stacked text copies that Playwright's element click refuses.
const tap = async (page, el) => {
  const bb = await el.boundingBox();
  if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
};
const visible = async (page, sel) => {
  const el = await page.$(sel);
  return el && (await el.isVisible().catch(() => false)) ? el : null;
};

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: 'user-e2e-1234567', userSecret: '0123456789abcdef0123456789abcdef', name: 'Tester', avatar: 'panda' }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('[data-testid="start-match"]', { timeout: 30000 });
  await page.click('[data-testid="start-match"]');
  await page.waitForSelector('[data-testid^="tile-"]', { timeout: 15000 });

  const stats = { discards: 0, passes: 0, wins: 0 };
  const started = Date.now();
  while (Date.now() - started < 240000) {
    if (await visible(page, 'text=Next hand')) break;
    let el;
    if ((el = await visible(page, 'text=/胡!/'))) { await tap(page, el); stats.wins++; await page.waitForTimeout(400); continue; }
    if ((el = await visible(page, 'text="過"'))) { await tap(page, el); stats.passes++; await page.waitForTimeout(300); continue; }
    if ((el = await visible(page, 'text="打"'))) { await tap(page, el); stats.discards++; await page.waitForTimeout(300); continue; }
    if (await visible(page, 'text=Tap a tile, tap again to discard')) {
      const boxes = await page.$$eval('[data-testid^="tile-"]:not([data-testid="tile-back"])', (els) =>
        els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      const maxW = Math.max(...boxes.map((b) => b.w));
      const hand = boxes.filter((b) => b.w >= maxW * 0.9).sort((a, b) => b.x - a.x);
      if (hand[0]) await page.mouse.click(hand[0].x + hand[0].w / 2, hand[0].y + hand[0].h / 2);
      await page.waitForTimeout(250);
      continue;
    }
    await page.waitForTimeout(300);
  }

  const finished = !!(await visible(page, 'text=Next hand'));
  await page.screenshot({ path: path.join(out, 'result.png') });
  let reviewOk = false;
  let fairOk = false;
  if (finished) {
    const rv = (await visible(page, 'text=Review my hand')) || (await visible(page, 'text="Review"'));
    if (rv) {
      await tap(page, rv);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(out, 'review.png') });
      reviewOk = !!(await visible(page, 'text=/accuracy|Daily review used/'));
      await page.click('[data-testid="back"]');
      await page.waitForTimeout(800);
    }
    const fp = await visible(page, 'text=/verified/i');
    if (fp) {
      await tap(page, fp);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(out, 'fairness.png') });
      fairOk = !!(await visible(page, 'text=/seed/'));
    }
  }
  const summary = { finished, reviewOk, fairOk, stats, seconds: Math.round((Date.now() - started) / 1000), errors };
  console.log(JSON.stringify(summary));
  await browser.close();
  server.close();
  const ok = finished && reviewOk && fairOk && stats.discards > 0 && errors.length === 0;
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('E2E FAIL', e.message);
  process.exit(1);
});
