const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

let loaded = false;

function loadEnv() {
  if (loaded) return;

  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../../.env'),
    process.resourcesPath ? path.join(process.resourcesPath, '.env') : null
  ].filter(Boolean);

  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    dotenv.config({
      path: envPath,
      override: false,
      debug: process.env.DEBUG_DOTENV === 'true'
    });
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
