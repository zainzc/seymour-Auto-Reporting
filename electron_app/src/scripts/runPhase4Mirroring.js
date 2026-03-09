const { loadEnv } = require('../config/loadEnv');
const { runPhase4Mirroring } = require('../services/phase4MirroringService');

loadEnv();

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const summary = await runPhase4Mirroring({ phase4DryRun: dryRun }, progress => {
    const stage = String(progress?.stage || 'unknown');
    const message = String(progress?.message || '').trim();
    if (message) {
      console.log(`[phase4:${stage}] ${message}`);
    } else {
      console.log(`[phase4:${stage}]`);
    }
  });

  console.log('\n=== Phase 4 Mirroring Summary ===');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 4 mirroring failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
