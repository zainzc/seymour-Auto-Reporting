const fs = require('fs');
const { loadEnv } = require('../src/config/loadEnv');
const {
  uploadImageIfNeeded
} = require('../src/services/googleDriveImageService');

async function main() {
  loadEnv();
  const localPath = process.argv[2];
  if (!localPath) {
    throw new Error('Usage: node scripts/test-drive-image-upload.js "\\\\SAWSQL\\PLImages\\Inventory\\1455960_01.jpg"');
  }

  console.log(`[Test] Checking file: ${localPath}`);
  if (!fs.existsSync(localPath)) {
    throw new Error(`File not found or inaccessible: ${localPath}`);
  }

  console.log('[Test] Uploading to Google Drive...');
  const publicUrl = await uploadImageIfNeeded(localPath);
  if (!publicUrl) {
    throw new Error('Upload finished without public URL (check fallback settings).');
  }

  console.log('[Test] Public URL:');
  console.log(publicUrl);
}

main().catch(error => {
  console.error('[Test] Failed:', error.message);
  process.exit(1);
});
