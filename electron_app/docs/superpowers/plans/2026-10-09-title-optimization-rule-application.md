# Title Optimization Rule Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply active Title Optimization UI rules consistently, select truthful listing families and structures, reject explicit configuration-contract violations, and retain one semantic AI generation call with the independent reviewer disabled.

**Architecture:** Add one shared listing classifier and use it during rule resolution. Improve category matching and source evidence boundaries before extending the existing strict AI response with structured rule decisions. Add a focused post-generation contract validator for objective UI contracts while leaving automotive fitment interpretation to AI.

**Tech Stack:** Node.js CommonJS services, Electron, `node:test`, strict OpenAI JSON Schema, Airtable Phase 7.4 runtime, JSONL diagnostics.

**Spec:** `docs/superpowers/specs/2026-10-09-title-optimization-rule-application-design.md`

## Global Constraints

- Use active UI configuration as the source of rule behavior.
- Prefix `300` is an authoritative Engine family signal.
- Keep the independent AI fitment reviewer disabled.
- Preserve one normal semantic generation call; do not restore the removed reviewer.
- AI owns automotive interpretation; code owns applicability, evidence boundaries, and explicit contracts.
- Do not add listing-, SKU-, or IPN-specific output exceptions.
- Preserve manual override behavior, Prefix Rules, and Airtable write boundaries.
- Preserve current uncommitted work. Do not commit, discard, reset, or overwrite unrelated changes.

## Review Focus

- A generic part such as `Complete Assembly` with prefix `300` must still classify as Engine and receive engine restrictions.
- Generic HTML that explains both left and right must not resolve a listing side, while a listing-specific donor note still may.
- Similar category names must match configured categories without causing `Rear View Mirror` to match ordinary exterior mirrors incorrectly.
- A material fitment restriction scoped to only later years must not be silently treated as applying to none or all years.
- Existing persisted slash-combined priority details must remain readable and become independent decisions without corrupting saved configuration.

---

### Task 1: Shared Listing Family Classification

**Files:**
- Create: `src/services/titleOptimizationListingClassificationService.js`
- Modify: `src/services/titleOptimizationRuntimeRuleResolutionService.js:80-250`
- Test: `test/titleOptimizationListingClassification.test.js`
- Test: `test/titleOptimizationRuntimeRuleResolution.test.js`

**Interfaces:**
- Produces: `classifyTitleOptimizationListing({ listingResolution, context, prefixRule }): ListingClassification`
- `ListingClassification`: `{ family, resolved, sources, conflicts, reason }`
- `family`: `'engine' | 'transmission' | 'general'`
- Rule resolution exposes the result as `listingClassification` and uses it for structure and restricted scope.

- [ ] **Step 1: Write failing classification tests**

Cover prefix `300`, existing-title `Engine`, structured transmission identity, unrelated description text, and contradictory strong family signals. Assert that prefix `300` plus resolved part `Complete Assembly` returns `engine` with `ipnPrefix` evidence.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/titleOptimizationListingClassification.test.js test/titleOptimizationRuntimeRuleResolution.test.js`

Expected: FAIL because the shared classifier and `listingClassification` result do not exist.

- [ ] **Step 3: Implement the classifier**

Use only trusted normalized fields listed in the spec. Keep canonical prefix-family policy in this focused service as an immutable map containing `300: engine`. Return provenance for every accepted signal and preserve contradictory strong signals in `conflicts`.

- [ ] **Step 4: Integrate classification with structure and restricted scope**

Replace `isEngineContext()` and `isTransmissionContext()` decisions in rule resolution with the shared classification. Select Engines/Transmissions by family while preserving custom-structure precedence.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/titleOptimizationListingClassification.test.js test/titleOptimizationRuntimeRuleResolution.test.js test/titleOptimizationRuntimePromptBuilder.test.js`

Expected: all pass; prefix `300` selects Engines and includes engine-scoped Restricted Terms.

- [ ] **Step 6: Check the task diff**

Run: `git diff --check -- src/services/titleOptimizationListingClassificationService.js src/services/titleOptimizationRuntimeRuleResolutionService.js test/titleOptimizationListingClassification.test.js test/titleOptimizationRuntimeRuleResolution.test.js`

### Task 2: Configuration-Driven Category Matching

**Files:**
- Create: `src/services/titleOptimizationRuleMatchingService.js`
- Modify: `src/services/titleOptimizationRuntimeRuleResolutionService.js:150-250`
- Modify: `src/services/titleOptimizationRuntimePromptBuilderService.js:70-180`
- Test: `test/titleOptimizationRuleMatching.test.js`
- Test: `test/titleOptimizationRuntimeRuleResolution.test.js`
- Test: `test/titleOptimizationRuntimePromptBuilder.test.js`

**Interfaces:**
- Produces: `matchCategoryRule({ rule, context, terminologyRules, synonymRules }): { matched, methods, evidence }`
- Produces: `splitPriorityDetails(details): string[]`
- Rule resolution stores `matchedBy`, `matchEvidence`, and normalized independent `priorityDetails`.

- [ ] **Step 1: Write failing matcher tests**

Assert configured matches for `Side View Mirror -> Mirrors`, `Taillight Assembly -> Tail Lights`, `Seat Belt -> Seat Belts`, `Headlight Assembly -> Headlights`, `Fuel Door -> Fuel Doors`, and `Rear-View Mirror -> Rear View Mirrors`. Assert unrelated partial words do not match.

- [ ] **Step 2: Add backward-compatibility tests for combined details**

Assert `Wiper / Turn Signal / Multifunction` becomes three decisions and `Speedometer / Tachometer` becomes two, while `With / Without Illumination` remains one semantic configured detail because the slash expresses a binary attribute label.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/titleOptimizationRuleMatching.test.js test/titleOptimizationRuntimeRuleResolution.test.js test/titleOptimizationRuntimePromptBuilder.test.js`

- [ ] **Step 4: Implement normalized matching**

Normalize case, whitespace, punctuation, hyphens, safe singular/plural forms, configured terminology equivalents, and configured synonyms. Ignore generic suffix `Assembly` only in the match key. Keep exact prefix and series references authoritative.

- [ ] **Step 5: Integrate independent priority details into prompt schema input**

Ensure Category Rule payload and configured enum contain the independent detail names exactly once, with match methods available in logs.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test test/titleOptimizationRuleMatching.test.js test/titleOptimizationRuntimeRuleResolution.test.js test/titleOptimizationRuntimePromptBuilder.test.js test/titleOptimizationCategoryRulesService.test.js`

- [ ] **Step 7: Check the task diff**

Run: `git diff --check -- src/services/titleOptimizationRuleMatchingService.js src/services/titleOptimizationRuntimeRuleResolutionService.js src/services/titleOptimizationRuntimePromptBuilderService.js test/titleOptimizationRuleMatching.test.js test/titleOptimizationRuntimeRuleResolution.test.js test/titleOptimizationRuntimePromptBuilder.test.js`

### Task 3: Listing-Specific Source Evidence Boundaries

**Files:**
- Modify: `src/services/titleOptimizationRuntimeSourceResolutionService.js:150-760`
- Modify: `src/services/titleOptimizationEvidencePolicy.js`
- Test: `test/titleOptimizationRuntimeSourceResolution.test.js`

**Interfaces:**
- Source-resolution evidence gains `contentRole: 'listing-specific' | 'boilerplate'`.
- `deriveSideFromText(text, options)` consumes `{ contentRole, sourceFieldName }` and returns no side for boilerplate/general side definitions.
- Resolved conflicts preserve listing-specific opposite sides and exclude ignored boilerplate candidates.

- [ ] **Step 1: Write failing source-boundary tests**

Assert the generic sentence `LEFT IS DRIVERS SIDE AND RIGHT IS THE PASSENGERS SIDE` produces no side candidate. Assert listing-specific title, Item Specifics, fitment row, and donor note examples still produce side evidence.

- [ ] **Step 2: Add the audited conflict regression**

Model the `1592643` evidence shape: Passenger/Right existing title plus Driver/Left fitment. Assert the conflict remains explicit and generic HTML cannot become the winner.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/titleOptimizationRuntimeSourceResolution.test.js`

- [ ] **Step 4: Implement source-role filtering**

Classify parsed HTML sections before deriving facts. Permit donor notes and fitment sections; reject warranty, shipping, definitions, examples, and generic left/right explanatory text.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/titleOptimizationRuntimeSourceResolution.test.js test/titleOptimizationVehicleDecision.test.js`

- [ ] **Step 6: Check the task diff**

Run: `git diff --check -- src/services/titleOptimizationRuntimeSourceResolutionService.js src/services/titleOptimizationEvidencePolicy.js test/titleOptimizationRuntimeSourceResolution.test.js`

### Task 4: Structured Single-Call AI Rule Decisions

**Files:**
- Modify: `src/services/titleOptimizationRuntimePromptBuilderService.js:190-460`
- Modify: `src/services/phase4AiEvaluatorService.js:1520-1660`
- Test: `test/titleOptimizationRuntimePromptBuilder.test.js`
- Create: `test/phase4AiEvaluatorService.test.js`

**Interfaces:**
- AI output adds:
  - `materialRestrictions: Array<{ detail, appliesTo, sourceRowIds, material, titleTreatment }>`
  - `restrictedTermDecisions: Array<{ term, used, authorized, source, evidence }>`
  - `titleSegments: Array<{ key, value }>`
  - `ruleSelfAudit: { structureFollowed, unresolvedSourceConflict, unsupportedClaim, notes }`
- Existing output keys remain unchanged.

- [ ] **Step 1: Write failing prompt tests**

Assert the payload contains listing classification, category match provenance, ignored boilerplate summary, applicable restrictions, and instructions requiring year-scoped material restriction treatment.

- [ ] **Step 2: Write failing strict-schema tests**

Assert the OpenAI schema requires all four new fields, uses supplied category-detail enums, and restricts `titleTreatment` to `included`, `not-applicable-to-selected-application`, or `needs-review`.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js test/phase4AiEvaluatorService.test.js`

- [ ] **Step 4: Extend prompt construction**

Send only applicable terminology, synonym, prefix, category, structure, and restricted rules. Require AI to identify every material restriction in selected rows before composing title segments.

- [ ] **Step 5: Extend response schema and parser**

Add strict schemas and normalized parser output for the four fields. Keep malformed response retry behavior unchanged.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js test/phase4AiEvaluatorService.test.js test/phase74AiRequestLog.test.js`

- [ ] **Step 7: Check the task diff**

Run: `git diff --check -- src/services/titleOptimizationRuntimePromptBuilderService.js src/services/phase4AiEvaluatorService.js test/titleOptimizationRuntimePromptBuilder.test.js test/phase4AiEvaluatorService.test.js`

### Task 5: Objective Rule Contract Enforcement

**Files:**
- Create: `src/services/titleOptimizationRuleContractService.js`
- Modify: `src/services/titleOptimizationAiDecisionService.js`
- Modify: `src/services/titleOptimizationRuntimeService.js:250-560`
- Test: `test/titleOptimizationRuleContract.test.js`
- Test: `test/titleOptimizationRuntimeService.test.js`

**Interfaces:**
- Produces: `validateTitleRuleContract({ aiResult, sourceResolution, ruleResolution, promptArtifact }): ContractResult`
- `ContractResult`: `{ passed, normalizedTitle, checks, reviewReason, reviewNotes }`
- `checks` contain stable IDs for restricted authorization, structure segments, category evidence, side evidence/conflict, fitment row IDs, material restriction treatment, configured-equivalent duplication, SKU, and length.
- Runtime combines this result with existing mechanical validation before `decideAiTitle()`.

- [ ] **Step 1: Write failing restricted-term tests**

Assert prefix `300` plus unauthorized `Complete Assembly` cannot complete. Assert the same term can complete only with an applicable `authorized: true` decision citing supplied authorization evidence.

- [ ] **Step 2: Write failing structure and category tests**

Assert ordered `titleSegments` must reconstruct the title in selected structure order. Assert a category detail used in a Completed title requires a verified decision and valid supplied evidence ID.

Assert terminology/synonym-normalized duplicate concepts such as `Fuel Door Gas Fuel Door` cannot complete, while legitimate distinct phrases are unchanged.

- [ ] **Step 3: Write failing source-conflict and fitment tests**

Assert unresolved Passenger/Right versus Driver/Left cannot complete. Assert all selected row IDs exist. Assert a material restriction cannot have missing treatment or `needs-review` while status is Completed.

- [ ] **Step 4: Add regression tests for objective rules**

Preserve whitespace cleanup, 80 characters, ordinary SKU ending, prefix `257` hash ending, manual override, malformed-response retry, mechanical compression, and disabled independent reviewer.

- [ ] **Step 5: Run tests and verify RED**

Run: `node --test test/titleOptimizationRuleContract.test.js test/titleOptimizationRuntimeService.test.js`

- [ ] **Step 6: Implement the focused contract validator**

Do not parse automotive meaning from free text. Validate only supplied IDs, explicit booleans/enums, configured terms, normalized segment reconstruction, unresolved source conflicts, and mechanical constraints.

- [ ] **Step 7: Integrate contract failures with configured review reasons**

Use the closest active Flag Reason. Preserve the AI proposal for logs/notes, prevent an unsafe title write, and do not invoke `reviewTitleFitment` when `enableIndependentAiReview` is false.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run: `node --test test/titleOptimizationRuleContract.test.js test/titleOptimizationRuntimeService.test.js test/titleOptimizationRuntimeDecision.test.js test/phase74TitleDescriptionService.test.js`

- [ ] **Step 9: Check the task diff**

Run: `git diff --check -- src/services/titleOptimizationRuleContractService.js src/services/titleOptimizationAiDecisionService.js src/services/titleOptimizationRuntimeService.js test/titleOptimizationRuleContract.test.js test/titleOptimizationRuntimeService.test.js`

### Task 6: Rule Decision Logging and End-to-End Verification

**Files:**
- Modify: `src/services/titleOptimizationRuntimeService.js:530-565`
- Modify: `src/services/phase74TitleDescriptionService.js:1190-1220`
- Modify: `src/services/phase74AiRequestLog.js`
- Test: `test/phase74AiRequestLog.test.js`
- Test: `test/titleOptimizationRuntimeService.test.js`
- Test: `test/phase74TitleDescriptionService.test.js`

**Interfaces:**
- Runtime result adds `ruleDecision` with classification, ignored evidence, matched rules, selected structure, restrictions, conflicts, checks, and final disposition.
- JSONL `result` events persist the compact `ruleDecision` object.

- [ ] **Step 1: Write failing logging tests**

Assert each runtime result and JSONL result entry exposes a compact `ruleDecision` without raw HTML, credentials, or OpenAI authorization headers.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/phase74AiRequestLog.test.js test/titleOptimizationRuntimeService.test.js test/phase74TitleDescriptionService.test.js`

- [ ] **Step 3: Implement compact rule-decision assembly and persistence**

Reuse existing classification, rule resolution, AI decisions, and contract checks. Do not duplicate policy evaluation in the logger.

- [ ] **Step 4: Run all Title Optimization tests**

Run: `node --test test/titleOptimization*.test.js test/phase74*.test.js`

On Windows PowerShell, enumerate files first if wildcard expansion is rejected, then pass the explicit file list to `node --test`.

Expected: all pass.

- [ ] **Step 5: Run the full regression suite**

Run: `npm.cmd test`

Expected: all tests pass with no new warnings except existing dependency deprecations.

- [ ] **Step 6: Verify module loading**

Run: `node -e "require('./src/services/titleOptimizationListingClassificationService'); require('./src/services/titleOptimizationRuleMatchingService'); require('./src/services/titleOptimizationRuleContractService'); require('./src/services/titleOptimizationRuntimeService'); console.log('ok')"`

Expected: `ok`.

- [ ] **Step 7: Run final diff validation**

Run: `git diff --check`

Expected: exit code 0. Existing line-ending notices are informational.

- [ ] **Step 8: Inspect final working-tree scope**

Run: `git status --short` and `git diff --stat`.

Confirm no unrelated file was modified or removed. Do not commit unless explicitly requested.

## Manual Production Evaluation

After automated verification, run a fresh controlled 100-record UI batch. Use the generated JSONL `ruleDecision` entries to compare against the October 8 audit:

- Category Rule coverage should include mirrors, tail lights, seat belts, fuel doors, headlights, and rear-view mirrors.
- Prefix `300` records should select Engines.
- No unauthorized restricted term should be Completed.
- Generic HTML boilerplate should not produce side evidence.
- Opposite listing-specific sides should remain Needs Review.
- Material year-scoped restrictions should be included, scoped through a truthful selected application, or explicitly reviewed.
- Every written title should satisfy structure, SKU, and 80-character contracts.
- The log must show zero independent-review requests.
