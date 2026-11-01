// After `eas update:configure` (which may switch the policy to appVersion), force the
// SDK-based runtime version so Expo Go can load published updates.
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'app.json');
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
cfg.expo.runtimeVersion = { policy: 'sdkVersion' };
if (process.env.EXPO_OWNER) cfg.expo.owner = process.env.EXPO_OWNER;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('runtimeVersion pinned to sdkVersion; projectId =', cfg.expo.extra && cfg.expo.extra.eas && cfg.expo.extra.eas.projectId);
