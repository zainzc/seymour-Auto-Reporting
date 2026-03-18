const { loadEnv } = require('../config/loadEnv');
const { runPhase6Fitment } = require('../services/phase6FitmentService');

loadEnv();

function normalizeText(value) {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
  return {
    phase6ListingsTable: normalizeText(
      getArg('--listings-table') || process.env.PHASE6_LISTINGS_TABLE || 'eBay Listings (API) (Mock)'
    ),
    airtableMasterTable: normalizeText(
      getArg('--master-table') || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
    ),
    openaiApiKey: normalizeText(getArg('--openai-api-key') || process.env.OPENAI_API_KEY || ''),
    openaiModel: normalizeText(getArg('--openai-model') || process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    openaiBaseUrl: normalizeText(getArg('--openai-base-url') || process.env.OPENAI_BASE_URL || ''),
    phase6PromptCacheEnabled:
      normalizeText(getArg('--prompt-cache-enabled') || process.env.PHASE6_PROMPT_CACHE_ENABLED || 'true').toLowerCase() !==
      'false',
    phase6PromptCacheKey: normalizeText(
      getArg('--prompt-cache-key') || process.env.PHASE6_PROMPT_CACHE_KEY || process.env.OPENAI_PROMPT_CACHE_KEY || 'phase6_fitment_v1'
    ),
    phase6TestIpns: normalizeText(getArg('--test-ipns') || process.env.PHASE6_TEST_IPNS || ''),
    phase6MaxIpns: Number(getArg('--max-ipns') || process.env.PHASE6_MAX_IPNS || 0) || 0,
    sampleLimit: Number(getArg('--sample-limit') || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20,
    aiTimeoutMs: Number(getArg('--ai-timeout-ms') || process.env.PHASE6_AI_TIMEOUT_MS || 30000) || 30000,
    aiMaxAttempts: Number(getArg('--ai-max-attempts') || process.env.PHASE6_AI_MAX_ATTEMPTS || 3) || 3
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPhase6Fitment(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[phase6:${stage}] ${message}`);
    } else {
      console.log(`[phase6:${stage}]`);
    }
  });
  console.log('=== Phase 6 Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 6 failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runPhase6Fitment
};
