function text(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function validateMechanicalTitle({ sourceResolution = {}, ruleResolution = {}, candidateTitle = '' } = {}) {
  const violations = [];
  let title = text(candidateTitle);
  const sku = text(sourceResolution?.resolved?.fields?.sku?.resolvedValue ||
    sourceResolution?.normalized?.fields?.sku?.value || ruleResolution?.listingContext?.sku);
  const prefix = text(ruleResolution?.listingContext?.ipnPrefix || ruleResolution?.prefixRule?.normalizedPrefix);

  if (!title) {
    violations.push({ checkId: 'blank-title', status: 'BLOCK', message: 'AI returned no title.' });
  }
  if (!sku) {
    violations.push({ checkId: 'sku-missing-source', status: 'BLOCK',
      message: 'A verified SKU is unavailable; the title cannot be completed.' });
  } else if (title) {
    const bareSku = sku.replace(/^#+/, '');
    const suffix = prefix === '257' ? `#${bareSku}` : bareSku;
    const tokens = title.split(' ').filter(token => token.replace(/^#/, '').toLowerCase() !== bareSku.toLowerCase());
    title = `${tokens.join(' ')} ${suffix}`.trim();
  }
  if (title.length > 80) {
    violations.push({ checkId: 'length-80', status: 'RETAIN_EXISTING_REQUIRED',
      message: `Title is ${title.length} characters after SKU placement; maximum is 80.` });
  }
  return {
    outcome: violations.length ? 'RETAIN_EXISTING_REQUIRED' : 'PASS',
    validatedTitle: title,
    violations,
    warnings: [],
    vehicleVerification: null
  };
}

function decideAiTitle({ validationResult = {}, aiResult = {}, promptArtifact = {} } = {}) {
  if (promptArtifact?.kind === 'title-generation-bypass') {
    return { decision: 'BYPASSED_MANUAL_OVERRIDE', finalTitle: '', reviewRequired: true,
      reviewReason: 'manual_override', reviewNotes: 'Manual title override is active.', degradationChecks: [] };
  }
  const failures = (validationResult.violations || []).map(item => ({
    checkId: `phase-e:${item.checkId}`, status: 'FAIL', message: item.message
  }));
  const aiCompleted = text(aiResult.titleReviewStatus).toLowerCase() === 'completed';
  const accepted = aiCompleted && failures.length === 0 && text(validationResult.validatedTitle);
  const aiNotes = text(aiResult.titleReviewNotes || aiResult.titleReviewReason);
  return {
    aiLed: true,
    decision: accepted ? 'ACCEPT_CANDIDATE' : 'NEEDS_REVIEW',
    finalTitle: accepted ? validationResult.validatedTitle : '',
    reviewRequired: !accepted,
    reviewReason: accepted ? 'completed' : failures.some(item => item.checkId === 'phase-e:length-80')
      ? 'Cannot preserve essential fitment within 80 characters'
      : failures.length ? 'Title mechanical validation failed'
        : text(aiResult.titleReviewReason) || 'manual_review_required',
    reviewNotes: [aiNotes, ...failures.map(item => item.message)].filter(Boolean).join(' '),
    degradationChecks: failures
  };
}

module.exports = { validateMechanicalTitle, decideAiTitle };
