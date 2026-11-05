// Monorepo-aware Metro config: watch the workspace packages and resolve hoisted node_modules.
const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getSentryExpoConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')];
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'ts', 'tsx'])];

module.exports = config;
