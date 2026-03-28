const { loadEnv } = require('../config/loadEnv');
const { runPhase72FitmentImage } = require('../services/phase72FitmentImageService');

loadEnv();

function normalizeText(value) {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
  return {
    phase72MasterTable: normalizeText(
      getArg('--master-table') || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
    ),
    phase72DriveFolderId: normalizeText(
      getArg('--drive-folder-id') || process.env.PHASE72_DRIVE_FOLDER_ID || ''
    ),
    phase72TestIpns: normalizeText(getArg('--test-ipns') || process.env.PHASE72_TEST_IPNS || ''),
    phase72MaxIpns: Number(getArg('--max-ipns') || process.env.PHASE72_MAX_IPNS || 0) || 0,
    phase72ForceRegenerate:
      normalizeText(getArg('--force-regenerate') || process.env.PHASE72_FORCE_REGENERATE || 'false').toLowerCase() === 'true',
    sampleLimit: Number(getArg('--sample-limit') || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPhase72FitmentImage(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[phase72:${stage}] ${message}`);
    } else {
      console.log(`[phase72:${stage}]`);
    }
  });
  console.log('=== Phase 7.2 Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 7.2 failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runPhase72FitmentImage
};
