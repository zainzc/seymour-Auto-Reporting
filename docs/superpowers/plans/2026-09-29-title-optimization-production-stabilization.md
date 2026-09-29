# Title Optimization Production Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Phase 7.4 write only unambiguous, validated titles to `Item Title` while preserving existing output and recording actionable review details for every rejected result.

**Architecture:** Keep the existing source-resolution, rule-resolution, AI generation, validation, decision, and Airtable-write pipeline. Change fitment selection into deterministic classification, make the prompt and validator consume that classification, derive review output exclusively from the final decision, and gate the Airtable title write on an accepted decision.

**Tech Stack:** Node.js CommonJS, Electron 40, Node built-in test runner, Airtable service integration.

**Spec:** `docs/superpowers/specs/2026-09-29-title-optimization-production-stabilization-design.md`

## Global Constraints

- Never modify Airtable `Title`; it is source evidence and the no-degrade baseline.
- Write Airtable `Item Title` only for a deterministically accepted Completed result.
- Leave `Item Title` unchanged for Needs Review, blocked, failed, degrading, or manually overridden results.
- Do not ask AI to select or merge multiple distinct fitment applications or year ranges.
- Preserve Prefix Rules, terminology normalization, title structures, SKU rules, Part Fitment evidence, 80-character validation, and no-degrade protection.
- Do not reactivate the legacy generator or redesign unrelated Phase 7.4 functionality.

## Review Focus

- A repeated fitment clause with punctuation/case differences must collapse to one application, not create false ambiguity (Task 1).
- Overlapping ranges with different models or qualifiers must remain distinct and require review (Task 1).
- A malformed or partially parseable Part Fitment value must not be treated as one verified application (Task 2).
- A stale `Item Title` must remain byte-for-byte unchanged when a later run needs review (Task 4).
- A Completed result must clear stale review wording and must never inherit contradictory AI review text (Task 3).

---

### Task 1: Deterministic Fitment Classification

**Files:**
- Modify: `electron_app/src/services/titleOptimizationFitmentSelectionService.js`
- Test: `electron_app/test/titleOptimizationRuntimePromptBuilder.test.js`

**Interfaces:**
- Produces: `selectTitleFitmentCandidates(listingResolution)` returning `{ status, selectionFacts, candidates, distinctApplications, resolution }`, where `resolution` is `UNAMBIGUOUS`, `AMBIGUOUS`, or `UNAVAILABLE`.
- Produces: each normalized application with stable `id`, `startYear`, `endYear`, `evidence`, and a canonical comparison key.

- [ ] **Step 1: Write failing fitment-classification tests**

Add tests asserting one application is `UNAMBIGUOUS`, equivalent duplicate clauses collapse to one application, and different year/model/qualifier applications are `AMBIGUOUS` even when donor year matches one candidate.

- [ ] **Step 2: Run the prompt-builder test and verify failure**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js`
Expected: FAIL because the current selector filters multiple applications to one and does not expose `resolution` or `distinctApplications`.

- [ ] **Step 3: Implement fitment parsing, canonical deduplication, and classification**

Retain trusted values as diagnostics in `selectionFacts`, but never use donor year/make/model to discard a distinct application. Collapse only applications equivalent after approved textual normalization.

- [ ] **Step 4: Run the prompt-builder test and verify it passes**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron_app/src/services/titleOptimizationFitmentSelectionService.js electron_app/test/titleOptimizationRuntimePromptBuilder.test.js
git commit -m "fix(title-optimization): classify ambiguous fitment"
```

### Task 2: Prompt And Validator Fitment Enforcement

**Files:**
- Modify: `electron_app/src/services/titleOptimizationRuntimePromptBuilderService.js`
- Modify: `electron_app/src/services/titleOptimizationVehicleDecisionService.js`
- Modify: `electron_app/src/services/titleOptimizationRuntimeValidatorService.js`
- Test: `electron_app/test/titleOptimizationRuntimePromptBuilder.test.js`
- Test: `electron_app/test/titleOptimizationVehicleDecision.test.js`
- Test: `electron_app/test/titleOptimizationRuntimeValidator.test.js`

**Interfaces:**
- Consumes: Task 1 `resolution` and `distinctApplications`.
- Produces: validator outcome `FLAG` with a failed/warning check `multiple-fitment-applications` and suggested configured reason `Multiple year ranges require review` for ambiguous fitment.

- [ ] **Step 1: Write failing prompt, vehicle-decision, and validator tests**

Assert the prompt supplies one verified application only when `UNAMBIGUOUS`; ambiguous applications are diagnostic-only and the instructions prohibit choosing/merging them. Assert ambiguous, malformed, and partially parseable fitment cannot validate a model-selected application.

- [ ] **Step 2: Run the three targeted files and verify failure**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js test/titleOptimizationVehicleDecision.test.js test/titleOptimizationRuntimeValidator.test.js`
Expected: FAIL on current “select exactly one candidate” behavior.

- [ ] **Step 3: Update prompt construction and vehicle validation**

Replace the single-candidate-selection instruction with deterministic fitment-resolution instructions. Ensure vehicle decisions can cite only the sole unambiguous application and cannot convert ambiguity into acceptance.

- [ ] **Step 4: Add validator ambiguity check**

Emit a specific check containing normalized conflicting applications and the approved review reason; do not merge separate ranges or accept an AI-selected candidate.

- [ ] **Step 5: Run the three targeted files and verify they pass**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js test/titleOptimizationVehicleDecision.test.js test/titleOptimizationRuntimeValidator.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron_app/src/services/titleOptimizationRuntimePromptBuilderService.js electron_app/src/services/titleOptimizationVehicleDecisionService.js electron_app/src/services/titleOptimizationRuntimeValidatorService.js electron_app/test/titleOptimizationRuntimePromptBuilder.test.js electron_app/test/titleOptimizationVehicleDecision.test.js electron_app/test/titleOptimizationRuntimeValidator.test.js
git commit -m "fix(title-optimization): enforce verified fitment decisions"
```

### Task 3: Deterministic Review Output And Accepted-Title Contract

**Files:**
- Modify: `electron_app/src/services/titleOptimizationRuntimeDecisionService.js`
- Modify: `electron_app/src/services/titleOptimizationRuntimeService.js`
- Test: `electron_app/test/titleOptimizationRuntimeDecision.test.js`
- Test: `electron_app/test/titleOptimizationRuntimeService.test.js`

**Interfaces:**
- Produces: runtime `output` with `title` populated only for `ACCEPT_CANDIDATE`; `proposedTitle` retained separately for diagnostics/review notes; deterministic `reviewStatus`, `reviewReason`, and `reviewNotes`.
- Produces: final runtime log fields `existingTitle`, `proposedTitle`, `acceptedTitle`, `fitmentResolution`, `fitmentApplications`, `decision`, `failedChecks`, and `titleWriteAction`.

- [ ] **Step 1: Write failing decision/output tests**

Cover accepted, Needs Review, retain-existing, blocked, overlength, runtime-failure, and manual-override paths. Assert rejected outputs do not expose a writable title, notes contain the proposal and exact checks, and Completed clears stale/model-provided review contradictions.

- [ ] **Step 2: Run decision and runtime tests and verify failure**

Run: `node --test test/titleOptimizationRuntimeDecision.test.js test/titleOptimizationRuntimeService.test.js`
Expected: FAIL because `writableOutput` currently puts review proposals into `title`.

- [ ] **Step 3: Implement accepted-title-only output**

Change `writableOutput(aiResult, decision, proposedTitle)` so only `ACCEPT_CANDIDATE` returns a writable `title`; all nonaccepted decisions retain `proposedTitle` in notes/diagnostics and use decision-derived status/reason.

- [ ] **Step 4: Add deterministic logging fields**

Log the fitment classification and explicit Airtable action (`WRITE_ITEM_TITLE` or `PRESERVE_ITEM_TITLE`) without removing existing payload diagnostics.

- [ ] **Step 5: Run decision and runtime tests and verify they pass**

Run: `node --test test/titleOptimizationRuntimeDecision.test.js test/titleOptimizationRuntimeService.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron_app/src/services/titleOptimizationRuntimeDecisionService.js electron_app/src/services/titleOptimizationRuntimeService.js electron_app/test/titleOptimizationRuntimeDecision.test.js electron_app/test/titleOptimizationRuntimeService.test.js
git commit -m "fix(title-optimization): gate output on accepted decisions"
```

### Task 4: Airtable Write Safety

**Files:**
- Modify: `electron_app/src/services/phase74TitleDescriptionService.js`
- Create: `electron_app/test/phase74TitleDescriptionService.test.js`

**Interfaces:**
- Consumes: Task 3 runtime output and decision.
- Produces: Airtable updates that never include `Title`, and include `Item Title` only when decision is `ACCEPT_CANDIDATE` with a nonblank title of at most 80 characters.

- [ ] **Step 1: Write failing Airtable update tests**

Assert accepted output writes `Item Title`; Needs Review, retained, blocked, failed, and manual override preserve an existing or blank `Item Title`; rejected proposal and exact check details are written to review fields; `Title` is never included.

- [ ] **Step 2: Run the Phase 7.4 service test and verify failure**

Run: `node --test test/phase74TitleDescriptionService.test.js`
Expected: FAIL because the current service writes any nonblank runtime `output.title`.

- [ ] **Step 3: Gate `Item Title` updates on the runtime decision**

Use `runtimeResult.decision.decision === 'ACCEPT_CANDIDATE'` plus the final length/nonblank guard. Preserve description behavior unless its manual-override rules already block it. Keep review-field updates independent of the title write.

- [ ] **Step 4: Run the Phase 7.4 service test and verify it passes**

Run: `node --test test/phase74TitleDescriptionService.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron_app/src/services/phase74TitleDescriptionService.js electron_app/test/phase74TitleDescriptionService.test.js
git commit -m "fix(phase74): preserve unapproved Airtable titles"
```

### Task 5: Rule Accuracy Regressions And Final Verification

**Files:**
- Modify: `electron_app/src/services/titleOptimizationRuntimeRuleResolutionService.js`
- Modify: `electron_app/src/services/titleOptimizationRuntimeValidatorService.js`
- Test: `electron_app/test/titleOptimizationRuntimeRuleResolution.test.js`
- Test: `electron_app/test/titleOptimizationRuntimeValidator.test.js`
- Test: `electron_app/test/titleOptimizationRuntimeDecision.test.js`

**Interfaces:**
- Consumes: existing configured category details, terminology rules, and title structures.
- Produces: part-family-specific structure selection and category field-concept verification using actual resolved values.

- [ ] **Step 1: Write failing rule-accuracy tests**

Assert a wiper motor cannot select a transmission structure or require a transmission code; category detail `Color` is verified by an actual resolved color such as `Beige`; unsupported category details remain unusable; no-degrade rejects unsupported vehicle/side/year changes and loss of verified important details.

- [ ] **Step 2: Run rule-resolution, validator, and decision tests and verify failure**

Run: `node --test test/titleOptimizationRuntimeRuleResolution.test.js test/titleOptimizationRuntimeValidator.test.js test/titleOptimizationRuntimeDecision.test.js`
Expected: FAIL for any still-present structure/category/no-degrade defects.

- [ ] **Step 3: Correct structure applicability and category concept resolution**

Keep configured matching semantics; limit transmission structure/checks to verified transmission context and resolve known field concepts through structured source values rather than literal-label matching.

- [ ] **Step 4: Run all focused Title Optimization runtime tests**

Run: `node --test test/titleOptimizationRuntimePromptBuilder.test.js test/titleOptimizationVehicleDecision.test.js test/titleOptimizationRuntimeValidator.test.js test/titleOptimizationRuntimeDecision.test.js test/titleOptimizationRuntimeService.test.js test/titleOptimizationRuntimeRuleResolution.test.js test/phase74TitleDescriptionService.test.js`
Expected: PASS with zero failures.

- [ ] **Step 5: Run all Title Optimization tests**

Run: `node --test test/titleOptimization*.test.js test/phase74TitleDescriptionService.test.js`
Expected: PASS with zero failures.

- [ ] **Step 6: Run the full regression suite**

Run: `npm test`
Expected: PASS with zero failures.

- [ ] **Step 7: Check whitespace and final status**

Run: `git diff --check`
Expected: no errors. Then run `git status --short` and confirm only intended implementation/test files remain before the final commit.

- [ ] **Step 8: Commit**

```bash
git add electron_app/src/services/titleOptimizationRuntimeRuleResolutionService.js electron_app/src/services/titleOptimizationRuntimeValidatorService.js electron_app/test/titleOptimizationRuntimeRuleResolution.test.js electron_app/test/titleOptimizationRuntimeValidator.test.js electron_app/test/titleOptimizationRuntimeDecision.test.js
git commit -m "fix(title-optimization): finalize production validation"
```
