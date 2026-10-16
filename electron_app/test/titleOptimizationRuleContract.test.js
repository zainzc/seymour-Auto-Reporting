const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTitleRuleContract } = require('../src/services/titleOptimizationRuleContractService');

function inputs(overrides = {}) {
  return {
    candidateTitle: '2014 Engine 12345',
    ruleResolution: {
      restrictedTerms: { rules: [] },
      categoryRules: [],
      titleStructure: { selected: { segments: [
        { key: 'yearOrRange', kind: 'field' },
        { key: 'part', kind: 'field' },
        { key: 'sku', kind: 'field' }
      ] } }
    },
    promptArtifact: { userPayload: { resolvedListing: {
      categoryPriorityEvidenceSources: [{ id: 'evidence-001', evidence: 'Wiper switch' }],
      titleFitmentCandidates: { eligibleCandidates: [{ id: 'title-fitment-001' }] }
    } } },
    aiResult: {
      titleReviewStatus: 'Completed',
      materialRestrictions: [],
      restrictedTermDecisions: [],
      titleSegments: [
        { key: 'yearOrRange', value: '2014' },
        { key: 'part', value: 'Engine' },
        { key: 'sku', value: '12345' }
      ],
      ruleSelfAudit: {
        structureFollowed: true,
        unresolvedSourceConflict: false,
        unsupportedClaim: false,
        notes: 'Checked.'
      },
      categoryPriorityDetails: []
    },
    ...overrides
  };
}

test('blocks a title whose exact segments violate the configured structure order', () => {
  const value = inputs();
  value.candidateTitle = 'Engine 2014 12345';
  value.aiResult.titleSegments = [
    { key: 'part', value: 'Engine' },
    { key: 'yearOrRange', value: '2014' },
    { key: 'sku', value: '12345' }
  ];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, false);
  assert.equal(result.violations.some(item => item.checkId === 'title-segment-order'), true);
});

test('material restrictions accept supplied non-fitment evidence IDs when fitment rows are unavailable', () => {
  const value = inputs();
  value.candidateTitle = '2014 Engine VIN J 12345';
  value.promptArtifact.userPayload.resolvedListing.titleFitmentCandidates.eligibleCandidates = [];
  value.aiResult.materialRestrictions = [{
    detail: 'VIN J', appliesTo: '2014', sourceRowIds: ['evidence-001'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
});

test('unknown material restriction citations are diagnostic when the title is otherwise safe', () => {
  const value = inputs();
  value.candidateTitle = '2014 Engine VIN J 12345';
  value.aiResult.materialRestrictions = [{
    detail: 'VIN J', appliesTo: '2014', sourceRowIds: ['currentTitleYearFallback'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-citation'), false);
  assert.equal(result.checks.some(item => item.checkId === 'material-restriction-citation' && item.status === 'WARN'), true);
});

test('material restrictions may cite an original fitment clause nested in a grouped application', () => {
  const value = inputs();
  value.promptArtifact.userPayload.resolvedListing.titleFitmentCandidates.eligibleCandidates = [{
    id: 'title-fitment-001',
    sourceRows: [{ id: 'title-fitment-001', evidence: '2014 Honda Accord sedan' },
      { id: 'title-fitment-002', evidence: '2014 Honda Accord coupe' }]
  }];
  value.aiResult.materialRestrictions = [{
    detail: 'Coupe', appliesTo: '2014 Honda Accord', sourceRowIds: ['title-fitment-002'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.checks.some(item => item.checkId === 'material-restriction-citation'), false);
});

test('material restriction already stated in the title does not force review because of AI treatment metadata', () => {
  const value = inputs();
  value.candidateTitle = '2014 Engine Keyless Ignition 12345';
  value.aiResult.titleSegments[1].value = 'Engine Keyless Ignition';
  value.aiResult.materialRestrictions = [{
    detail: 'Keyless Ignition', appliesTo: '2014', sourceRowIds: ['title-fitment-001'],
    material: true, titleTreatment: 'needs-review'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-unresolved'), false);
});

test('material wording mismatch does not override the AI fitment decision', () => {
  const value = inputs();
  value.candidateTitle = '2014 Power Side View Mirror 12345';
  value.aiResult.materialRestrictions = [{
    detail: 'Without heated glass', appliesTo: '2014', sourceRowIds: ['title-fitment-001'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-title-mismatch'), false);
});

test('a concise equivalent negative qualifier is accepted', () => {
  const value = inputs();
  value.candidateTitle = '2014 Non-Heated Side View Mirror 12345';
  value.aiResult.materialRestrictions = [{
    detail: 'Without heated glass', appliesTo: '2014', sourceRowIds: ['title-fitment-001'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
});

test('numeric fitment wording remains the AI decision rather than a code review gate', () => {
  const value = inputs();
  value.candidateTitle = '2014 Seat Belt Buckle 12345';
  value.aiResult.materialRestrictions = [{
    detail: '2-Point Harness design', appliesTo: '2014', sourceRowIds: ['title-fitment-001'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-title-mismatch'), false);
});

test('VIN and displacement qualifiers can be stated concisely', () => {
  const value = inputs();
  value.candidateTitle = '2014 Camry VIN B Hybrid 2.4L 12345';
  value.aiResult.materialRestrictions = [
    { detail: 'VIN B 5th digit', sourceRowIds: ['title-fitment-001'], material: true, titleTreatment: 'included' },
    { detail: 'Hybrid 2.4L engine', sourceRowIds: ['title-fitment-001'], material: true, titleTreatment: 'included' }
  ];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
});

test('year coverage wording is not mistaken for a missing negative feature', () => {
  const value = inputs();
  value.aiResult.materialRestrictions = [{
    detail: 'Year 2014 only (no broader range verified)', sourceRowIds: ['title-fitment-001'],
    material: true, titleTreatment: 'included'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
});

test('compatible alternative identifiers do not block a resolved completed title', () => {
  const value = inputs();
  value.aiResult.vehicleDecision = { resolved: true };
  value.aiResult.materialRestrictions = [{
    detail: 'Cluster ID 8L9T-10849-AA or 8L9T-10849-AB',
    appliesTo: '2008 Mercury Mountaineer',
    sourceRowIds: ['title-fitment-001'],
    material: true,
    titleTreatment: 'needs-review'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-unresolved'), false);
  assert.equal(result.checks.some(item => item.checkId === 'material-restriction-alternative-identifier'), true);
});

test('AI final status is not overridden by a contradictory detail-level fitment flag', () => {
  const value = inputs();
  value.aiResult.vehicleDecision = { resolved: true };
  value.aiResult.materialRestrictions = [{
    detail: 'VIN split J',
    appliesTo: '2014',
    sourceRowIds: ['title-fitment-001'],
    material: true,
    titleTreatment: 'needs-review'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-unresolved'), false);
  assert.equal(result.checks.some(item => item.checkId === 'material-decision-contradiction' && item.status === 'WARN'), true);
});

test('an explicitly safe omission does not escalate a completed title', () => {
  const value = inputs();
  value.aiResult.materialRestrictions = [{
    detail: 'Quarter panel mounted',
    appliesTo: '2014-2017 Mazda 6',
    sourceRowIds: ['title-fitment-001'],
    evidence: '2014-2017 Mazda 6 tail lamp, quarter panel mounted',
    material: true,
    titleTreatment: 'omitted-safe',
    omissionReason: 'This mounting description is common to the selected application and its omission does not broaden fitment.'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'material-restriction-unresolved'), false);
  assert.equal(result.checks.some(item => item.checkId === 'material-restriction-safe-omission' && item.status === 'PASS'), true);
});

test('AI may substantiate a restricted term from ordinary supplied listing evidence', () => {
  const value = inputs();
  value.candidateTitle = '2014 Engine Complete Assembly 12345';
  value.aiResult.titleSegments[1].value = 'Engine Complete Assembly';
  value.ruleResolution.restrictedTerms.rules = [{
    id: 'restricted-complete-assembly',
    term: 'Complete Assembly',
    ruleType: 'requires-authorization'
  }];
  value.promptArtifact.userPayload.resolvedListing.categoryPriorityEvidenceSources = [{
    id: 'evidence-001',
    source: 'Item Specifics:Type',
    evidence: 'Complete Assembly'
  }];
  value.aiResult.restrictedTermDecisions = [{
    term: 'Complete Assembly',
    used: true,
    evidenceVerified: true,
    source: 'evidence-001',
    evidence: 'Complete Assembly'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'restricted-term-authorization'), false);
});

test('unused restricted terms need no AI decision and cannot create a review', () => {
  const value = inputs();
  value.ruleResolution.restrictedTerms.rules = [
    { id: 'oem', term: 'OEM Part', ruleType: 'remove-noise' },
    { id: 'complete', term: 'Complete Assembly', ruleType: 'requires-authorization' }
  ];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'restricted-term-decision-missing'), false);
});

test('an existing UI must-preserve term cannot silently disappear from a Completed title', () => {
  const value = inputs();
  value.promptArtifact.userPayload.existingTitle = { currentTitle: '2014 Engine ECM PCM 12345' };
  value.ruleResolution.restrictedTerms.rules = [
    { id: 'ecm', term: 'ECM', ruleType: 'must-preserve' },
    { id: 'pcm', term: 'PCM', ruleType: 'must-preserve' }
  ];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, false);
  assert.equal(result.violations.filter(item => item.checkId === 'restricted-term-preservation').length, 2);
});

test('an AI-evidence-check term blocks without a supplied evidence citation', () => {
  const value = inputs();
  value.candidateTitle = '2014 Complete Assembly 12345';
  value.ruleResolution.restrictedTerms.rules = [{
    id: 'complete', term: 'Complete Assembly', ruleType: 'requires-authorization'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, false);
  assert.equal(result.violations.some(item => item.checkId === 'restricted-term-authorization'), true);
});

test('a cited supplied source can support an AI-evidence-check term', () => {
  const value = inputs();
  value.candidateTitle = '2014 Engine Complete Assembly 12345';
  value.aiResult.titleSegments[1].value = 'Engine Complete Assembly';
  value.ruleResolution.restrictedTerms.rules = [{
    id: 'restricted-complete-assembly',
    term: 'Complete Assembly',
    ruleType: 'requires-authorization'
  }];
  value.promptArtifact.userPayload.resolvedListing.categoryPriorityEvidenceSources = [{
    id: 'evidence-001',
    source: 'Resolved:condition',
    evidence: 'Complete Assembly'
  }];
  value.aiResult.restrictedTermDecisions = [{
    term: 'Complete Assembly',
    used: true,
    evidenceVerified: true,
    source: 'evidence-001',
    evidence: 'Complete Assembly'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
});

test('an evidence-verified restricted term still blocks when its source ID was not supplied', () => {
  const value = inputs();
  value.candidateTitle = '2014 Complete Assembly 12345';
  value.ruleResolution.restrictedTerms.rules = [{
    id: 'complete', term: 'Complete Assembly', ruleType: 'requires-authorization'
  }];
  value.aiResult.restrictedTermDecisions = [{
    term: 'Complete Assembly', used: true, evidenceVerified: true,
    source: 'invented-evidence-id', evidence: 'Complete Assembly'
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, false);
  assert.equal(result.violations.some(item => item.checkId === 'restricted-term-authorization'), true);
});

test('AI owns category-detail evidence decisions; missing verification is diagnostic, not a code blocker', () => {
  const value = inputs();
  value.candidateTitle = '2014 Wiper Engine 12345';
  value.aiResult.titleSegments[1].value = 'Wiper Engine';
  value.ruleResolution.categoryRules = [{
    rule: { id: 'cat-switch', categoryName: 'Column Switches' },
    priorityDetails: ['Wiper']
  }];
  value.aiResult.categoryPriorityDetails = [{
    detail: 'Wiper', verified: false, source: null, evidence: null
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId.startsWith('category-detail-')), false);
  assert.equal(result.checks.some(item => item.checkId === 'category-detail-unverified-use' && item.status === 'WARN'), true);
});

test('unused category priority details do not need individual AI decisions', () => {
  const value = inputs();
  value.ruleResolution.categoryRules = [{
    rule: { id: 'cat-switch', categoryName: 'Column Switches' },
    priorityDetails: ['Wiper', 'Turn Signal', 'Multifunction']
  }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'category-detail-decision-count'), false);
});

test('a deterministic Prefix Rule part can verify the same category detail', () => {
  const value = inputs();
  value.candidateTitle = '2014 Speedometer 12345';
  value.ruleResolution.deterministicTitlePart = {
    value: 'Speedometer', source: 'prefixRule.approvedPartTerm', ruleId: 'prefix-257'
  };
  value.ruleResolution.categoryRules = [{
    rule: { id: 'cat-cluster', categoryName: 'Instrument Clusters' },
    priorityDetails: ['Speedometer']
  }];
  value.aiResult.categoryPriorityDetails = [{ detail: 'Speedometer', verified: false, source: null, evidence: null }];

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'category-detail-unverified-use'), false);
});

test('an AI structure checkbox is diagnostic, but a reported unsupported claim remains blocking', () => {
  const value = inputs();
  value.aiResult.ruleSelfAudit.structureFollowed = false;

  const structureResult = validateTitleRuleContract(value);
  assert.equal(structureResult.passed, true);
  assert.equal(structureResult.checks.some(item => item.checkId === 'structure-self-audit' && item.status === 'WARN'), true);

  value.aiResult.ruleSelfAudit.unsupportedClaim = true;
  const claimResult = validateTitleRuleContract(value);
  assert.equal(claimResult.passed, false);
  assert.equal(claimResult.violations.some(item => item.checkId === 'unsupported-claim-self-audit'), true);
});

test('AI owns semantic side-conflict decisions rather than a keyword code gate', () => {
  const value = inputs();
  value.candidateTitle = '2008 Infiniti G35 Seat Belt Buckle Driver Left 12345';
  value.promptArtifact.userPayload.existingTitle = {
    currentTitle: '2008 Infiniti G35 Seat Belt Buckle Passenger Right 12345'
  };

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.checks.some(item => item.checkId === 'existing-title-side-conflict'), false);
});

test('missing title segments and self-audit do not alone make a title Needs Review', () => {
  const value = inputs();
  value.aiResult.titleSegments = [];
  value.aiResult.ruleSelfAudit = null;

  const result = validateTitleRuleContract(value);

  assert.equal(result.passed, true);
  assert.equal(result.violations.some(item => item.checkId === 'title-segments-missing'), false);
  assert.equal(result.checks.some(item => item.checkId === 'rule-self-audit-missing' && item.status === 'WARN'), true);
});
