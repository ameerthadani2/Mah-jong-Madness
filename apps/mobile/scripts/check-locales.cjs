#!/usr/bin/env node
// Every locale file must carry exactly the same keys as en.json. Run: npm run i18n:check -w @mjm/mobile
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const base = new Set(flatten(read('en.json')));
let bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
  const keys = new Set(flatten(read(f)));
  const missing = [...base].filter((k) => !keys.has(k));
  const extra = [...keys].filter((k) => !base.has(k));
  for (const k of missing) console.error(`${f}: missing ${k}`);
  for (const k of extra) console.error(`${f}: extra ${k}`);
  bad += missing.length + extra.length;
}
if (bad) {
  console.error(`${bad} locale key problem(s)`);
  process.exit(1);
}
console.log(`locales in sync: ${base.size} keys`);
