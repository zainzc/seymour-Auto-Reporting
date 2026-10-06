function text(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function citationText(value) {
  let citation = text(value);
  const wrappers = { '"': '"', "'": "'", '`': '`', '\u201c': '\u201d', '\u2018': '\u2019' };
  while (citation.length > 1 && wrappers[citation[0]] === citation[citation.length - 1]) {
    citation = citation.slice(1, -1).trim();
  }
  return citation;
}

function contains(value, term) {
  const escaped = text(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(escaped && new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(value));
}

function containsModel(value, model) {
  const normalize = input => text(input).toLowerCase()
    .replace(/([a-z])(?=\d)|([0-9])(?=[a-z])/g, '$1$2 ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const haystack = ` ${normalize(value)} `;
  const needle = normalize(model);
  return Boolean(needle && haystack.includes(` ${needle} `));
}

function parseApplicationRanges(value) {
  return citationText(value).split(/;|\n/).map(clause => {
    const evidence = text(clause).replace(/^Fits\s+/i, '');
    const match = evidence.match(/^((?:19|20)\d{2})(?:\s*-\s*((?:19|20)\d{2}))?\b/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2] || match[1]),
      evidence
    };
  }).filter(Boolean);
}

function applicationsCoverRange(citation, make, model, start, end) {
  const matches = parseApplicationRanges(citation)
    .filter(item => contains(item.evidence, make) && containsModel(item.evidence, model))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredThrough = null;
  for (const application of matches) {
    if (application.end < start || application.start > end) continue;
    if (coveredThrough === null) {
      if (application.start > start) return false;
      coveredThrough = application.end;
    } else if (application.start <= coveredThrough + 1) {
      coveredThrough = Math.max(coveredThrough, application.end);
    }
    if (coveredThrough >= end) return true;
  }
  return false;
}

function completeApplicationRange(citation, make, model, selectedStart, selectedEnd) {
  const matches = parseApplicationRanges(citation)
    .filter(item => contains(item.evidence, make) && containsModel(item.evidence, model))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];
  for (const application of matches) {
    const current = groups[groups.length - 1];
    if (!current || application.start > current.end + 1) {
      groups.push({ start: application.start, end: application.end });
    } else {
      current.end = Math.max(current.end, application.end);
    }
  }
  return groups.find(group => group.start <= selectedStart && group.end >= selectedEnd) || null;
}

function sourceContainsCitation(sourceEvidence, citation) {
  const source = text(sourceEvidence).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const selected = text(citation).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(source && selected && source.includes(selected));
}

function semicolonValues(value) {
  return citationText(value).split(';').map(text).filter(Boolean);
}

function sourceReferences(value) {
  return citationText(value).split(/\s*(?:;|\s+\+\s+)\s*/).map(text).filter(Boolean);
}

function resolveVehicleDecision(decision, promptArtifact, title) {
  const reject = (failureCode, failureMessage) => ({ verified: false, decision: decision || null,
    failureCode, failureMessage });
  if (decision?.resolved !== true) return reject('UNRESOLVED_DECISION', 'AI did not resolve a supported vehicle application.');
  const { make, model, yearRange, source, evidence } = decision;
  const supplied = promptArtifact?.userPayload?.resolvedListing?.categoryPriorityEvidenceSources || [];
  const fitmentSelection = promptArtifact?.userPayload?.resolvedListing?.titleFitmentCandidates;
  const titleCandidates = Array.isArray(fitmentSelection?.eligibleCandidates)
    ? fitmentSelection.eligibleCandidates
    : fitmentSelection?.candidates || [];
  const hasParsedFitmentCandidates = Array.isArray(fitmentSelection?.candidates) && fitmentSelection.candidates.length > 0;
  if (![make, model, yearRange, source, decision.reason].every(value => text(value)) ||
      (!hasParsedFitmentCandidates && !text(evidence))) {
    return reject('INCOMPLETE_DECISION', 'Vehicle decision is missing make, model, years, source, or reason.');
  }
  const trustedApplications = hasParsedFitmentCandidates
    ? titleCandidates.map(item => ({ id: item.id, source: 'Title Fitment Candidate', evidence: item.evidence }))
    : [
        ...titleCandidates.map(item => ({ id: item.id, source: 'Title Fitment Candidate', evidence: item.evidence })),
        ...supplied
      ];
  if (trustedApplications.length === 0) {
    return reject('NO_TRUSTED_APPLICATION', 'No eligible trusted application supports this vehicle decision.');
  }
  const years = text(yearRange).match(/^((?:19|20)\d{2})(?:-((?:19|20)\d{2}))?$/);
  if (!years || Number(years[1]) > Number(years[2] || years[1])) {
    return reject('INVALID_YEAR_RANGE', 'Vehicle yearRange must be one valid four-digit year or ascending range.');
  }
  const sourceRefs = sourceReferences(source);
  const cited = trustedApplications.filter(item => sourceRefs.includes(item.id) || sourceRefs.includes(item.source));
  const allSourcesExist = sourceRefs.length > 0 && sourceRefs.every(ref =>
    cited.some(item => item.id === ref || item.source === ref));
  if (!allSourcesExist) return reject('UNKNOWN_SOURCE', 'Vehicle source must cite eligible trusted source IDs.');
  const citation = hasParsedFitmentCandidates
    ? cited.map(item => text(item.evidence)).join('; ') : citationText(evidence);
  const citationSegments = semicolonValues(citation);
  const allCitationsExist = citationSegments.length > 0 && citationSegments.every(segment =>
    cited.some(item => sourceContainsCitation(item.evidence, segment)));
  const selectedStart = Number(years[1]);
  const selectedEnd = Number(years[2] || years[1]);
  const complete = completeApplicationRange(citation, make, model, selectedStart, selectedEnd);
  if (!allCitationsExist) return reject('UNSUPPORTED_CITATION', 'Vehicle evidence must quote exact supported source text.');
  if (!applicationsCoverRange(citation, make, model, selectedStart, selectedEnd) ||
      complete?.start !== selectedStart || complete?.end !== selectedEnd) {
    return reject('UNSUPPORTED_YEAR_RANGE', 'Cited rows do not cover exactly the selected make, model, and continuous year range.');
  }
  if (!contains(title, make) || !containsModel(title, model) || !contains(title, yearRange)) {
    return reject('TITLE_IDENTITY_MISMATCH', 'Title must contain the selected year range, make, and model.');
  }
  return { verified: true, decision: { ...decision, make: text(make), model: text(model), yearRange: text(yearRange),
    source: sourceRefs.join(';'), evidence: citationSegments.join('; ') } };
}

function vehicleSourceResolution(sourceResolution, verification) {
  if (!verification?.verified) return sourceResolution;
  const fields = { ...sourceResolution.resolved?.fields };
  for (const [field, value] of Object.entries({ brandMake: verification.decision.make, model: verification.decision.model, year: verification.decision.yearRange })) {
    fields[field] = { ...fields[field], resolvedValue: value, resolvedSource: verification.decision.source };
  }
  return { ...sourceResolution, resolved: { ...sourceResolution.resolved, fields,
    modelAmbiguity: { ambiguous: false },
    conflicts: (sourceResolution.resolved?.conflicts || []).filter(item => !['brandMake', 'model', 'year'].includes(item.field)) } };
}

module.exports = { resolveVehicleDecision, vehicleSourceResolution, applicationsCoverRange, completeApplicationRange };
