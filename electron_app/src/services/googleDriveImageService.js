const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const terminalConsole = global.console;
const workOrdersVerboseTerminalLogs =
  String(process.env.WORK_ORDERS_VERBOSE_LOGS || process.env.WORK_ORDERS_TERMINAL_LOGS || '')
    .trim()
    .toLowerCase() === 'true';
const console = {
  log: (...args) => {
    if (workOrdersVerboseTerminalLogs) terminalConsole.log(...args);
  },
  warn: (...args) => {
    if (workOrdersVerboseTerminalLogs) terminalConsole.warn(...args);
  },
  error: (...args) => terminalConsole.error(...args)
};

function resolveDefaultCachePath() {
  const configured = String(process.env.GOOGLE_DRIVE_IMAGE_CACHE_PATH || '').trim();
  if (configured) return configured;

  try {
    // Prefer Electron userData so dev and packaged app share a stable per-user cache location.
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      const userDataPath = app.getPath('userData');
      if (userDataPath) {
        return path.join(userDataPath, 'image-upload-cache.json');
      }
    }
  } catch (_) {
    // Not running under Electron main process (e.g. node script/test).
  }

  const appDataRoot = process.env.APPDATA || process.env.LOCALAPPDATA || '';
  if (appDataRoot) {
    return path.join(appDataRoot, 'SeymourAutoReporting', 'image-upload-cache.json');
  }

  return path.resolve(process.cwd(), 'data', 'image-upload-cache.json');
}

const CACHE_PATH = resolveDefaultCachePath();
const DEFAULT_DRIVE_SCOPE = process.env.GOOGLE_DRIVE_SCOPE || 'https://www.googleapis.com/auth/drive.file';

let cache = null;
let driveClientPromise = null;
let loggedConfigErrorForRun = false;
let runtimeConfig = {
  driveFolderId: '',
  authClient: null,
  serviceAccountKeyPath: '',
  fallback: '',
  scope: ''
};
let runStats = {
  uploaded: 0,
  cached: 0,
  missing: 0,
  failed: 0
};

function normalizeText(value) {
  return String(value || '').trim();
}

function resolveFallbackMode() {
  const configured = normalizeText(runtimeConfig.fallback || process.env.IMAGE_UPLOAD_FALLBACK || '').toLowerCase();
  return configured === 'internal_path' ? 'internal_path' : 'blank';
}

function resolveConfig() {
  return {
    driveFolderId: normalizeText(runtimeConfig.driveFolderId || process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID || ''),
    authClient: runtimeConfig.authClient || null,
    serviceAccountKeyPath: normalizeText(
      runtimeConfig.serviceAccountKeyPath || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH || ''
    ),
    scope: normalizeText(runtimeConfig.scope || DEFAULT_DRIVE_SCOPE || 'https://www.googleapis.com/auth/drive.file'),
    fallback: resolveFallbackMode()
  };
}

function getDriveConfigStatus() {
  const cfg = resolveConfig();
  if (!cfg.driveFolderId) {
    return { ok: false, message: 'Missing GOOGLE_DRIVE_IMAGE_FOLDER_ID' };
  }
  if (!cfg.authClient && !cfg.serviceAccountKeyPath) {
    return { ok: false, message: 'Missing Google Drive auth client for Work Orders image upload' };
  }
  return { ok: true, message: '', config: cfg };
}

function ensureConfig() {
  const status = getDriveConfigStatus();
  if (!status.ok) throw new Error(status.message);
  return status.config;
}

function setDriveImageRuntimeConfig(nextConfig = {}) {
  runtimeConfig = {
    ...runtimeConfig,
    driveFolderId: normalizeText(nextConfig.driveFolderId || runtimeConfig.driveFolderId || ''),
    authClient: nextConfig.authClient || runtimeConfig.authClient || null,
    serviceAccountKeyPath: normalizeText(nextConfig.serviceAccountKeyPath || runtimeConfig.serviceAccountKeyPath || ''),
    fallback: normalizeText(nextConfig.fallback || runtimeConfig.fallback || ''),
    scope: normalizeText(nextConfig.scope || runtimeConfig.scope || '')
  };
  driveClientPromise = null;
}

function ensureCacheDir() {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadCache() {
  if (cache) return cache;
  ensureCacheDir();
  if (!fs.existsSync(CACHE_PATH)) {
    cache = {};
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    return cache;
  }
  const raw = fs.readFileSync(CACHE_PATH, 'utf8');
  cache = raw ? JSON.parse(raw) : {};
  return cache;
}

function saveCache() {
  ensureCacheDir();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache || {}, null, 2), 'utf8');
}

function normalizeLocalPath(localPath) {
  return String(localPath || '').trim();
}

function parseImagePaths(partPicturesText) {
  if (!partPicturesText) return [];
  return String(partPicturesText)
    .split('|')
    .map(v => v.trim())
    .filter(Boolean);
}

function getMimeType(localPath) {
  const ext = path.extname(localPath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

async function getDriveClient() {
  const cfg = ensureConfig();
  if (driveClientPromise) return driveClientPromise;

  driveClientPromise = (async () => {
    if (cfg.authClient) {
      return google.drive({ version: 'v3', auth: cfg.authClient });
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: cfg.serviceAccountKeyPath,
      scopes: [cfg.scope]
    });
    const authClient = await auth.getClient();
    return google.drive({ version: 'v3', auth: authClient });
  })();

  return driveClientPromise;
}

async function makeFilePublic(fileId) {
  const drive = await getDriveClient();
  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: {
      type: 'anyone',
      role: 'reader'
    }
  });
}

function getPublicDriveUrl(fileId) {
  return `https://drive.google.com/uc?id=${fileId}`;
}

async function uploadFileToDrive(localPath) {
  const cfg = ensureConfig();
  const drive = await getDriveClient();
  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: path.basename(localPath),
      parents: [cfg.driveFolderId]
    },
    media: {
      mimeType: getMimeType(localPath),
      body: fs.createReadStream(localPath)
    },
    fields: 'id,name,webViewLink,webContentLink'
  });

  const fileId = created?.data?.id;
  if (!fileId) throw new Error(`Drive upload did not return file id for ${localPath}`);
  await makeFilePublic(fileId);

  return {
    fileId,
    publicUrl: getPublicDriveUrl(fileId),
    webViewLink: created?.data?.webViewLink || '',
    webContentLink: created?.data?.webContentLink || ''
  };
}

function resetRunStats() {
  runStats = {
    uploaded: 0,
    cached: 0,
    missing: 0,
    failed: 0
  };
  loggedConfigErrorForRun = false;
}

function getRunStats() {
  return { ...runStats };
}

async function uploadImageIfNeeded(localPath) {
  loadCache();
  const normalizedPath = normalizeLocalPath(localPath);
  if (!normalizedPath) return null;

  if (cache[normalizedPath]?.publicUrl) {
    runStats.cached += 1;
    console.log(`[WorkOrders][Drive] Image already cached: ${normalizedPath}`);
    return cache[normalizedPath].publicUrl;
  }

  if (!fs.existsSync(normalizedPath)) {
    runStats.missing += 1;
    console.warn(`[WorkOrders][Drive] Image file not found/inaccessible: ${normalizedPath}`);
    return resolveFallbackMode() === 'internal_path' ? normalizedPath : null;
  }

  try {
    const cfgStatus = getDriveConfigStatus();
    if (!cfgStatus.ok) {
      runStats.failed += 1;
      if (!loggedConfigErrorForRun) {
        loggedConfigErrorForRun = true;
        console.error(`[WorkOrders][Drive] Upload skipped: ${cfgStatus.message}`);
      }
      return resolveFallbackMode() === 'internal_path' ? normalizedPath : null;
    }
    console.log(`[WorkOrders][Drive] Uploading image: ${normalizedPath}`);
    const uploaded = await uploadFileToDrive(normalizedPath);
    cache[normalizedPath] = {
      fileId: uploaded.fileId,
      publicUrl: uploaded.publicUrl,
      webViewLink: uploaded.webViewLink,
      webContentLink: uploaded.webContentLink,
      uploadedAt: new Date().toISOString()
    };
    saveCache();
    runStats.uploaded += 1;
    console.log(`[WorkOrders][Drive] Upload success: ${uploaded.publicUrl}`);
    return uploaded.publicUrl;
  } catch (error) {
    runStats.failed += 1;
    console.error(`[WorkOrders][Drive] Upload failed for ${normalizedPath}: ${error.message}`);
    return resolveFallbackMode() === 'internal_path' ? normalizedPath : null;
  }
}

async function mapWithConcurrency(items, mapper, concurrency = 3) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const maxWorkers = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => worker());
  await Promise.all(workers);
  return results;
}

async function convertPartPicturesToDriveLinks(partPicturesText) {
  const paths = parseImagePaths(partPicturesText);
  if (!paths.length) return '';
  const links = await mapWithConcurrency(paths, uploadImageIfNeeded, 3);
  return links.filter(Boolean).join(' | ');
}

module.exports = {
  convertPartPicturesToDriveLinks,
  parseImagePaths,
  uploadImageIfNeeded,
  uploadFileToDrive,
  makeFilePublic,
  getPublicDriveUrl,
  loadCache,
  saveCache,
  setDriveImageRuntimeConfig,
  getDriveConfigStatus,
  resetRunStats,
  getRunStats
};
