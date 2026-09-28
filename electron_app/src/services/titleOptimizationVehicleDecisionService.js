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

function parseApplications(value) {
  return citationText(value).split(/;|\n/).map(clause => {
    const match = clause.trim().match(/^(?:Fits\s+)?((?:19|20)\d{2})(?:\s*-\s*((?:19|20)\d{2}))?\s+([A-Za-z][A-Za-z0-9-]*)\s+([A-Za-z0-9][A-Za-z0-9-]*)\s*(.*)$/i);
    if (!match) return null;
    return {
      start: Number(match[1]),
      end: Number(match[2] || match[1]),
      make: text(match[3]).toLowerCase(),
      model: text(match[4]).toLowerCase(),
      qualifiers: text(match[5]).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    };
  }).filter(Boolean);
}

function applicationsSupportRange(citation, make, model, start, end) {
  const matches = parseApplications(citation)
    .filter(item => item.make === text(make).toLowerCase() && item.model === text(model).toLowerCase())
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 0; index < matches.length; index += 1) {
    const first = matches[index];
    if (first.start > start || first.end < start) continue;
    let coveredThrough = first.end;
    const qualifiers = first.qualifiers;
    for (let next = index + 1; coveredThrough < end && next < matches.length; next += 1) {
      const application = matches[next];
      if (application.start > coveredThrough + 1 || application.qualifiers !== qualifiers) break;
      coveredThrough = Math.max(coveredThrough, application.end);
    }
    if (coveredThrough >= end) return true;
  }
  return false;
}

function resolveVehicleDecision(decision, promptArtifact, title) {
  const rejected = { verified: false, decision: decision || null };
  if (decision?.resolved !== true) return rejected;
  const { make, model, yearRange, source, evidence } = decision;
  const citation = citationText(evidence);
  if (![make, model, yearRange, source, evidence, decision.reason].every(value => text(value))) return rejected;
  const supplied = promptArtifact?.userPayload?.resolvedListing?.categoryPriorityEvidenceSources || [];
  const titleCandidates = promptArtifact?.userPayload?.resolvedListing?.titleFitmentCandidates?.candidates || [];
  const trustedApplications = titleCandidates.length
    ? titleCandidates.map(item => ({ id: item.id, source: 'Title Fitment Candidate', evidence: item.evidence }))
    : supplied;
  if (!citation || trustedApplications.length === 0) return rejected;
  const years = text(yearRange).match(/^((?:19|20)\d{2})(?:-((?:19|20)\d{2}))?$/);
  if (!years || Number(years[1]) > Number(years[2] || years[1])) return rejected;
  // The model's quotation is advisory. Validate against complete trusted records so
  // harmless omissions or rewording in the quotation cannot invalidate real evidence.
  const cited = trustedApplications.filter(item => item.id === source || item.source === source);
  const candidates = [...cited, ...trustedApplications.filter(item => !cited.includes(item))];
  // Adjacent applications may form one range only when all qualifiers are identical.
  const supportingSource = candidates.find(item => applicationsSupportRange(
    item.evidence, make, model, Number(years[1]), Number(years[2] || years[1])
  ));
  const supported = Boolean(supportingSource);
  if (!supported || !contains(title, `${text(make)} ${text(model)}`) || !contains(title, yearRange)) return rejected;
  return { verified: true, decision: { ...decision, make: text(make), model: text(model), yearRange: text(yearRange),
    source: supportingSource.id || supportingSource.source, evidence: text(supportingSource.evidence) } };
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

module.exports = { resolveVehicleDecision, vehicleSourceResolution };
