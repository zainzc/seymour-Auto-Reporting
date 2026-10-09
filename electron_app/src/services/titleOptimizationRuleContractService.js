function normalizeText(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function normalizedKey(value) {
  return normalizeText(value).toLocaleLowerCase('en-US');
}

function containsTerm(title, term) {
  const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return Boolean(escaped && new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(normalizeText(title)));
}

function explicitSide(title) {
  const words = normalizeText(title).toLowerCase().match(/\b(?:left|lh|driver|right|rh|passenger)\b/g) || [];
  const left = words.some(word => ['left', 'lh', 'driver'].includes(word));
  const right = words.some(word => ['right', 'rh', 'passenger'].includes(word));
  return left === right ? null : left ? 'Left' : 'Right';
}

function suppliedEvidenceIds(promptArtifact = {}) {
  const listing = promptArtifact?.userPayload?.resolvedListing || {};
  const evidenceSources = listing.categoryPriorityEvidenceSources || [];
  const all = new Set(evidenceSources.map(item => normalizeText(item?.id)).filter(Boolean));
  const restrictedTermAuthorization = new Set(evidenceSources
    .filter(item => item?.authorizesRestrictedTerms === true)
    .map(item => normalizeText(item?.id))
    .filter(Boolean));
  const fitment = new Set();
  for (const row of listing.titleFitmentCandidates?.eligibleCandidates || []) {
    const id = normalizeText(row?.id);
    if (id) {
      all.add(id);
      fitment.add(id);
    }
  }
  return { all, fitment, restrictedTermAuthorization };
}

function isResolvedAlternativeIdentifierRestriction(restriction = {}, aiResult = {}) {
  const detail = normalizeText(restriction?.detail);
  const vehicleDecision = aiResult?.vehicleDecision || {};
  const audit = aiResult?.ruleSelfAudit || {};
  return Boolean(
    restriction?.material === true &&
    restriction?.titleTreatment === 'needs-review' &&
    vehicleDecision.resolved === true &&
    audit.unresolvedSourceConflict !== true &&
    /\b(?:id|identifier|part number|mpn)\b/i.test(detail) &&
    /\bor\b|\/|,/i.test(detail)
  );
}

function validateTitleRuleContract({ aiResult = {}, sourceResolution = {}, ruleResolution = {}, promptArtifact = {}, candidateTitle = '' } = {}) {
  const checks = [];
  const violations = [];
  const fail = (checkId, message, relatedConfigIds = []) => {
    const check = { checkId, status: 'BLOCK', message, relatedConfigIds };
    checks.push(check);
    violations.push(check);
  };
  const pass = (checkId, message) => checks.push({ checkId, status: 'PASS', message, relatedConfigIds: [] });
  const warn = (checkId, message) => checks.push({ checkId, status: 'WARN', message, relatedConfigIds: [] });
  const existingTitle = normalizeText(promptArtifact?.userPayload?.existingTitle?.currentTitle ||
    sourceResolution?.resolved?.fields?.title?.resolvedValue);
  const previousSide = explicitSide(existingTitle);
  const proposedSide = explicitSide(candidateTitle);
  if (previousSide && proposedSide && previousSide !== proposedSide) {
    fail('existing-title-side-conflict', `Proposed ${proposedSide} side conflicts with the existing ${previousSide} side. Verify the part before replacing the title.`);
  }
  const contractSupplied = ['materialRestrictions', 'restrictedTermDecisions', 'titleSegments', 'ruleSelfAudit']
    .some(key => Object.prototype.hasOwnProperty.call(aiResult, key));
  if (!contractSupplied) return { passed: violations.length === 0, checks, violations, skipped: true };

  const evidenceIds = suppliedEvidenceIds(promptArtifact);
  const decisions = new Map((aiResult.restrictedTermDecisions || [])
    .map(item => [normalizedKey(item?.term), item]));

  for (const rule of ruleResolution?.restrictedTerms?.rules || []) {
    const term = normalizeText(rule?.term);
    if (!term) continue;
    const used = containsTerm(candidateTitle, term);
    const decision = decisions.get(normalizedKey(term));
    if (rule.ruleType === 'must-preserve' && containsTerm(existingTitle, term) && !used &&
        normalizedKey(aiResult.titleReviewStatus) === 'completed') {
      fail('restricted-term-preservation', `Configured must-preserve term ${term} was removed from the existing title.`, [rule.id].filter(Boolean));
    }
    if (!used) {
      if (decision?.used === true) warn('restricted-term-use-mismatch', `Restricted Term ${term} was reported as used but is absent from the title.`);
      continue;
    }
    if (['never-introduce', 'remove-noise'].includes(rule.ruleType)) {
      fail('restricted-term-prohibited', `Restricted Term ${term} is not allowed in the generated title.`, [rule.id].filter(Boolean));
      continue;
    }
    if (rule.ruleType === 'requires-authorization') {
      const source = normalizeText(decision?.source);
      const evidence = normalizeText(decision?.evidence);
      if (decision?.authorized !== true || !source || !evidence ||
          !evidenceIds.restrictedTermAuthorization.has(source)) {
        fail('restricted-term-authorization', `Restricted Term ${term} requires valid supplied authorization evidence.`, [rule.id].filter(Boolean));
        continue;
      }
    }
    if (!decision || decision.used !== true) {
      warn('restricted-term-decision-missing', `Restricted Term ${term} appears in the title without a matching AI decision.`);
    }
    pass('restricted-term-decision', `Restricted Term ${term} decision is consistent with the title.`);
  }

  for (const restriction of aiResult.materialRestrictions || []) {
    const rowIds = Array.isArray(restriction?.sourceRowIds) ? restriction.sourceRowIds.map(normalizeText).filter(Boolean) : [];
    const invalidIds = rowIds.filter(id => !evidenceIds.all.has(id));
    if (invalidIds.length) {
      warn('material-restriction-citation', `Material restriction cites unknown source rows: ${invalidIds.join(', ')}.`);
    }
    if (restriction?.material === true && restriction?.titleTreatment === 'needs-review' &&
        normalizedKey(aiResult.titleReviewStatus) === 'completed') {
      const message = `Material restriction ${normalizeText(restriction.detail)} still requires review.`;
      if (containsTerm(candidateTitle, restriction.detail)) {
        pass('material-restriction-included', `Material restriction ${normalizeText(restriction.detail)} appears in the title.`);
      } else if (isResolvedAlternativeIdentifierRestriction(restriction, aiResult)) {
        warn('material-restriction-alternative-identifier', `${message} Compatible alternative identifiers are resolved and do not block completion.`);
      } else {
        fail('material-restriction-unresolved', message);
      }
    }
  }

  const segments = Array.isArray(aiResult.titleSegments) ? aiResult.titleSegments : [];
  const completed = normalizedKey(aiResult.titleReviewStatus) === 'completed';
  if (completed && segments.length === 0) {
    warn('title-segments-missing', 'Completed output is missing the optional title segment decisions.');
  }
  if (segments.length) {
    const reconstructed = normalizeText(segments.map(segment => normalizeText(segment?.value)).filter(Boolean).join(' '));
    const exactReconstruction = reconstructed === normalizeText(candidateTitle);
    if (!exactReconstruction) {
      warn('title-segment-reconstruction', 'Returned title segments do not reconstruct the generated title exactly.');
    } else {
      pass('title-segment-reconstruction', 'Returned title segments reconstruct the generated title.');
    }
    const configuredKeys = (ruleResolution?.titleStructure?.selected?.segments || [])
      .map(segment => normalizeText(segment?.key)).filter(Boolean);
    if (configuredKeys.length) {
      let previousIndex = -1;
      const invalidOrder = segments.some(segment => {
        const index = configuredKeys.indexOf(normalizeText(segment?.key));
        if (index < 0 || index <= previousIndex) return true;
        previousIndex = index;
        return false;
      });
      if (invalidOrder) {
        const message = 'Returned title segments do not follow the configured Title Structure order.';
        if (exactReconstruction) fail('title-segment-order', message);
        else warn('title-segment-order', message);
      } else {
        pass('title-segment-order', 'Returned title segments follow the configured Title Structure order.');
      }
    }
  }

  const configuredCategoryDetails = (ruleResolution?.categoryRules || [])
    .flatMap(entry => entry?.priorityDetails || entry?.rule?.priorityDetails || [])
    .map(normalizeText).filter(Boolean);
  const categoryDecisions = Array.isArray(aiResult.categoryPriorityDetails)
    ? aiResult.categoryPriorityDetails : [];
  for (const detail of configuredCategoryDetails) {
    const matching = categoryDecisions.filter(item => normalizedKey(item?.detail) === normalizedKey(detail));
    const used = containsTerm(candidateTitle, detail);
    if (!used) continue;
    const deterministicPart = ruleResolution?.deterministicTitlePart;
    if (normalizeText(deterministicPart?.source).startsWith('prefixRule.') &&
        containsTerm(deterministicPart?.value, detail)) {
      pass('category-detail-prefix-authority', `Category Rule detail ${detail} is supported by the deterministic Prefix Rule part.`);
      continue;
    }
    if (matching.length !== 1) {
      fail('category-detail-decision-count', `Category Rule detail ${detail} must have exactly one AI decision.`);
      continue;
    }
    const decision = matching[0];
    if (decision.verified !== true) {
      fail('category-detail-unverified-use', `Category Rule detail ${detail} appears in the title without verification.`);
      continue;
    }
    if (decision.verified === true) {
      const source = normalizeText(decision.source);
      const evidence = normalizeText(decision.evidence);
      if (!source || !evidence || !evidenceIds.all.has(source)) {
        fail('category-detail-citation', `Category Rule detail ${detail} has no valid supplied evidence citation.`);
        continue;
      }
    }
    pass('category-detail-decision', `Category Rule detail ${detail} decision is consistent with supplied evidence.`);
  }

  const audit = aiResult.ruleSelfAudit;
  if (completed && !audit) {
    warn('rule-self-audit-missing', 'Completed output is missing the rule self-audit.');
  }
  if (audit && completed) {
    if (audit.structureFollowed !== true) warn('structure-self-audit', 'AI reported that the selected Title Structure was not followed.');
    if (audit.unresolvedSourceConflict === true) fail('source-conflict-self-audit', 'AI reported an unresolved source conflict.');
    if (audit.unsupportedClaim === true) fail('unsupported-claim-self-audit', 'AI reported an unsupported title claim.');
  }

  return { passed: violations.length === 0, checks, violations, skipped: false };
}

module.exports = {
  validateTitleRuleContract
};
