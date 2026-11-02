#!/usr/bin/env node
/**
 * Imports avatar art dropped into apps/mobile/assets/avatars/.
 *
 * Name each file after a portrait id (auntie.png, uncle.jpg, grandma.webp …). This script:
 *   1. centre-crops every image to a square and resizes it to 384×384 PNG (ImageMagick),
 *      replacing the original, so huge generator outputs never bloat the app;
 *   2. regenerates src/components/portraits/images.ts so the app uses the image for that id
 *      and keeps the drawn SVG portrait for every id without one.
 * Animated clips named <id>-idle, <id>-win or <id>-lose (.mp4 .mov .webm .m4v .gif, e.g. from an
 * image-to-video AI) are converted with ffmpeg to small looping animated WebP (256×256, 15 fps,
 * idle ≤ 4 s, win/lose ≤ 3 s). Idle loops play in that character's seat; win and lose clips play
 * on those table events.
 * Files whose names are not portrait ids are reported and left alone.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const app = path.join(__dirname, '..');
const dir = path.join(app, 'assets', 'avatars');
const out = path.join(app, 'src', 'components', 'portraits', 'images.ts');
const SIZE = 384;

const avatarsSrc = fs.readFileSync(path.join(app, 'src', 'components', 'Avatars.tsx'), 'utf8');
const m = /AVATAR_IDS = \[([^\]]+)\]/.exec(avatarsSrc);
if (!m) throw new Error('AVATAR_IDS not found in Avatars.tsx');
const IDS = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

fs.mkdirSync(dir, { recursive: true });
const tool = (() => {
  for (const t of ['magick', 'convert']) {
    try {
      execFileSync(t, ['-version'], { stdio: 'ignore' });
      return t;
    } catch {}
  }
  throw new Error('ImageMagick is required (magick or convert)');
})();
const identify = (file) => execFileSync(tool === 'magick' ? 'magick' : 'identify', tool === 'magick' ? ['identify', '-format', '%m %w %h', file] : ['-format', '%m %w %h', file]).toString().trim();

const MOODS = ['idle', 'win', 'lose'];
const CLIP_SIZE = 256;
const clips = {};
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
for (const name of fs.readdirSync(dir).sort()) {
  const ext = path.extname(name).toLowerCase();
  const base = path.basename(name, path.extname(name)).toLowerCase();
  const mm = /^([a-z]+)-(idle|win|lose)$/.exec(base);
  if (!mm) continue;
  const [, id, mood] = mm;
  if (!IDS.includes(id)) {
    console.warn(`skip ${name}: ${id} is not a portrait id`);
    continue;
  }
  const src = path.join(dir, name);
  const dest = path.join(dir, `${id}-${mood}.webp`);
  if (ext === '.webp') {
    // Already animated WebP (ours, or uploaded as-is): keep it.
    if (fs.statSync(src).size > 1.5 * 1024 * 1024) console.warn(`warning: ${name} is over 1.5 MB; upload an .mp4 instead so it can be compressed`);
  } else if (['.mp4', '.mov', '.webm', '.m4v', '.gif'].includes(ext)) {
    if (!hasFfmpeg) throw new Error('ffmpeg is required to convert clips');
    const secs = mood === 'idle' ? 4 : 3;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-t', String(secs), '-vf', `fps=15,crop='min(iw,ih)':'min(iw,ih)',scale=${CLIP_SIZE}:${CLIP_SIZE}:flags=lanczos`, '-an', '-loop', '0', '-c:v', 'libwebp_anim', '-quality', '70', '-compression_level', '6', dest]);
    fs.unlinkSync(src);
    console.log(`imported clip ${name} -> ${id}-${mood}.webp (${Math.round(fs.statSync(dest).size / 1024)} KB)`);
  } else {
    continue;
  }
  clips[id] = { ...(clips[id] || {}), [mood]: `${id}-${mood}.webp` };
}

const found = [];
for (const name of fs.readdirSync(dir).sort()) {
  const ext = path.extname(name).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) continue;
  const id = path.basename(name, path.extname(name)).toLowerCase();
  if (/-(idle|win|lose)$/.test(id)) continue;
  if (!IDS.includes(id)) {
    console.warn(`skip ${name}: not a portrait id (${IDS.join(', ')})`);
    continue;
  }
  const src = path.join(dir, name);
  const dest = path.join(dir, `${id}.png`);
  let info = '';
  try {
    info = identify(src + '[0]');
  } catch (e) {
    console.warn(`skip ${name}: unreadable image`);
    continue;
  }
  const done = src === dest && info === `PNG ${SIZE} ${SIZE}`;
  if (!done) {
    const tmp = path.join(dir, `.${id}.tmp.png`);
    execFileSync(tool, [src + '[0]', '-auto-orient', '-resize', `${SIZE}x${SIZE}^`, '-gravity', 'center', '-extent', `${SIZE}x${SIZE}`, '-strip', tmp]);
    if (src !== dest) fs.unlinkSync(src);
    fs.renameSync(tmp, dest);
    console.log(`imported ${name} -> ${id}.png (${SIZE}x${SIZE}, was ${info})`);
  }
  if (!found.includes(id)) found.push(id);
}

const lines = found.map((id) => `  ${id}: require('../../../assets/avatars/${id}.png'),`);
const clipLines = Object.keys(clips)
  .sort()
  .map((id) => `  ${id}: { ${MOODS.filter((m) => clips[id][m]).map((m) => `${m}: require('../../../assets/avatars/${clips[id][m]}')`).join(', ')} },`);
const ts = `// AUTO-GENERATED by scripts/import-avatars.cjs — do not edit by hand.
// Portrait ids that have image art in assets/avatars/. Ids not listed here use the drawn SVG portrait.
import type { ImageSourcePropType } from 'react-native';

export const PORTRAIT_IMAGES: Partial<Record<string, ImageSourcePropType>> = {${lines.length ? `\n${lines.join('\n')}\n` : ''}};

/** Animated clips per portrait: idle loops in the seat; win and lose play on those table events. */
export const PORTRAIT_CLIPS: Partial<Record<string, Partial<Record<'idle' | 'win' | 'lose', ImageSourcePropType>>>> = {${clipLines.length ? `\n${clipLines.join('\n')}\n` : ''}};
`;
fs.writeFileSync(out, ts);
console.log(`${found.length}/${IDS.length} portraits use image art${found.length ? `: ${found.join(', ')}` : ''}`);
console.log(`${Object.keys(clips).length}/${IDS.length} portraits have animated clips${Object.keys(clips).length ? `: ${Object.entries(clips).map(([id, c]) => `${id} (${Object.keys(c).join('/')})`).join(', ')}` : ''}`);
