function text(value) {
  return value === null || value === undefined ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function sourceIds(value) {
  return text(value).split(/\s*(?:;|\s+\+\s+)\s*/).filter(Boolean);
}

function buildFitmentReviewInput({ title, promptArtifact, vehicleDecision } = {}) {
  const payload = promptArtifact?.userPayload || {};
  const listing = payload.resolvedListing || {};
  const selection = listing.titleFitmentCandidates || {};
  const eligible = Array.isArray(selection.eligibleCandidates)
    ? selection.eligibleCandidates : selection.candidates || [];
  const selectedIds = sourceIds(vehicleDecision?.source);
  const selectedRows = selectedIds.length
    ? eligible.filter(row => selectedIds.includes(row.id)) : eligible;
  const selectedRowIds = new Set(selectedRows.map(row => row.id));
  return {
    title: text(title),
    existingTitle: text(payload.existingTitle?.currentTitle),
    advertisedApplication: selection.advertisedApplicationHint || null,
    selectedRows: selectedRows.map(row => ({ id: row.id, evidence: row.evidence })),
    additionalEligibleRows: eligible.filter(row => !selectedRowIds.has(row.id))
      .map(row => ({ id: row.id, evidence: row.evidence })),
    otherTrustedEvidence: (listing.categoryPriorityEvidenceSources || [])
      .filter(row => /^(?:Item Specifics:|Conditions & Options$|Resolved:)/.test(row.source))
      .map(row => ({ id: row.id, source: row.source, evidence: row.evidence })),
    fallbackTitleEvidence: selectedRows.length ? null : listing.titleEvidence || null
  };
}

function checkedFitmentReview(response, input) {
  if (!response || !['PASS', 'REVIEW'].includes(response.verdict) || !text(response.reason) ||
      !Array.isArray(response.citedRowIds)) {
    throw new Error('Fitment review returned an incomplete decision.');
  }
  const allowed = new Set(input.selectedRows.map(row => row.id));
  const cited = response.citedRowIds.map(text);
  if (cited.some(id => !allowed.has(id)) || new Set(cited).size !== cited.length) {
    throw new Error('Fitment review cited an unknown or duplicate row.');
  }
  if (response.verdict === 'PASS' && allowed.size &&
      [...allowed].some(id => !cited.includes(id))) {
    throw new Error('Fitment review did not inspect every selected row.');
  }
  return { verdict: response.verdict, reason: text(response.reason), citedRowIds: cited };
}

module.exports = { buildFitmentReviewInput, checkedFitmentReview };
