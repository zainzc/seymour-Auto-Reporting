# Category Rules Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-21-category-rules-design.md`

**Goal:** Add the approved Category Rules configuration tab on top of Restricted Terms, with no runtime title behavior.

**Global constraints:** Work only in `feature/restricted-terms`; no merge/push; test-first; preserve malformed raw data; use explicit seed order; keep renderer behind narrow IPC.

## Task 1: Pure Category Rules domain service

**Create:**
- `electron_app/src/services/titleOptimizationCategoryRulesService.js`
- `electron_app/test/titleOptimizationCategoryRulesService.test.js`

Write failing tests for the exact 20 seeds and metadata, list/category normalization, list validation, seeded identity validation, deterministic sorting, full duplicate-name-group quarantine, and future enabled reads. Implement pure seed, validation, hydration, sorting, and enabled-read functions. Run the focused service test.

## Task 2: Audited repository and encrypted persistence contract

**Create:**
- `electron_app/src/services/titleOptimizationCategoryRulesRepository.js`
- `electron_app/test/titleOptimizationCategoryRulesRepository.test.js`

Write failing tests for first-run-only seeding, seeded immutability/deletion protection, seeded editable fields, custom CRUD/soft-delete, audit metadata, uniqueness including disabled records, name reuse after soft delete, malformed-entry preservation, failed-write atomicity, future reads, and serialized concurrent mutations. Implement repository operations: `load`, `saveRule`, `setRuleEnabled`, `softDelete`, `getTitleOptimizationCategoryRules`. Run focused service/repository tests.

## Task 3: Config store, IPC, preload, and main registration

**Create:**
- `electron_app/src/main/titleOptimizationCategoryRulesIpc.js`
- `electron_app/test/titleOptimizationCategoryRulesIpc.test.js`

**Modify:**
- `electron_app/src/config/configStore.js`
- `electron_app/src/preload/preload.js`
- `electron_app/src/main/index.js`

Write the failing IPC contract test, implement load/save/toggle/delete serialization, add encrypted key accessors, expose only narrow preload methods, and register the repository with the existing audit actor. Run focused IPC and repository tests.

## Task 4: Renderer controller and popup interaction

**Create:**
- `electron_app/src/renderer/pages/title-optimization/category-rules.js`
- `electron_app/test/titleOptimizationCategoryRulesRenderer.test.js`

Write failing controller tests for local drafts, seeded locks, chip validation, detail reordering, combined search/status/reference filters, immediate toggle rollback, custom deletion, dirty navigation, save failures, and deterministic order. Implement the pure controller and DOM binding without direct config-store access. Run focused renderer tests.

## Task 5: Category Rules page and navigation

**Create:**
- `electron_app/src/renderer/pages/title-optimization/category-rules.html`
- `electron_app/src/renderer/pages/title-optimization/category-rules.css`
- `electron_app/test/titleOptimizationCategoryRulesPage.test.js`

**Modify:**
- all six existing Title Optimization page HTML files
- affected existing navigation/page tests

Write failing structural/navigation tests. Implement the existing shell, enabled tab state, toolbar filters, vertically scrolling table, scrollable popup, accessible chip/reorder controls, dialogs, and information panel. Keep later tabs disabled. Run all Title Optimization tests.

## Task 6: Final verification and local Category Rules commit

Run focused Category Rules tests, all Title Optimization tests, full `npm test`, Node syntax checks, and `git diff --check`. Attempt `npm start` using the approved shared-dependency arrangement without installing/copying dependencies; record the precise blocker if Forge cannot resolve Electron. Review the full Category Rules diff against the approved spec, fix Critical/Important issues test-first, and commit all Category Rules changes in one local commit. Do not merge or push.

## Review focus

- Exact seed spellings/order/details/references/notes
- Seeded empty reference arrays cannot be changed
- Duplicate persisted names quarantine every member independent of storage order
- Invalid raw entries survive unrelated writes
- Rapid mutations cannot lose updates
- Popup list editing/reordering remains draft-only
- No runtime title, prefix, fitment, authorization, SKU, airbag, or publishing behavior
