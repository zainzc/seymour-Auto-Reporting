const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

let loaded = false;

function getElectronApp() {
  try {
    return require('electron')?.app || null;
  } catch (_) {
    return null;
  }
}

function getPackagedEnvCandidates() {
  const candidates = [];
  const electronApp = getElectronApp();
  const execDir = process.execPath ? path.dirname(process.execPath) : '';

  if (electronApp && typeof electronApp.getPath === 'function') {
    try {
      candidates.push(path.join(electronApp.getPath('userData'), '.env'));
      candidates.push(path.join(electronApp.getPath('userData'), 'seymour-auto.env'));
    } catch (_) {}
  }

  if (execDir) {
    candidates.push(path.join(execDir, '.env'));
    candidates.push(path.join(execDir, 'seymour-auto.env'));
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, '.env'));
    candidates.push(path.join(process.resourcesPath, 'seymour-auto.env'));
    candidates.push(path.resolve(process.resourcesPath, '..', '.env'));
    candidates.push(path.resolve(process.resourcesPath, '..', 'seymour-auto.env'));
  }

  return candidates;
}

function loadEnv() {
  if (loaded) return;

  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../.env'),
    ...getPackagedEnvCandidates()
  ].filter(Boolean);

  const seen = new Set();
  for (const envPath of candidates) {
    if (seen.has(envPath)) continue;
    seen.add(envPath);
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({
      path: envPath,
      override: false,
      debug: process.env.DEBUG_DOTENV === 'true'
    });
    if (process.env.DEBUG_DOTENV === 'true') {
      console.log(`Loaded environment configuration from ${envPath}`);
    }
    loaded = true;
    return;
  }

  // Final fallback: default dotenv behavior.
  dotenv.config({ debug: process.env.DEBUG_DOTENV === 'true' });
  loaded = true;
}

module.exports = {
  loadEnv
};
