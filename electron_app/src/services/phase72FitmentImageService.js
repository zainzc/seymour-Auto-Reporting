const { Readable } = require('stream');
const { google } = require('googleapis');
const AirtableService = require('./airtableService');
const AirtableSchemaService = require('./airtableSchemaService');
const oauth2Service = require('./oauth2Service');

const DEFAULT_MASTER_TABLE = 'Master Parts Table';
const MASTER_IPN_FIELD = 'IPN';
const MASTER_FITMENT_FIELD = 'Part Fitment';
const MASTER_FITMENT_IMAGE_FIELD = 'Fitment Image';
const SVG_WIDTH = 1200;
const CONTENT_SIDE_PADDING = 96;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function emitProgress(progressCallback, payload = {}) {
  if (typeof progressCallback === 'function') {
    progressCallback(payload);
  }
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

function escapeAirtableFormulaValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildIpnFilterFormula(ipns = []) {
  const clauses = ipns.map(ipn => `{${MASTER_IPN_FIELD}}="${escapeAirtableFormulaValue(ipn)}"`);
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  return `OR(${clauses.join(',')})`;
}

async function fetchAllRecordsWithFallback(service, tableNameOrId, selectFields = []) {
  try {
    return await service.fetchAllRecords(tableNameOrId, selectFields);
  } catch (error) {
    if (error?.response?.status !== 422) throw error;
    return service.fetchAllRecords(tableNameOrId, []);
  }
}

async function fetchMasterRowsByIpnSet(service, tableName, ipns = [], selectFields = []) {
  const rows = [];
  for (const batch of chunkArray(ipns, 25)) {
    const formula = buildIpnFilterFormula(batch);
    if (!formula) continue;
    let offset = null;
    do {
      const params = { filterByFormula: formula };
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

function sanitizeFilename(value) {
  const safe = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'unknown';
}

function extractDriveFolderId(input) {
  const text = normalizeText(input);
  if (!text) return '';
  if (/^[a-zA-Z0-9_-]{20,}$/.test(text)) return text;
  const foldersMatch = text.match(/\/folders\/([a-zA-Z0-9_-]{20,})/);
  if (foldersMatch?.[1]) return foldersMatch[1];
  const idMatch = text.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idMatch?.[1]) return idMatch[1];
  return '';
}

function buildGoogleDriveFileLinks(fileId) {
  const cleanId = normalizeText(fileId);
  return {
    lh3Url: `https://lh3.googleusercontent.com/d/${cleanId}`,
    viewUrl: `https://drive.google.com/file/d/${cleanId}/view?usp=sharing`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${cleanId}`
  };
}

async function uploadFitmentSvgToDrive(drive, folderId, fileName, svgContent) {
  const body = Readable.from(Buffer.from(String(svgContent || ''), 'utf8'));
  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'image/svg+xml'
    },
    media: {
      mimeType: 'image/svg+xml',
      body
    },
    fields: 'id,name'
  });
  const fileId = normalizeText(created?.data?.id);
  if (!fileId) {
    throw new Error('Drive upload succeeded but no file ID was returned.');
  }

  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: {
      type: 'anyone',
      role: 'reader'
    }
  });

  return {
    fileId,
    ...buildGoogleDriveFileLinks(fileId)
  };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function splitLines(text = '') {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function splitFitmentApplicationsRaw(text = '') {
  const normalized = String(text || '')
    .replace(/^compatible with:\s*/i, '')
    .replace(/\r/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\.\s+(?=[A-Z])/g, '.\n')
    .replace(/\s+(?=ALSO FITS\b)/gi, '\n')
    .replace(/^\s*[-*]\s+/gm, '\n')
    .replace(/\s*\|\s*/g, '\n');

  const explicitLines = normalized
    .split(/\n+/)
    .map(line => normalizeText(line))
    .filter(Boolean);

  const splitCommaBeforeYear = line => {
    const out = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '(') depth += 1;
      if (ch === ')' && depth > 0) depth -= 1;

      if (ch === ',' && depth === 0) {
        const rest = line.slice(i + 1).trim();
        if (/^\d{4}(?:-\d{4})?\b/.test(rest)) {
          const piece = normalizeText(current);
          if (piece) out.push(piece);
          current = '';
          continue;
        }
      }
      current += ch;
    }
    const tail = normalizeText(current);
    if (tail) out.push(tail);
    return out;
  };

  const out = [];
  for (const line of explicitLines) {
    const commaChunks = line.includes('),')
      ? line
          .split(/\)\s*,\s+(?=[A-Za-z])/)
          .map((chunk, idx, arr) => (idx < arr.length - 1 ? `${chunk})` : chunk))
      : [line];
    const splitBySemicolon = commaChunks
      .flatMap(chunk => chunk.split(/\s*;\s+/))
      .map(part => normalizeText(part))
      .filter(Boolean);
    for (const part of splitBySemicolon) {
      const compact = normalizeText(part);
      if (!compact) continue;
      const candidates = splitCommaBeforeYear(compact);
      if (candidates.length > 0) {
        out.push(...candidates);
      } else {
        out.push(compact);
      }
    }
  }
  return Array.from(new Set(out));
}

function normalizePositionBlock(text = '') {
  const original = normalizeText(text);
  if (!original) return { text: '', normalized: false };
  const upper = original.toUpperCase();
  const originalUpper = upper;
  let normalized = upper
    .replace(/\bRH\b/g, 'PASSENGER (RIGHT)')
    .replace(/\bR\b/g, 'PASSENGER (RIGHT)')
    .replace(/\bLH\b/g, 'DRIVER (LEFT)')
    .replace(/\bL\b/g, 'DRIVER (LEFT)');
  normalized = normalized
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
  return { text: normalized, normalized: normalized !== originalUpper };
}

function extractPositionCandidates(fitmentText = '') {
  const text = normalizeText(fitmentText);
  if (!text) return [];
  const matches = [];
  const tokenRegexes = [
    /\b(RH|LH|R|L)\b/gi,
    /\b(PASSENGER\s*\(RIGHT\)|DRIVER\s*\(LEFT\)|PASSENGER|DRIVER|RIGHT|LEFT)\b/gi,
    /\b([A-Z]+(?:\s+[A-Z]+){0,3}\s+MOUNTED)\b/gi
  ];
  for (const regex of tokenRegexes) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const token = normalizeText(match[1] || match[0]).toUpperCase();
      if (token) matches.push(token);
    }
  }
  return Array.from(new Set(matches));
}

function stripPositionTokens(line = '') {
  return normalizeText(
    String(line || '')
      .replace(/\b(RH|LH|R|L)\b/gi, '')
      .replace(/\b(PASSENGER\s*\(RIGHT\)|DRIVER\s*\(LEFT\)|PASSENGER|DRIVER|RIGHT|LEFT)\b/gi, '')
      .replace(/\b([A-Z]+(?:\s+[A-Z]+){0,3}\s+MOUNTED)\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[-,;:]\s*$/, '')
  );
}

function parseFitmentApplications(fitmentText = '') {
  const lines = splitFitmentApplicationsRaw(fitmentText);
  if (lines.length === 0) {
    return {
      applications: [],
      positionBlock: '',
      positionNormalized: false
    };
  }

  const rawPositions = extractPositionCandidates(lines.join(' '));
  const normalizedPositions = rawPositions
    .map(item => normalizePositionBlock(item))
    .map(item => item.text)
    .filter(Boolean);
  let uniquePosition = Array.from(new Set(normalizedPositions));
  const hasDriver = uniquePosition.includes('DRIVER');
  const hasLeft = uniquePosition.includes('LEFT');
  const hasPassenger = uniquePosition.includes('PASSENGER');
  const hasRight = uniquePosition.includes('RIGHT');
  if (hasDriver && hasLeft) {
    uniquePosition = uniquePosition.filter(v => v !== 'DRIVER' && v !== 'LEFT');
    if (!uniquePosition.includes('DRIVER (LEFT)')) {
      uniquePosition.push('DRIVER (LEFT)');
    }
  }
  if (hasPassenger && hasRight) {
    uniquePosition = uniquePosition.filter(v => v !== 'PASSENGER' && v !== 'RIGHT');
    if (!uniquePosition.includes('PASSENGER (RIGHT)')) {
      uniquePosition.push('PASSENGER (RIGHT)');
    }
  }
  if (!hasDriver && uniquePosition.includes('LEFT')) {
    uniquePosition = uniquePosition.filter(v => v !== 'LEFT');
    if (!uniquePosition.includes('DRIVER (LEFT)')) {
      uniquePosition.push('DRIVER (LEFT)');
    }
  }
  if (!hasPassenger && uniquePosition.includes('RIGHT')) {
    uniquePosition = uniquePosition.filter(v => v !== 'RIGHT');
    if (!uniquePosition.includes('PASSENGER (RIGHT)')) {
      uniquePosition.push('PASSENGER (RIGHT)');
    }
  }
  const positionBlock = uniquePosition.join(' / ');
  const positionNormalized = rawPositions.some(token => {
    const result = normalizePositionBlock(token);
    return result.normalized;
  });

  const applications = lines
    .map(line => stripPositionTokens(line))
    .filter(Boolean)
    .map(line => line.toUpperCase());

  const dedupedApplications = Array.from(new Set(applications));

  return {
    applications: dedupedApplications,
    positionBlock: normalizeText(positionBlock),
    positionNormalized
  };
}

function wrapTextByChars(text = '', maxChars = 30) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((`${current} ${word}`).length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function takeWithOverflow(lines = [], maxLines = 10) {
  if (!Array.isArray(lines) || lines.length <= maxLines) {
    return { lines: Array.isArray(lines) ? lines : [], overflow: false };
  }
  return { lines: lines.slice(0, maxLines), overflow: true };
}

function getMultiLineMetrics(lineCount = 0) {
  if (lineCount <= 10) return { fontSize: 34, lineHeight: 40 };
  if (lineCount <= 14) return { fontSize: 32, lineHeight: 38 };
  if (lineCount <= 18) return { fontSize: 30, lineHeight: 36 };
  if (lineCount <= 24) return { fontSize: 28, lineHeight: 33 };
  if (lineCount <= 30) return { fontSize: 26, lineHeight: 31 };
  return { fontSize: 24, lineHeight: 29 };
}

function buildSvgTextElements(
  lines = [],
  startY = 300,
  lineHeight = 48,
  fontSize = 44,
  fontWeight = 800,
  options = {}
) {
  const x = Number(options.x || 600);
  const anchor = options.anchor || 'middle';
  const elements = [];
  let y = startY;
  for (const line of lines) {
    elements.push(
      `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial Narrow, Arial, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="#111111">${escapeXml(line)}</text>`
    );
    y += lineHeight;
  }
  return { svg: elements.join('\n'), endY: y };
}

function createStandardizedFitmentSvg(fitmentText, parsed) {
  const subheader = 'THIS PART IS COMPATIBLE WITH:';
  const applications = Array.isArray(parsed?.applications) ? parsed.applications : [];
  const fallbackRaw = splitLines(fitmentText).map(line => line.toUpperCase());
  const baseApplications = applications.length > 0 ? applications : fallbackRaw;
  const isSingle = baseApplications.length <= 1;
  const positionBlock = normalizeText(parsed?.positionBlock).toUpperCase();

  const appStartY = isSingle ? 365 : 330;
  const appBottomY = 1120;
  const usableWidth = SVG_WIDTH - CONTENT_SIDE_PADDING * 2;

  const buildLinesForFont = fontSize => {
    const avgCharWidth = Math.max(6, fontSize * 0.56);
    const maxChars = Math.max(12, Math.floor(usableWidth / avgCharWidth));
    const appLines = isSingle
      ? wrapTextByChars(baseApplications[0] || '', Math.max(12, maxChars - 2))
      : baseApplications.flatMap(item => {
          const wrapped = wrapTextByChars(item, Math.max(12, maxChars - 4));
          if (wrapped.length === 0) return [];
          const [first, ...rest] = wrapped;
          return [`- ${first}`, ...rest.map(line => `  ${line}`)];
        });
    const posChars = Math.max(10, Math.floor(maxChars * 0.9));
    const positionLines = positionBlock ? wrapTextByChars(positionBlock, posChars) : [];
    return { appLines, positionLines };
  };

  const fontCandidates = isSingle
    ? [62, 58, 54, 50, 46, 42, 38, 34, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12]
    : [34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12];

  let appFont = fontCandidates[fontCandidates.length - 1];
  let appLineHeight = Math.max(14, Math.floor(appFont * (isSingle ? 1.14 : 1.16)));
  let positionFont = Math.max(12, appFont - 2);
  let positionLineHeight = Math.max(14, Math.floor(positionFont * 1.12));
  let appLines = [];
  let positionLines = [];
  let positionGap = 24;

  for (const candidateFont of fontCandidates) {
    const candidateAppLineHeight = Math.max(14, Math.floor(candidateFont * (isSingle ? 1.14 : 1.16)));
    const candidatePositionFont = Math.max(12, candidateFont - 2);
    const candidatePositionLineHeight = Math.max(14, Math.floor(candidatePositionFont * 1.12));
    const candidateGap = positionBlock ? Math.max(12, Math.floor(candidateFont * 0.45)) : 0;
    const candidate = buildLinesForFont(candidateFont);
    const totalHeight =
      candidate.appLines.length * candidateAppLineHeight +
      (candidate.positionLines.length > 0
        ? candidateGap + candidate.positionLines.length * candidatePositionLineHeight
        : 0);
    if (appStartY + totalHeight <= appBottomY) {
      appFont = candidateFont;
      appLineHeight = candidateAppLineHeight;
      positionFont = candidatePositionFont;
      positionLineHeight = candidatePositionLineHeight;
      appLines = candidate.appLines;
      positionLines = candidate.positionLines;
      positionGap = candidateGap;
      break;
    }
    appFont = candidateFont;
    appLineHeight = candidateAppLineHeight;
    positionFont = candidatePositionFont;
    positionLineHeight = candidatePositionLineHeight;
    appLines = candidate.appLines;
    positionLines = candidate.positionLines;
    positionGap = candidateGap;
  }

  const applicationSection = buildSvgTextElements(
    appLines,
    appStartY,
    appLineHeight,
    appFont,
    900,
    isSingle
      ? { x: SVG_WIDTH / 2, anchor: 'middle' }
      : { x: CONTENT_SIDE_PADDING, anchor: 'start' }
  );
  const positionY = applicationSection.endY + positionGap;
  const positionSection = buildSvgTextElements(positionLines, positionY, positionLineHeight, positionFont, 900);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200">
  <defs>
    <filter id="grain" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" stitchTiles="stitch" result="noise"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer>
        <feFuncA type="table" tableValues="0 0.12"/>
      </feComponentTransfer>
    </filter>
  </defs>
  <rect x="0" y="0" width="1200" height="1200" fill="#E3C028"/>
  <rect x="0" y="0" width="1200" height="1200" filter="url(#grain)"/>
  <rect x="38" y="38" width="1124" height="1124" fill="none" stroke="#111111" stroke-width="22" rx="30"/>

  <text x="600" y="182" text-anchor="middle" font-family="Arial Narrow, Arial, sans-serif" font-size="156" font-weight="900" fill="#111111" letter-spacing="2">FITS</text>
  <text x="600" y="260" text-anchor="middle" font-family="Arial Narrow, Arial, sans-serif" font-size="44" font-weight="800" fill="#111111">${escapeXml(subheader)}</text>

  ${applicationSection.svg}
  ${positionSection.svg}
</svg>`;
}

async function runPhase72FitmentImage(options = {}, progressCallback = () => {}) {
  const airtableToken = normalizeText(options.airtableToken || process.env.AIRTABLE_TOKEN || '');
  const airtableBaseId = normalizeText(options.airtableBaseId || process.env.AIRTABLE_BASE_ID || '');
  const masterTable = normalizeText(options.phase72MasterTable || options.airtableMasterTable || process.env.AIRTABLE_MASTER_TABLE || DEFAULT_MASTER_TABLE);
  const phase72DriveFolderIdRaw = normalizeText(
    options.phase72DriveFolderId || process.env.PHASE72_DRIVE_FOLDER_ID || ''
  );
  const phase72DriveFolderId = extractDriveFolderId(phase72DriveFolderIdRaw);
  const testIpnList = parseIpnList(options.phase72TestIpns || process.env.PHASE72_TEST_IPNS || '');
  const testIpnSet = new Set(testIpnList);
  const maxIpns = Math.max(0, Number(options.phase72MaxIpns || process.env.PHASE72_MAX_IPNS || 0) || 0);
  const forceRegenerate =
    normalizeText(options.phase72ForceRegenerate ?? process.env.PHASE72_FORCE_REGENERATE ?? 'false').toLowerCase() === 'true';
  const sampleLimit = Math.max(5, Number(options.sampleLimit || process.env.PHASE72_SAMPLE_LIMIT || 20) || 20);

  if (!airtableToken) throw new Error('Missing AIRTABLE_TOKEN.');
  if (!airtableBaseId) throw new Error('Missing AIRTABLE_BASE_ID.');
  if (!phase72DriveFolderId) throw new Error('Missing PHASE72_DRIVE_FOLDER_ID (Google Drive folder ID/URL).');
  if (!oauth2Service.isAuthenticated('inventory')) {
    throw new Error("Google account is not connected for auth context 'inventory'.");
  }

  const airtableService = new AirtableService({
    token: airtableToken,
    baseId: airtableBaseId,
    masterTable
  });
  const schemaService = new AirtableSchemaService({
    token: airtableToken,
    baseId: airtableBaseId
  });
  const auth = oauth2Service.getAuthenticatedClient('inventory');
  const drive = google.drive({ version: 'v3', auth });

  const summary = {
    masterPartsScanned: 0,
    masterPartsWithPartFitment: 0,
    fitmentImagesAlreadyPresent: 0,
    fitmentImagesGenerated: 0,
    fitmentImagesSkippedBlankFitment: 0,
    singleLayoutCount: 0,
    multiLayoutCount: 0,
    positionBlocksNormalized: 0,
    testIpnsCount: testIpnSet.size,
    maxIpns,
    sampleSingleLayout: [],
    sampleMultiLayout: [],
    sampleNormalizedPosition: [],
    warnings: [],
    errors: []
  };

  emitProgress(progressCallback, {
    stage: 'phase72_load_master',
    percent: 10,
    counts: summary,
    message: `Loading Master Parts from '${masterTable}'...`
  });

  const selectFields = [MASTER_IPN_FIELD, MASTER_FITMENT_FIELD, MASTER_FITMENT_IMAGE_FIELD];
  const rows =
    testIpnSet.size > 0
      ? await fetchMasterRowsByIpnSet(airtableService, masterTable, Array.from(testIpnSet), selectFields)
      : await fetchAllRecordsWithFallback(airtableService, masterTable, selectFields);
  summary.masterPartsScanned = rows.length;

  const tables = await schemaService.listTables();
  const masterSchema = (tables || []).find(
    table => normalizeText(table?.name).toLowerCase() === masterTable.toLowerCase()
  );
  const fitmentImageFieldSchema = (masterSchema?.fields || []).find(
    field => normalizeText(field?.name).toLowerCase() === MASTER_FITMENT_IMAGE_FIELD.toLowerCase()
  );
  const isAttachmentField = normalizeText(fitmentImageFieldSchema?.type) === 'multipleAttachments';

  let processedIpns = 0;
  let lastProgressAt = Date.now();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const fields = row?.fields || {};
    const ipn = normalizeIpn(fields[MASTER_IPN_FIELD]);
    if (!ipn) continue;
    if (testIpnSet.size > 0 && !testIpnSet.has(ipn)) continue;

    processedIpns += 1;
    if (maxIpns > 0 && processedIpns > maxIpns) break;

    const partFitment = normalizeText(fields[MASTER_FITMENT_FIELD]);
    if (!partFitment) {
      summary.fitmentImagesSkippedBlankFitment += 1;
      continue;
    }
    summary.masterPartsWithPartFitment += 1;

    const existingImage = fields[MASTER_FITMENT_IMAGE_FIELD];
    const hasExistingImage = Array.isArray(existingImage)
      ? existingImage.length > 0
      : Boolean(normalizeText(existingImage));
    if (hasExistingImage && !forceRegenerate) {
      summary.fitmentImagesAlreadyPresent += 1;
      continue;
    }

    emitProgress(progressCallback, {
      stage: 'phase72_parse_fitment',
      percent: Math.min(50, 15 + Math.floor(((i + 1) / Math.max(1, rows.length)) * 35)),
      counts: summary,
      message: `Parsing fitment for IPN '${ipn}' (${i + 1}/${rows.length})...`
    });

    const parsed = parseFitmentApplications(partFitment);
    const isSingle = (parsed.applications || []).length <= 1;
    if (isSingle) summary.singleLayoutCount += 1;
    else summary.multiLayoutCount += 1;
    if (parsed.positionNormalized) summary.positionBlocksNormalized += 1;

    const svg = createStandardizedFitmentSvg(partFitment, parsed);
    const fileName = `${sanitizeFilename(ipn)}.svg`;
    emitProgress(progressCallback, {
      stage: 'phase72_render_image',
      percent: Math.min(75, 50 + Math.floor(((i + 1) / Math.max(1, rows.length)) * 25)),
      counts: summary,
      message: `Rendering image for IPN '${ipn}'...`
    });

    let uploadResult = null;
    try {
      uploadResult = await uploadFitmentSvgToDrive(drive, phase72DriveFolderId, fileName, svg);
    } catch (error) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' drive upload failed: ${error.message}`);
      }
      continue;
    }

    emitProgress(progressCallback, {
      stage: 'phase72_write_airtable',
      percent: Math.min(95, 75 + Math.floor(((i + 1) / Math.max(1, rows.length)) * 20)),
      counts: summary,
      message: `Writing Fitment Image for IPN '${ipn}'...`
    });

    const attachmentUrl = uploadResult.lh3Url;
    const imageValue = isAttachmentField
      ? [
          {
            url: attachmentUrl,
            filename: fileName
          }
        ]
      : attachmentUrl;

    try {
      await airtableService.request('PATCH', `/${encodeURIComponent(masterTable)}`, {
        data: {
          records: [
            {
              id: row.id,
              fields: {
                [MASTER_FITMENT_IMAGE_FIELD]: imageValue
              }
            }
          ],
          typecast: true
        }
      });
      summary.fitmentImagesGenerated += 1;
      if (isSingle && summary.sampleSingleLayout.length < sampleLimit) {
        summary.sampleSingleLayout.push(`ipn='${ipn}' driveFile='${uploadResult.fileId}'`);
      }
      if (!isSingle && summary.sampleMultiLayout.length < sampleLimit) {
        summary.sampleMultiLayout.push(`ipn='${ipn}' driveFile='${uploadResult.fileId}' items=${parsed.applications.length}`);
      }
      if (parsed.positionNormalized && summary.sampleNormalizedPosition.length < sampleLimit) {
        summary.sampleNormalizedPosition.push(
          `ipn='${ipn}' position='${parsed.positionBlock || 'n/a'}'`
        );
      }
    } catch (error) {
      if (summary.errors.length < sampleLimit) {
        summary.errors.push(`ipn='${ipn}' airtable write failed: ${error.message}`);
      }
    }

    const now = Date.now();
    if (i === 0 || i + 1 === rows.length || now - lastProgressAt >= 10000) {
      lastProgressAt = now;
      emitProgress(progressCallback, {
        stage: 'phase72_write_airtable',
        percent: Math.min(95, 15 + Math.floor(((i + 1) / Math.max(1, rows.length)) * 80)),
        counts: summary,
        message:
          `Phase 7.2 progress ${i + 1}/${rows.length}: generated=${summary.fitmentImagesGenerated}, ` +
          `already=${summary.fitmentImagesAlreadyPresent}, single=${summary.singleLayoutCount}, multi=${summary.multiLayoutCount}`
      });
    }
  }

  emitProgress(progressCallback, {
    stage: 'completed',
    percent: 100,
    counts: summary,
    message: `Phase 7.2 completed. Fitment images generated=${summary.fitmentImagesGenerated}.`
  });

  return summary;
}

module.exports = {
  runPhase72FitmentImage
};
