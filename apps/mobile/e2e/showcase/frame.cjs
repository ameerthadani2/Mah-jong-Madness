/**
 * Store-style frames for the showcase (docs/SCREENSHOTS.md): each screenshot in a device frame under a headline, on the
 * app's sky; and a one-image collage per language with the Home screen's logo cut out of its sky.
 * Usage: node frame.cjs <frames.json> <shotsdir> <outdir> <webdir>
 * Writes <outdir>/<name>.png and <outdir>/jpeg/<name>.jpg (quality 90) for each frame, and for each phone frame a Google
 * Play variant at 9:16 too (<name>-play).
 * The headline fonts are the app's own (Lilita One, Fredoka) from the web export; Chinese headlines use Noto Sans TC
 * when NOTO_CSS names its stylesheet (npm pack @fontsource/noto-sans-tc; 900.css), else the system's CJK font.
 */
const fs = require('fs');
const path = require('path');
const { launch } = require('./lib.cjs');

const [specFile, shotsDir, outArg, webdir] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const url = (p) => 'file://' + path.resolve(p);
const shot = (name) => path.join(shotsDir, name);

/** A font file from the web export's bundled Google fonts, e.g. font('lilita-one', 'LilitaOne_400Regular'). */
function font(pkg, prefix) {
  const dir = path.join(webdir, 'assets/__node_modules/@expo-google-fonts', pkg);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const hit = walk(dir).find((f) => path.basename(f).startsWith(prefix) && f.endsWith('.ttf'));
  if (!hit) throw new Error(`font ${prefix} not found in ${dir}`);
  return hit;
}
const FONTS = { lilita: font('lilita-one', 'LilitaOne_400Regular'), fredoka: font('fredoka', 'Fredoka_600SemiBold') };
const NOTO = process.env.NOTO_CSS ? `@import url('${url(process.env.NOTO_CSS)}');` : '';

const css = (lang) => `${NOTO}
@font-face { font-family: Lilita; src: url('${url(FONTS.lilita)}'); }
@font-face { font-family: Fredoka; font-weight: 600; src: url('${url(FONTS.fredoka)}'); }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow: hidden; }
body { position: relative; background: linear-gradient(180deg, #1f8fe6 0%, #3fb2f2 38%, #7fd6f6 72%, #b6f0f0 100%);
  font-family: ${lang === 'zh' ? "'Noto Sans TC'" : 'Lilita'}, 'Noto Sans TC', 'PingFang TC', 'WenQuanYi Zen Hei', sans-serif; }
.rays { position: absolute; inset: 0;
  background: repeating-conic-gradient(from 0deg at 50% -8%, rgba(255,255,255,0.10) 0deg 7deg, rgba(255,255,255,0) 7deg 15deg);
  -webkit-mask-image: linear-gradient(180deg, #000 0%, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0) 100%); }
.cloud { position: absolute; background: #fff; border-radius: 999px; opacity: 0.9; box-shadow: 0 10px 0 rgba(120,190,230,0.35); }
.cloud::before, .cloud::after { content: ''; position: absolute; background: #fff; border-radius: 999px; }
.cloud::before { width: 55%; height: 140%; left: 14%; bottom: 35%; }
.cloud::after { width: 38%; height: 110%; right: 14%; bottom: 40%; }
.hill { position: absolute; left: -10%; right: -10%; bottom: -8%; height: 16%; border-radius: 50% 50% 0 0; opacity: 0.85;
  background: radial-gradient(ellipse at 50% 0%, #9be8d2 0%, #7fdcc4 55%, #6fd0b8 100%); }
.title { color: #fff; text-align: center; line-height: 1.08; font-weight: ${lang === 'zh' ? 900 : 400};
  letter-spacing: ${lang === 'zh' ? '0.02em' : '0.005em'}; -webkit-text-stroke: var(--stroke) #1b2346; paint-order: stroke fill;
  text-shadow: 0 var(--drop) 0 #1b2346, 0 calc(var(--drop) * 2.2) calc(var(--drop) * 2) rgba(10, 30, 70, 0.35); }
.sub { display: inline-block; color: #1b2346; background: #fff8e8; border: var(--sb) solid #1b2346; border-radius: 999px;
  font-family: ${lang === 'zh' ? "'Noto Sans TC'" : 'Fredoka'}, 'Noto Sans TC', 'PingFang TC', 'WenQuanYi Zen Hei', sans-serif;
  font-weight: ${lang === 'zh' ? 700 : 600}; box-shadow: 0 var(--sb) 0 #1b2346; }
.device { position: absolute; background: #141a33; box-shadow: 0 0 0 4px #2b335c inset, 0 50px 90px rgba(8, 30, 70, 0.38), 0 10px 0 #0c1126; }
.device img { display: block; width: 100%; height: 100%; object-fit: cover; }
.screen { overflow: hidden; width: 100%; height: 100%; }
`;

const clouds = (W, H) =>
  [
    [0.06, 0.2, 0.17],
    [0.8, 0.13, 0.14],
    [0.86, 0.55, 0.12],
    [0.02, 0.66, 0.11],
  ]
    .map(([x, y, w]) => `<div class="cloud" style="left:${x * W}px;top:${y * H}px;width:${w * W}px;height:${w * W * 0.32}px"></div>`)
    .join('');

const page = (lang, W, H, extraCss, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css(lang)}${extraCss}</style></head><body style="width:${W}px;height:${H}px"><div class="rays"></div>${clouds(W, H)}<div class="hill"></div>${body}</body></html>`;

const caption = (it) => `<div class="cap"><div class="title">${it.title}</div>${it.sub ? `<div class="sub">${it.sub}</div>` : ''}</div>`;

const device = (src, left, top, sw, sh, bz, radius) =>
  `<div class="device" style="left:${left}px;top:${top}px;width:${sw + 2 * bz}px;height:${sh + 2 * bz}px;border-radius:${radius}px;padding:${bz}px"><div class="screen" style="border-radius:${radius - bz}px"><img src="${url(src)}"></div></div>`;

const SIZES = { phone: [1290, 2796], tablet: [2732, 2048], collage: [3200, 1800], play: [1080, 1920] };

function phoneHtml(it) {
  const [W, H] = SIZES.phone;
  const sw = 940;
  const sh = Math.round((sw * 2796) / 1290);
  const bz = 26;
  const top = H - sh - 2 * bz - 120;
  const zh = it.lang === 'zh';
  const extra = `.cap { position: absolute; left: 70px; right: 70px; top: 0; height: ${top}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; }
  .title { font-size: ${zh ? 112 : 118}px; --stroke: ${zh ? 14 : 16}px; --drop: 9px; } .sub { font-size: 46px; padding: 14px 40px 16px; --sb: 6px; }`;
  return page(it.lang, W, H, extra, caption(it) + device(shot(it.src), (W - sw) / 2 - bz, top, sw, sh, bz, 118));
}

/**
 * Google Play's phone frame. Play takes no phone screenshot more than twice as long as it is wide, and the App Store's
 * phone frame is 2.17:1 (1290 x 2796), so each phone frame also comes as a 9:16 one (1080 x 1920): the same screenshot and
 * caption, the device smaller under the same headline block.
 */
function playHtml(it) {
  const [W, H] = SIZES.play;
  const sh = 1400;
  const sw = Math.round((sh * 1290) / 2796);
  const bz = 18;
  const top = H - sh - 2 * bz - 64;
  const zh = it.lang === 'zh';
  const extra = `.cap { position: absolute; left: 48px; right: 48px; top: 0; height: ${top}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; }
  .title { font-size: ${zh ? 72 : 76}px; --stroke: ${zh ? 9 : 10}px; --drop: 6px; } .sub { font-size: 31px; padding: 9px 26px 11px; --sb: 4px; }`;
  return page(it.lang, W, H, extra, caption(it) + device(shot(it.src), (W - sw) / 2 - bz, top, sw, sh, bz, 80));
}

function tabletHtml(it) {
  const [W, H] = SIZES.tablet;
  const sw = 2240;
  const sh = Math.round((sw * 1668) / 2388);
  const bz = 34;
  const top = H - sh - 2 * bz - 90;
  const extra = `.cap { position: absolute; left: 80px; right: 80px; top: 0; height: ${top}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 26px; }
  .title { font-size: ${it.lang === 'zh' ? 116 : 124}px; --stroke: 16px; --drop: 9px; } .sub { font-size: 48px; padding: 12px 40px 14px; --sb: 6px; }`;
  return page(it.lang, W, H, extra, caption(it) + device(shot(it.src), (W - sw) / 2 - bz, top, sw, sh, bz, 84));
}

function collageHtml(it, logo) {
  const [W, H] = SIZES.collage;
  const sw = 500;
  const sh = Math.round((sw * 2796) / 1290);
  const bz = 16;
  const gap = 70;
  const total = it.srcs.length * (sw + 2 * bz) + (it.srcs.length - 1) * gap;
  const top = H - sh - 2 * bz - 70;
  // The phone at `center` (if any) is the hero: 12% larger and raised; the others alternate a little.
  const phones = it.srcs
    .map((s, i) => {
      const left = (W - total) / 2 + i * (sw + 2 * bz + gap);
      if (i !== it.center) return device(shot(s), left, top + (i % 2 ? -40 : 0), sw, sh, bz, 66);
      const k = 1.12;
      return device(shot(s), left - ((k - 1) * (sw + 2 * bz)) / 2, top - 70, Math.round(sw * k), Math.round(sh * k), bz, 72);
    })
    .join('');
  const extra = `.cap { position: absolute; left: 100px; right: 100px; top: 0; height: ${top - 40}px; display: flex; align-items: center; justify-content: center; gap: 60px; }
  .title { font-size: ${it.lang === 'zh' ? 104 : 112}px; --stroke: 14px; --drop: 8px; text-align: left; } .sub { font-size: 44px; padding: 12px 36px 14px; --sb: 5px; }
  .stack { display: flex; flex-direction: column; gap: 22px; align-items: flex-start; }`;
  const head = `<div class="cap">${logo ? `<img src="${logo}" style="width:760px;flex:none">` : ''}<div class="stack"><div class="title">${it.title}</div>${it.sub ? `<div class="sub">${it.sub}</div>` : ''}</div></div>`;
  return page(it.lang, W, H, extra, head + phones);
}

/**
 * The logo of a Home screenshot with its sky made transparent: the box around the dark outline under the profile card,
 * then a flood fill of sky-blue pixels from the edges of that box (the logo's outline stops it). A data URL.
 */
async function cutLogo(browser, src) {
  const p = await browser.newPage();
  await p.goto(url(src));
  const data = await p.evaluate(async () => {
    const img = document.querySelector('img');
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const scale = c.width / 430;
    const y0 = Math.round(77 * scale);
    const y1 = Math.round(270 * scale);
    const all = g.getImageData(0, y0, c.width, y1 - y0).data;
    let minX = c.width;
    let maxX = 0;
    let minY = y1;
    let maxY = 0;
    for (let y = 0; y < y1 - y0; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        if (all[i] < 60 && all[i + 1] < 70 && all[i + 2] < 110) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y + y0);
          maxY = Math.max(maxY, y + y0);
        }
      }
    }
    const bx = Math.max(0, minX - 28);
    const by = Math.max(0, minY - 28);
    const bw = Math.min(c.width - bx, maxX - minX + 64);
    const bh = Math.min(c.height - by, maxY - minY + 68);
    const box = g.getImageData(bx, by, bw, bh);
    const d = box.data;
    const sky = (k) => d[k + 2] > 170 && d[k + 2] - d[k] > 55 && d[k + 1] > 110;
    const seen = new Uint8Array(bw * bh);
    const queue = [];
    const push = (x, y) => {
      const n = y * bw + x;
      if (!seen[n] && sky(n * 4)) {
        seen[n] = 1;
        queue.push(n);
      }
    };
    for (let x = 0; x < bw; x++) {
      push(x, 0);
      push(x, bh - 1);
    }
    for (let y = 0; y < bh; y++) {
      push(0, y);
      push(bw - 1, y);
    }
    while (queue.length) {
      const n = queue.pop();
      d[n * 4 + 3] = 0;
      const x = n % bw;
      const y = (n - x) / bw;
      if (x > 0) push(x - 1, y);
      if (x < bw - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < bh - 1) push(x, y + 1);
    }
    const o = document.createElement('canvas');
    o.width = bw;
    o.height = bh;
    o.getContext('2d').putImageData(box, 0, 0);
    return o.toDataURL('image/png');
  });
  await p.close();
  return data;
}

/**
 * A frame's PNG must be what the stores take: its size exactly, 8-bit RGB with no alpha (Google Play refuses an alpha
 * channel). Reads the PNG's header (IHDR).
 */
function checkPng(file, [width, height]) {
  const b = fs.readFileSync(file);
  const [w, h, depth, colour] = [b.readUInt32BE(16), b.readUInt32BE(20), b[24], b[25]];
  if (w !== width || h !== height || depth !== 8 || colour !== 2) throw new Error(`${file}: ${w}x${h}, ${depth}-bit, colour type ${colour}; wanted ${width}x${height} 8-bit RGB (type 2) with no alpha`);
}

(async () => {
  const browser = await launch(['--allow-file-access-from-files']);
  const holder = path.join(out, '.logo.html');
  // The repository keeps JPEGs at quality 90 (docs/SCREENSHOTS.md): written beside the PNGs, in <outdir>/jpeg.
  const jpegDir = path.join(out, 'jpeg');
  fs.mkdirSync(jpegDir, { recursive: true });
  // Each phone frame comes twice: the App Store's size, then Google Play's 9:16 (named <out>-play).
  const jobs = spec.flatMap((it) => (it.kind === 'phone' ? [it, { ...it, kind: 'play', out: `${it.out}-play` }] : [it]));
  for (const it of jobs) {
    let logo = null;
    if (it.kind === 'collage' && it.logo) {
      fs.writeFileSync(holder, `<!doctype html><img src="${url(shot(it.logo))}">`);
      logo = await cutLogo(browser, holder);
      fs.unlinkSync(holder);
    }
    const html = it.kind === 'tablet' ? tabletHtml(it) : it.kind === 'collage' ? collageHtml(it, logo) : it.kind === 'play' ? playHtml(it) : phoneHtml(it);
    const tmp = path.join(out, `.${it.out}.html`);
    fs.writeFileSync(tmp, html);
    const [width, height] = SIZES[it.kind];
    const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await p.goto(url(tmp));
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
    await p.screenshot({ path: path.join(out, it.out + '.png') });
    await p.screenshot({ path: path.join(jpegDir, it.out + '.jpg'), type: 'jpeg', quality: 90 });
    await p.close();
    fs.unlinkSync(tmp);
    checkPng(path.join(out, it.out + '.png'), SIZES[it.kind]);
    console.log('framed', it.out);
  }
  await browser.close();
})();
