function text(value) {
  if (Array.isArray(value)) return text(value[0]);
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function comparable(value) {
  return text(value).toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, ' ').trim();
}

function containsPhrase(value, phrase) {
  const haystack = ` ${comparable(value)} `;
  const needle = comparable(phrase);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

function modelComparable(value) {
  return comparable(text(value).replace(/([a-z])(?=\d)|([0-9])(?=[a-z])/gi, '$1$2 '));
}

function containsModel(value, model) {
  const haystack = ` ${modelComparable(value)} `;
  const needle = modelComparable(model);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

function applicationKey(value) {
  return comparable(value)
    .replace(/\b((?:19|20)\d{2})\s+(?:to\s+)?((?:19|20)\d{2})\b/g, '$1 $2')
    .trim();
}

function expandTitleYear(value) {
  const year = Number(value);
  if (String(value).length === 4) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function advertisedApplicationHint(existingTitle) {
  const match = text(existingTitle).match(/\bFits\s+(\d{2}|(?:19|20)\d{2})(?:\s*-\s*(\d{2}|(?:19|20)\d{2}))?\s+(.+)$/i);
  if (!match) return null;
  const rawTokens = text(match[3]).split(' ');
  const modelTokens = [];
  for (const token of rawTokens) {
    const clean = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9-]+$/g, '');
    if (!clean) continue;
    if (/^\d{2,4}A$/i.test(clean) || /^\d+(?:\.\d+)?L$/i.test(clean) ||
      /^(?:VIN|ID|AT|MT|CVT|AWD|FWD|RWD)$/i.test(clean) ||
      /^\d{5,}$/.test(clean) || (/\d/.test(clean) && clean.length >= 7)) break;
    if (!/[A-Za-z]/.test(clean)) break;
    modelTokens.push(clean);
  }
  if (!modelTokens.length) return null;
  const startYear = expandTitleYear(match[1]);
  const endYear = expandTitleYear(match[2] || match[1]);
  return {
    raw: text(match[0]),
    yearRange: startYear === endYear ? String(startYear) : `${startYear}-${endYear}`,
    modelText: modelTokens.join(' ')
  };
}

function parseApplicationClauses(partFitment) {
  return String(partFitment || '').split(/;|\r?\n/).map((raw, index) => {
    const evidence = text(raw).replace(/^Fits\s+/i, '');
    const years = evidence.match(/\b((?:19|20)\d{2})(?:\s*-\s*((?:19|20)\d{2}))?\b/);
    if (!evidence || !years) return null;
    return {
      id: `title-fitment-${String(index + 1).padStart(3, '0')}`,
      startYear: Number(years[1]),
      endYear: Number(years[2] || years[1]),
      evidence,
      canonicalKey: applicationKey(evidence)
    };
  }).filter(Boolean);
}

function candidateIdentityPrefix(evidence) {
  const match = text(evidence).match(/^(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?\s+([A-Za-z][A-Za-z-]*)\s+([A-Za-z0-9][A-Za-z0-9-]*)\b/);
  return match ? `${match[1]} ${match[2]}` : '';
}

function modelHintFromTitleCandidates(existingTitle, candidates) {
  const matching = candidates.map(item => candidateIdentityPrefix(item.evidence))
    .filter(identity => /\d/.test(identity.split(' ')[1] || '') && containsModel(existingTitle, identity));
  const identities = [...new Set(matching.map(modelComparable))];
  return identities.length === 1 ? matching[0] : '';
}

function validCalendarDate(month, day, year) {
  const fullYear = year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  return date.getUTCFullYear() === fullYear && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function detectMaterialFitmentIssues(partFitment) {
  const issues = [];
  for (const rawClause of String(partFitment || '').split(/;|\r?\n/)) {
    const evidence = text(rawClause).replace(/^Fits\s+/i, '');
    for (const match of evidence.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g)) {
      const value = match[0];
      if (validCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) continue;
      issues.push({
        code: 'INVALID_FITMENT_DATE',
        value,
        evidence,
        message: `Part Fitment contains an invalid calendar date (${value}).`
      });
    }
  }
  return issues;
}

function resolvedValue(listingResolution, field) {
  return text(listingResolution?.resolved?.fields?.[field]?.resolvedValue);
}

function selectTitleFitmentCandidates(listingResolution = {}) {
  const decisionPolicy = {
    owner: 'AI',
    instruction: 'Evaluate every supplied Part Fitment row for the selected make/model. Combine all continuous rows whose qualifiers are compatible. If a material qualifier conflict prevents one safe application, return unresolved for review. Do not select a narrower subset merely because it matches the donor year or existing title year.',
    allowedOutcomes: [
      'COMBINE_COMPATIBLE_CONTINUOUS_ROWS',
      'UNRESOLVED_MATERIAL_QUALIFIER_CONFLICT'
    ]
  };
  const partFitment = listingResolution?.normalized?.titleAuthority?.partFitment?.value || '';
  const existingTitle = text(
    listingResolution?.normalized?.fields?.existingTitle?.value ||
    listingResolution?.normalized?.fields?.legacyTitle?.value ||
    listingResolution?.resolved?.fields?.title?.resolvedValue
  );
  const advertisedHint = advertisedApplicationHint(existingTitle);
  const sourceIssues = detectMaterialFitmentIssues(partFitment);
  const parsed = parseApplicationClauses(partFitment);
  if (!parsed.length) return {
    status: 'NO_PARSEABLE_PART_FITMENT',
    resolution: 'UNAVAILABLE',
    decisionPolicy,
    selectionFacts: {},
    candidates: [],
    distinctApplications: [],
    eligibleCandidates: [],
    advertisedApplicationHint: advertisedHint,
    selectionBasis: advertisedHint ? 'EXISTING_TITLE_FITS_APPLICATION_UNMATCHED' : 'NO_PART_FITMENT',
    sourceIssues
  };

  const yearValue = resolvedValue(listingResolution, 'year');
  const exactYear = /^((?:19|20)\d{2})$/.test(yearValue) ? Number(yearValue) : null;
  const make = resolvedValue(listingResolution, 'brandMake');
  const model = resolvedValue(listingResolution, 'model');
  const byApplication = new Map();
  for (const candidate of parsed) {
    const hasResolvedVehicle = make && model &&
      containsPhrase(candidate.evidence, make) && containsModel(candidate.evidence, model);
    const key = hasResolvedVehicle
      ? `${candidate.startYear}-${candidate.endYear}|${comparable(make)}|${comparable(model)}`
      : candidate.canonicalKey;
    const existing = byApplication.get(key);
    if (!existing) {
      byApplication.set(key, { ...candidate, variantEvidence: [candidate.evidence] });
      continue;
    }
    existing.variantEvidence.push(candidate.evidence);
    existing.evidence = existing.variantEvidence.join('; ');
  }
  const candidates = [...byApplication.values()];
  const titleModel = !advertisedHint
    ? model && /\d/.test(model) && containsModel(existingTitle, model)
      ? model
      : modelHintFromTitleCandidates(existingTitle, candidates)
    : '';
  const hintedModel = advertisedHint?.modelText || titleModel;
  const matchedCandidates = hintedModel
    ? candidates.filter(item => containsModel(item.evidence, hintedModel))
    : [];
  const eligibleCandidates = hintedModel
    ? matchedCandidates
    : candidates;
  const selectionBasis = matchedCandidates.length
    ? advertisedHint ? 'EXISTING_TITLE_FITS_APPLICATION' : 'EXISTING_TITLE_MODEL_APPLICATION'
    : hintedModel
      ? advertisedHint ? 'EXISTING_TITLE_FITS_APPLICATION_UNMATCHED' : 'EXISTING_TITLE_MODEL_APPLICATION_UNMATCHED'
      : candidates.length === 1
        ? 'ONLY_COMPATIBILITY_APPLICATION'
        : 'AI_APPLICATION_SELECTION';
  const advertisedApplicationUnmatched = Boolean(hintedModel && !matchedCandidates.length);
  const resolution = advertisedApplicationUnmatched
    ? 'UNRESOLVED'
    : eligibleCandidates.length === 1 ? 'UNAMBIGUOUS' : 'AMBIGUOUS';

  return {
    status: advertisedApplicationUnmatched
      ? 'ADVERTISED_APPLICATION_UNMATCHED'
      : resolution === 'UNAMBIGUOUS' ? 'ONE_DISTINCT_APPLICATION' : 'MULTIPLE_DISTINCT_APPLICATIONS',
    resolution,
    decisionPolicy,
    selectionFacts: { year: exactYear || null, make: make || null, model: model || null, appliedFilters: [] },
    candidates,
    distinctApplications: candidates,
    eligibleCandidates,
    advertisedApplicationHint: advertisedHint || (titleModel ? {
      raw: existingTitle, yearRange: null, modelText: titleModel
    } : null),
    selectionBasis,
    sourceIssues
  };
}

module.exports = { advertisedApplicationHint, detectMaterialFitmentIssues, parseApplicationClauses, selectTitleFitmentCandidates };
