// Extends app.json. EXPO_BASE_URL lets the web export live under a sub-path
// (GitHub Pages serves the project at /<repo-name>/).
module.exports = ({ config }) => {
  const baseUrl = process.env.EXPO_BASE_URL;
  if (!baseUrl) return config;
  return { ...config, experiments: { ...(config.experiments || {}), baseUrl } };
};
