const { loadEnv } = require('../config/loadEnv');
const { runPhase74TitleDescription } = require('../services/phase74TitleDescriptionService');

loadEnv();

function normalizeText(value) {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const getArg = name =>
    argv.find(arg => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') || '';
  return {
    phase74ListingsTable: normalizeText(
      getArg('--listings-table') || process.env.PHASE74_LISTINGS_TABLE || 'eBay Listings (API)'
    ),
    airtableMasterTable: normalizeText(
      getArg('--master-table') || process.env.AIRTABLE_MASTER_TABLE || 'Master Parts Table'
    ),
    openaiApiKey: normalizeText(getArg('--openai-api-key') || process.env.OPENAI_API_KEY || ''),
    openaiModel: normalizeText(getArg('--openai-model') || process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    openaiBaseUrl: normalizeText(getArg('--openai-base-url') || process.env.OPENAI_BASE_URL || ''),
    phase74PromptCacheEnabled:
      normalizeText(getArg('--prompt-cache-enabled') || process.env.PHASE74_PROMPT_CACHE_ENABLED || 'true').toLowerCase() !==
      'false',
    phase74PromptCacheKey: normalizeText(
      getArg('--prompt-cache-key') || process.env.PHASE74_PROMPT_CACHE_KEY || process.env.OPENAI_PROMPT_CACHE_KEY || 'phase74_title_description_v1'
    ),
    phase74TestIpns: normalizeText(getArg('--test-ipns') || process.env.PHASE74_TEST_IPNS || ''),
    phase74MaxListings: Number(getArg('--max-listings') || process.env.PHASE74_MAX_LISTINGS || 0) || 0,
    sampleLimit: Number(getArg('--sample-limit') || process.env.PHASE74_SAMPLE_LIMIT || 20) || 20,
    aiTimeoutMs: Number(getArg('--ai-timeout-ms') || process.env.PHASE74_AI_TIMEOUT_MS || 30000) || 30000,
    aiMaxAttempts: Number(getArg('--ai-max-attempts') || process.env.PHASE74_AI_MAX_ATTEMPTS || 3) || 3
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPhase74TitleDescription(args, progress => {
    const stage = String(progress?.stage || 'running');
    const message = normalizeText(progress?.message);
    if (message) {
      console.log(`[phase74:${stage}] ${message}`);
    } else {
      console.log(`[phase74:${stage}]`);
    }
  });
  console.log('=== Phase 7.4 Summary ===');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Phase 7.4 failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  runPhase74TitleDescription
};
