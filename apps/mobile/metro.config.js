// The field app sits inside the monorepo but is not one of its npm workspaces: Expo's toolchain
// is not what ships in the containers, so it keeps its own package.json and its own lockfile
// (see scripts/audit.mjs, which audits this tree on its own terms).
//
// It still imports the queue engine by relative path, the way every other app in this repo
// imports packages/engines/*.mjs. Metro only watches the project folder by default, so without
// watchFolders a change to packages/engines/sync-queue.mjs would not reach the running app.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
// The engines are .mjs. Metro does not read that extension by default.
if (!config.resolver.sourceExts.includes('mjs')) config.resolver.sourceExts.push('mjs');

module.exports = config;
