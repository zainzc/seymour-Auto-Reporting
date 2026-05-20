const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_IMAGE_FOLDER_ID || '';
const SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH || '';
const CACHE_PATH = process.env.GOOGLE_DRIVE_IMAGE_CACHE_PATH || 'data/image-upload-cache.json';
const FALLBACK = (process.env.IMAGE_UPLOAD_FALLBACK || 'blank').toLowerCase() === 'internal_path'
  ? 'internal_path'
  : 'blank';
const DRIVE_SCOPE = process.env.GOOGLE_DRIVE_SCOPE || 'https://www.googleapis.com/auth/drive.file';

let cache = null;
let driveClientPromise = null;
let runStats = {
  uploaded: 0,
  cached: 0,
  missing: 0,
  failed: 0
};

function ensureConfig() {
  if (!DRIVE_FOLDER_ID) throw new Error('Missing GOOGLE_DRIVE_IMAGE_FOLDER_ID');
  if (!SERVICE_ACCOUNT_KEY_PATH) throw new Error('Missing GOOGLE_DRIVE_SERVICE_ACCOUNT_KEY_PATH');
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
  ensureConfig();
  if (driveClientPromise) return driveClientPromise;

  driveClientPromise = (async () => {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_KEY_PATH,
      scopes: [DRIVE_SCOPE]
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
  const drive = await getDriveClient();
  const created = await drive.files.create({
    requestBody: {
      name: path.basename(localPath),
      parents: [DRIVE_FOLDER_ID]
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
    return FALLBACK === 'internal_path' ? normalizedPath : null;
  }

  try {
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
    return FALLBACK === 'internal_path' ? normalizedPath : null;
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
  resetRunStats,
  getRunStats
};
