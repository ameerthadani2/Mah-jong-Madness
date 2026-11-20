/**
 * Looks for a showcase deal (docs/SCREENSHOTS.md): plays one hand per seed against Beginner bots the way capture.cjs
 * does (the coach's discards, every win taken, every other claim passed) and lists who won and for how many 台, best for
 * the player first. Needs no server.
 * Usage: node find-deal.cjs <webdir> <from> <to> [parallel=3]
 */
const { serve, launch, SEEDED_DEAL, visible, tap, playHand } = require('./lib.cjs');

const [webdir, fromArg, toArg, parArg] = process.argv.slice(2);
const from = Number(fromArg);
const to = Number(toArg);
const parallel = Number(parArg || 3);

async function one(browser, port, seed) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('mjm.profile', JSON.stringify({ userId: '', name: 'Player', avatar: 'lady' }));
    localStorage.setItem('mjm.tapHint', '3');
  });
  await ctx.addInitScript(SEEDED_DEAL);
  const page = await ctx.newPage();
  try {
    await page.goto(`http://localhost:${port}/`);
    await page.waitForSelector('[data-testid="start-match"]', { timeout: 60000 });
    await page.waitForTimeout(1500);
    await page.evaluate((s) => window.__arm(s), seed);
    await tap(page, await visible(page, '[data-testid="start-match"]'));
    await page.waitForSelector('[data-testid^="tile-"]', { timeout: 30000 });
    const r = await playHand(page);
    await page.waitForTimeout(2600);
    const text = r.done ? await page.$eval('[data-testid="result-sheet"]', (e) => e.innerText.replace(/\s+/g, ' ')) : '';
    const tai = r.done ? Number(((await page.$eval('[data-testid="tai-total"]', (e) => e.innerText).catch(() => '')) || '').trim().split(/\s/)[0]) || 0 : 0;
    return { seed, done: r.done, mine: /Player wins|Player 胡牌/.test(text), tai };
  } catch (e) {
    return { seed, error: String(e).slice(0, 200) };
  } finally {
    await ctx.close();
  }
}

(async () => {
  const server = await serve(webdir, 0);
  const port = server.address().port;
  const browser = await launch();
  const seeds = [];
  for (let s = from; s <= to; s++) seeds.push(s);
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < seeds.length) {
        const r = await one(browser, port, seeds[next++]);
        results.push(r);
        console.log(JSON.stringify(r));
      }
    }),
  );
  await browser.close();
  server.close();
  const wins = results.filter((r) => r.mine).sort((a, b) => b.tai - a.tai);
  console.log('\nThe player won', wins.length, 'of', results.length, 'hands. Best seeds:', wins.slice(0, 5).map((r) => `${r.seed} (${r.tai} 台)`).join(', ') || 'none');
})();
