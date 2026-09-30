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

function applicationKey(value) {
  return comparable(value)
    .replace(/\b((?:19|20)\d{2})\s+(?:to\s+)?((?:19|20)\d{2})\b/g, '$1 $2')
    .trim();
}

function parseApplicationClauses(partFitment) {
  return text(partFitment).split(/;|\n/).map((raw, index) => {
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

function validCalendarDate(month, day, year) {
  const fullYear = year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  return date.getUTCFullYear() === fullYear && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function detectMaterialFitmentIssues(partFitment) {
  const issues = [];
  for (const rawClause of text(partFitment).split(/;|\n/)) {
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
  const partFitment = text(listingResolution?.normalized?.titleAuthority?.partFitment?.value);
  const sourceIssues = detectMaterialFitmentIssues(partFitment);
  const parsed = parseApplicationClauses(partFitment);
  if (!parsed.length) return {
    status: 'NO_PARSEABLE_PART_FITMENT',
    resolution: 'UNAVAILABLE',
    decisionPolicy,
    selectionFacts: {},
    candidates: [],
    distinctApplications: [],
    sourceIssues
  };

  const yearValue = resolvedValue(listingResolution, 'year');
  const exactYear = /^((?:19|20)\d{2})$/.test(yearValue) ? Number(yearValue) : null;
  const make = resolvedValue(listingResolution, 'brandMake');
  const model = resolvedValue(listingResolution, 'model');
  const byApplication = new Map();
  for (const candidate of parsed) {
    const hasResolvedVehicle = make && model &&
      containsPhrase(candidate.evidence, make) && containsPhrase(candidate.evidence, model);
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
  const resolution = candidates.length === 1 ? 'UNAMBIGUOUS' : 'AMBIGUOUS';

  return {
    status: resolution === 'UNAMBIGUOUS' ? 'ONE_DISTINCT_APPLICATION' : 'MULTIPLE_DISTINCT_APPLICATIONS',
    resolution,
    decisionPolicy,
    selectionFacts: { year: exactYear || null, make: make || null, model: model || null, appliedFilters: [] },
    candidates,
    distinctApplications: candidates,
    sourceIssues
  };
}

module.exports = { detectMaterialFitmentIssues, parseApplicationClauses, selectTitleFitmentCandidates };
