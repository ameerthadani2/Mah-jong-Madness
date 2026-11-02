// Extends app.json at build time.
// - EXPO_BASE_URL: serve the web export under a sub-path (GitHub Pages uses /<repo-name>/).
// - SIGNAL_URL: the deployed signaling server (wss://…) baked in as the default for every build.
module.exports = ({ config }) => {
  const out = { ...config, extra: { ...(config.extra || {}) } };
  if (process.env.SIGNAL_URL) out.extra.signalUrl = process.env.SIGNAL_URL;
  if (process.env.EXPO_BASE_URL) out.experiments = { ...(config.experiments || {}), baseUrl: process.env.EXPO_BASE_URL };
  return out;
};
