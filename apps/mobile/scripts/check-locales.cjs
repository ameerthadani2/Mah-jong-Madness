#!/usr/bin/env node
// Every locale directory must carry exactly the same namespace files and keys as en/. Run: npm run i18n:check
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const load = (loc) => {
  const out = {};
  for (const f of fs.readdirSync(path.join(dir, loc)).filter((f) => f.endsWith('.json'))) out[f.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, loc, f), 'utf8'));
  return out;
};
const base = new Set(flatten(load('en')));
let bad = 0;
for (const loc of fs.readdirSync(dir).filter((d) => d !== 'en' && fs.statSync(path.join(dir, d)).isDirectory())) {
  const keys = new Set(flatten(load(loc)));
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  for (const k of missing) console.error(`${loc}: missing ${k}`);
  for (const k of extra) console.error(`${loc}: extra ${k}`);
  bad += missing.length + extra.length;
}
if (bad) {
  console.error(`${bad} locale key problem(s)`);
  process.exit(1);
}
console.log(`locales in sync: ${base.size} keys`);
