const AirtableService = require('./airtableService');
const Phase4AiEvaluatorService = require('./phase4AiEvaluatorService');

const DEFAULT_LISTINGS_TABLE = 'eBay Listings (API) (Mock)';
const DEFAULT_MASTER_TABLE = 'Master Parts Table';
const LISTING_DESCRIPTION_FIELD = 'Description';
const LISTING_IPN_FIELD = 'c: partshunter203 ebay MOTORS interchange part number';
const LISTING_TITLE_FIELD = 'Product Title';
const LISTING_CONDITIONS_FIELD = 'c: partshunter203 ebay MOTORS conditions & options';
const MASTER_FITMENT_FIELD = 'Part Fitment';
const MASTER_TIMESTAMP_FIELD = 'Fitment Extraction Timestamp';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function parseIpnList(value) {
  if (Array.isArray(value)) {
    return value.map(item => normalizeIpn(item)).filter(Boolean);
  }
  const text = String(value || '');
  if (!text.trim()) return [];
  return text
    .split(/[\n,\t;|]+/)
    .map(item => normalizeIpn(item))
    .filter(Boolean);
}

function chunkArray(values = [], size = 25) {
  const out = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
}

function formatAirtableError(error) {
  const status = error?.response?.status;
  const payload = error?.response?.data;
  const detail =
    payload?.error?.message ||
    payload?.error ||
    payload?.message ||
    error?.message ||
    String(error);
  return status ? `HTTP ${status}: ${detail}` : String(detail);
}

async function fetchAllRecordsWithFallback(service, tableNameOrId, selectFields = []) {
  try {
    return await service.fetchAllRecords(tableNameOrId, selectFields);
  } catch (error) {
    if (error?.response?.status !== 422) throw error;
    return service.fetchAllRecords(tableNameOrId, []);
  }
}

function escapeAirtableFormulaValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildIpnFilterFormula(ipns = []) {
  const clauses = ipns.map(ipn => `{${LISTING_IPN_FIELD}}="${escapeAirtableFormulaValue(ipn)}"`);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `OR(${clauses.join(',')})`;
}

async function fetchListingRowsByIpnSet(service, tableName, ipns = [], selectFields = []) {
  const rows = [];
  for (const chunk of chunkArray(ipns, 25)) {
    const formula = buildIpnFilterFormula(chunk);
    if (!formula) continue;
    let offset = null;
    do {
      const params = {
        filterByFormula: formula
      };
      if (offset) params.offset = offset;
      if (Array.isArray(selectFields) && selectFields.length > 0) {
        params.fields = selectFields;
      }
      const data = await service.request('GET', `/${encodeURIComponent(tableName)}`, { params });
      rows.push(...(Array.isArray(data?.records) ? data.records : []));
      offset = data?.offset || null;
    } while (offset);
  }
  return rows;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

function htmlToText(html) {
  const raw = String(html || '');
  if (!raw) return '';
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractStrictFitmentBlock(descriptionHtml = '') {
  const html = String(descriptionHtml || '');
  if (!html.trim()) {
    return { status: 'missing_structure', rawFitmentText: '' };
  }

  const headingRegex = /<([a-z0-9]+)\b[^>]*class=["'][^"']*\bd_heading1\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
  const targetHeadingText = 'This Part Will Fit These Makes And Models With These Options';
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html)) !== null) {
    const headingText = htmlToText(headingMatch[2]);
    if (headingText !== targetHeadingText) continue;

    const restHtml = html.slice(headingRegex.lastIndex);
    const siblingRegex =
      /^\s*(?:<!--[\s\S]*?-->\s*)*<([a-z0-9]+)\b[^>]*class=["'][^"']*\bp1\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i;
    const sibling = restHtml.match(siblingRegex);
    if (!sibling) {
      return { status: 'missing_structure', rawFitmentText: '' };
    }

    const rawFitmentText = htmlToText(sibling[2]);
    if (!rawFitmentText) {
      return { status: 'empty_block', rawFitmentText: '' };
    }
    return { status: 'found', rawFitmentText };
  }

  return { status: 'missing_structure', rawFitmentText: '' };
}

function compactText(value, maxLength = 500) {
  const text = normalizeText(value);
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

async function runPhase6Fitment(options = {}, progressCallback = () => {}) {
  const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const masterTable = normalizeText(options.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || DEFAULT_MASTER_TABLE);
  const listingsTable = normalizeText(options.phase6ListingsTable || process.env.PHASE6_LISTINGS_TABLE || DEFAULT_LISTINGS_TABLE);
  const openaiApiKey = normalizeText(options.openaiApiKey || process.env.OPENAI_API_KEY || '');
  const openaiModel = normalizeText(options.openaiModel || process.env.OPENAI_MODEL || 'gpt-4o-mini');
  const openaiBaseUrl = normalizeText(options.openaiBaseUrl || process.env.OPENAI_BASE_URL || '');
  const promptCacheEnabled =
    normalizeText(options.phase6PromptCacheEnabled ?? process.env.PHASE6_PROMPT_CACHE_ENABLED ?? 'true').toLowerCase() !== 'false';
  const promptCacheKey = normalizeText(
    options.phase6PromptCacheKey || process.env.PHASE6_PROMPT_CACHE_KEY || process.env.OPENAI_PROMPT_CACHE_KEY || 'phase6_fitment_v1'
  );
  const sampleLimit = Math.max(5, Number(options.sampleLimit || process.env.PHASE6_SAMPLE_LIMIT || 20) || 20);
  const testIpnList = parseIpnList(options.phase6TestIpns || process.env.PHASE6_TEST_IPNS || '');
  const testIpnSet = new Set(testIpnList);
  const maxIpns = Math.max(0, Number(options.phase6MaxIpns || process.env.PHASE6_MAX_IPNS || 0) || 0);

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!openaiApiKey) throw new Error('Missing OpenAI API key for Phase 6.');

  const airtableService = new AirtableService({
    token: airtableToken,
    baseId: airtableBaseId,
    masterTable
  });
  const aiService = new Phase4AiEvaluatorService({
    apiKey: openaiApiKey,
    model: openaiModel,
    baseUrl: openaiBaseUrl || undefined,
    timeoutMs: Number(options.aiTimeoutMs || process.env.PHASE6_AI_TIMEOUT_MS || 30000) || 30000,
    maxAttempts: Number(options.aiMaxAttempts || process.env.PHASE6_AI_MAX_ATTEMPTS || 3) || 3,
    baseDelayMs: 600,
    promptCacheEnabled,
    promptCacheKey
  });

  const summary = {
    listingsTable,
    masterTable,
    phase6TestIpnsCount: testIpnSet.size,
    phase6MaxIpns: maxIpns,
    listingRowsScanned: 0,
    listingRowsWithHTML: 0,
    listingRowsWithIPN: 0,
    masterPartsMatched: 0,
    masterPartsAlreadyHadFitment: 0,
    fitmentBlocksFound: 0,
    fitmentBlocksEmpty: 0,
    fitmentBlocksMissingStructure: 0,
    fitmentRewriteSucceeded: 0,
    fitmentRewriteFailed: 0,
    masterPartsUpdated: 0,
    sampleRawExtracted: [],
    sampleRewritten: [],
    sampleSkipped: [],
    errors: []
  };
  let attemptedUniqueIpns = 0;

  emitProgress(progressCallback, {
    stage: 'phase6_load_master',
    percent: 8,
    counts: summary,
    message: `Loading Master Parts records from '${masterTable}'...`
  });

  const masterRows = await fetchAllRecordsWithFallback(airtableService, masterTable, ['IPN', MASTER_FITMENT_FIELD]);
  const masterByIpn = new Map();
  for (const row of masterRows) {
    const ipn = normalizeIpn(row?.fields?.IPN);
    if (!ipn || masterByIpn.has(ipn)) continue;
    masterByIpn.set(ipn, row);
  }

  emitProgress(progressCallback, {
    stage: 'phase6_scan_listings',
    percent: 20,
    counts: summary,
    message: `Loading listing HTML records from '${listingsTable}'...`
  });

  const listingSelectFields = [
    LISTING_DESCRIPTION_FIELD,
    LISTING_IPN_FIELD,
    LISTING_TITLE_FIELD,
    LISTING_CONDITIONS_FIELD
  ];
  const listingRows =
    testIpnSet.size > 0
      ? await fetchListingRowsByIpnSet(airtableService, listingsTable, Array.from(testIpnSet), listingSelectFields)
      : await fetchAllRecordsWithFallback(airtableService, listingsTable, listingSelectFields);
  summary.listingRowsScanned = listingRows.length;

  const processedIpns = new Set();
  let lastProgressAt = Date.now();

  for (let i = 0; i < listingRows.length; i += 1) {
    const row = listingRows[i];
    const fields = row?.fields || {};
    const descriptionHtml = normalizeText(fields[LISTING_DESCRIPTION_FIELD]);
    if (!descriptionHtml) continue;
    summary.listingRowsWithHTML += 1;

    const ipn = normalizeIpn(fields[LISTING_IPN_FIELD]);
    if (!ipn) continue;
    summary.listingRowsWithIPN += 1;
    if (testIpnSet.size > 0 && !testIpnSet.has(ipn)) continue;

    if (processedIpns.has(ipn)) continue;
    processedIpns.add(ipn);
    attemptedUniqueIpns += 1;
    if (maxIpns > 0 && attemptedUniqueIpns > maxIpns) break;

    const master = masterByIpn.get(ipn);
    if (!master) {
      if (summary.sampleSkipped.length < sampleLimit) {
        summary.sampleSkipped.push(`ipn='${ipn}' skipped: master part not found`);
      }
      continue;
    }
    summary.masterPartsMatched += 1;

    const existingFitment = normalizeText(master?.fields?.[MASTER_FITMENT_FIELD]);
    if (existingFitment) {
      summary.masterPartsAlreadyHadFitment += 1;
      if (summary.sampleSkipped.length < sampleLimit) {
        summary.sampleSkipped.push(`ipn='${ipn}' skipped: existing Part Fitment already populated`);
      }
      continue;
    }

    emitProgress(progressCallback, {
      stage: 'phase6_extract_fitment',
      percent: Math.min(70, 20 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 50)),
      counts: summary,
      message: `Extracting fitment block for IPN '${ipn}' (${i + 1}/${listingRows.length})...`
    });

    const extraction = extractStrictFitmentBlock(descriptionHtml);
    if (extraction.status === 'missing_structure') {
      summary.fitmentBlocksMissingStructure += 1;
      if (summary.sampleSkipped.length < sampleLimit) {
        summary.sampleSkipped.push(`ipn='${ipn}' skipped: required d_heading1 + immediate .p1 structure not found`);
      }
      continue;
    }
    if (extraction.status === 'empty_block') {
      summary.fitmentBlocksEmpty += 1;
      if (summary.sampleSkipped.length < sampleLimit) {
        summary.sampleSkipped.push(`ipn='${ipn}' skipped: extracted .p1 fitment block was empty`);
      }
      continue;
    }

    summary.fitmentBlocksFound += 1;
    if (summary.sampleRawExtracted.length < sampleLimit) {
      summary.sampleRawExtracted.push(`ipn='${ipn}' raw='${compactText(extraction.rawFitmentText, 240)}'`);
    }

    emitProgress(progressCallback, {
      stage: 'phase6_rewrite_fitment',
      percent: Math.min(85, 70 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 15)),
      counts: summary,
      message: `Rewriting fitment text via AI for IPN '${ipn}'...`
    });

    let rewritten = '';
    try {
      const result = await aiService.rewriteFitment({
        ipn,
        productTitle: fields[LISTING_TITLE_FIELD],
        conditionsAndOptions: fields[LISTING_CONDITIONS_FIELD],
        rawFitmentText: extraction.rawFitmentText
      });
      rewritten = normalizeText(result?.fitment);
    } catch (error) {
      summary.fitmentRewriteFailed += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' rewrite failed: ${error.message}`);
      }
      continue;
    }

    if (!rewritten) {
      summary.fitmentRewriteFailed += 1;
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' rewrite returned empty text`);
      }
      continue;
    }
    summary.fitmentRewriteSucceeded += 1;

    emitProgress(progressCallback, {
      stage: 'phase6_write_master',
      percent: Math.min(97, 85 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 12)),
      counts: summary,
      message: `Writing rewritten fitment to Master Parts for IPN '${ipn}'...`
    });

    try {
      await airtableService.request('PATCH', `/${encodeURIComponent(masterTable)}`, {
        data: {
          records: [
            {
              id: master.id,
              fields: {
                [MASTER_FITMENT_FIELD]: rewritten,
                [MASTER_TIMESTAMP_FIELD]: new Date().toISOString()
              }
            }
          ],
          typecast: true
        }
      });
      summary.masterPartsUpdated += 1;
      master.fields[MASTER_FITMENT_FIELD] = rewritten;
      if (summary.sampleRewritten.length < sampleLimit) {
        summary.sampleRewritten.push(`ipn='${ipn}' rewritten='${compactText(rewritten, 240)}'`);
      }
    } catch (error) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' writeback failed: ${formatAirtableError(error)}`);
      }
    }

    const now = Date.now();
    if (i === 0 || i + 1 === listingRows.length || now - lastProgressAt >= 10000) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'phase6_scan_listings',
        percent: Math.min(95, 20 + Math.floor(((i + 1) / Math.max(1, listingRows.length)) * 70)),
        counts: summary,
        message:
          `Phase 6 progress ${i + 1}/${listingRows.length}: matched=${summary.masterPartsMatched}, ` +
          `found=${summary.fitmentBlocksFound}, rewritten=${summary.fitmentRewriteSucceeded}, updated=${summary.masterPartsUpdated}`
      });
    }
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `Phase 6 completed. Updated Master Parts fitment=${summary.masterPartsUpdated}.`
  });
  return summary;
}

module.exports = {
  runPhase6Fitment
};
