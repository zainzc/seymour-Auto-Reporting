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

function resolvedValue(listingResolution, field) {
  return text(listingResolution?.resolved?.fields?.[field]?.resolvedValue);
}

function selectTitleFitmentCandidates(listingResolution = {}) {
  const partFitment = text(listingResolution?.normalized?.titleAuthority?.partFitment?.value);
  const parsed = parseApplicationClauses(partFitment);
  if (!parsed.length) return {
    status: 'NO_PARSEABLE_PART_FITMENT',
    resolution: 'UNAVAILABLE',
    selectionFacts: {},
    candidates: [],
    distinctApplications: []
  };

  const yearValue = resolvedValue(listingResolution, 'year');
  const exactYear = /^((?:19|20)\d{2})$/.test(yearValue) ? Number(yearValue) : null;
  const make = resolvedValue(listingResolution, 'brandMake');
  const model = resolvedValue(listingResolution, 'model');
  const byApplication = new Map();
  for (const candidate of parsed) {
    if (!byApplication.has(candidate.canonicalKey)) byApplication.set(candidate.canonicalKey, candidate);
  }
  const candidates = [...byApplication.values()];
  const resolution = candidates.length === 1 ? 'UNAMBIGUOUS' : 'AMBIGUOUS';

  return {
    status: resolution === 'UNAMBIGUOUS' ? 'ONE_DISTINCT_APPLICATION' : 'MULTIPLE_DISTINCT_APPLICATIONS',
    resolution,
    selectionFacts: { year: exactYear || null, make: make || null, model: model || null, appliedFilters: [] },
    candidates,
    distinctApplications: candidates
  };
}

module.exports = { parseApplicationClauses, selectTitleFitmentCandidates };
