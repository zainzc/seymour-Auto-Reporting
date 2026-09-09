# Title Optimization Source Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, persistent Source Fields configuration workspace backed by the live `eBay Listings (API)` schema.

**Architecture:** Put pure mapping rules in a CommonJS service, persistence/schema orchestration behind Electron IPC, and interaction/presentation in a focused vanilla renderer module. Reuse encrypted electron-store, AirtableSchemaService, preload isolation, and existing workspace styling.

**Tech Stack:** Electron 40, CommonJS, vanilla HTML/CSS/JavaScript, electron-store, axios, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-09-title-optimization-source-fields-design.md`

## Global Constraints

- Use “app user,” never “administrator,” in new product copy.
- Use the configured base and exact `eBay Listings (API)` table.
- Never expose Airtable credentials in the renderer or logs.
- Exact unique case-sensitive seed matching only; no fuzzy matching.
- No schema-refresh auto-retry for this feature.
- Preserve mappings and last-known schema on failures.
- Do not implement unfinished Title Optimization tabs.
- Do not refactor unrelated existing workspaces.

---

### Task 1: Pure source-mapping domain service

**Files:**
- Create: `src/services/titleOptimizationSourceFieldsService.js`
- Create: `test/titleOptimizationSourceFieldsService.test.js`

**Interfaces:**
- Produces: `seedSourceMappings(fields, audit)`, `validateAndHydrateConfiguration(raw)`, `getMappingStatus(mapping, fields)`, `validateMappingsForSave(mappings, fields)`, `createCustomMapping(input, mappings, audit)`, `updateMapping(id, changes, mappings, audit)`, `softDeleteCustomMapping(id, mappings, audit)`, `restoreCustomMapping(id, mappings, audit)`, `buildNormalizedTitleListingData(record, mappings)`.

- [ ] Write failing `node:test` cases for all seed mappings, unique exact matching, unmapped exceptions, mandatory validation, statuses, duplicate key rejection, protected edits/deletion, custom create/edit/delete/restore, malformed quarantine, and normalized custom fields.
- [ ] Run `node --test test/titleOptimizationSourceFieldsService.test.js` and confirm failures are caused by the missing service.
- [ ] Implement the minimal pure service and immutable return values.
- [ ] Re-run the focused tests and refactor only while green.

### Task 2: Persistence and secure schema orchestration

**Files:**
- Modify: `src/config/configStore.js`
- Modify: `src/services/airtableSchemaService.js`
- Create: `src/services/titleOptimizationSourceFieldsRepository.js`
- Create: `test/titleOptimizationSourceFieldsRepository.test.js`

**Interfaces:**
- Consumes: Task 1 validation/seeding/status functions.
- Produces: `createTitleOptimizationSourceFieldsRepository(dependencies)` with `load()`, `refreshFields()`, `save(mappings, actor)`, `softDelete(id, actor)`, `restore(id, actor)`, and `getTitleOptimizationSourceMappings()`.

- [ ] Write failing repository tests using an in-memory store and injected schema client for first run, reload, idempotent save, exact table selection, no retry, cached-schema preservation, empty schema, and partial-malformation behavior.
- [ ] Run the focused test and confirm expected failures.
- [ ] Add dedicated config-store getters/setters and a single-attempt option to AirtableSchemaService without changing its default behavior.
- [ ] Implement the repository with injected dependencies and sanitized metadata.
- [ ] Re-run both service and repository tests.

### Task 3: Electron IPC boundary

**Files:**
- Modify: `src/main/index.js`
- Modify: `src/preload/preload.js`
- Create: `test/titleOptimizationIpcContract.test.js`

**Interfaces:**
- Consumes: repository methods from Task 2.
- Produces renderer API: `load()`, `refreshFields()`, `save(mappings)`, `deleteCustomMapping(id)`.

- [ ] Write a failing contract test around handler registration and serialized safe results.
- [ ] Run it and confirm missing handler/API failures.
- [ ] Register IPC handlers that resolve existing Phase 2 credentials/base and current-user audit fallback entirely in the main process.
- [ ] Expose only the four narrow preload methods.
- [ ] Run IPC and domain tests.

### Task 4: Source Fields renderer and interactions

**Files:**
- Create: `src/renderer/pages/title-optimization/source-fields.html`
- Create: `src/renderer/pages/title-optimization/source-fields.css`
- Create: `src/renderer/pages/title-optimization/source-fields.js`
- Create: `test/titleOptimizationSourceFieldsRenderer.test.js`

**Interfaces:**
- Consumes: `window.titleOptimizationSourceFieldsAPI` from Task 3.
- Produces: accessible workspace, table, searchable field selects, add/edit dialog, delete confirmation, dirty/save/refresh/error states.

- [ ] Write renderer logic tests for rendered core rows, dropdown schema, status copy, edit/save, custom add/edit/delete, protected controls, refresh preservation, errors, and dirty-state navigation.
- [ ] Run the renderer test and confirm missing module failures.
- [ ] Implement state/render/event logic as an exportable factory usable both in browser and Node tests.
- [ ] Add semantic HTML with visible disabled tabs, modal form, error/status live regions, and table container.
- [ ] Add scoped three-layer CSS tokens and responsive styles matching the existing blue/teal workspace language.
- [ ] Re-run renderer and domain tests.

### Task 5: Milestone 1 workspace navigation

**Files:**
- Modify: `src/renderer/pages/milestone1/index.html`
- Modify: `src/renderer/pages/milestone1/powerlink-sheets.html`
- Modify: `src/renderer/pages/milestone1/phase2-master-parts.html`
- Modify: `src/renderer/pages/milestone1/phase5-batch-approval.html`
- Create: `test/titleOptimizationNavigation.test.js`

**Interfaces:**
- Produces: Title Optimization as the fourth Milestone 1 workspace tab and no separate dashboard card.

- [ ] Write a failing navigation behavior test that loads Milestone 1 navigation and expects the new route while the dashboard remains unchanged.
- [ ] Run it and confirm the Milestone 1 route is absent.
- [ ] Add Title Optimization to the Milestone 1 landing page and all workspace navigation bars.
- [ ] Re-run navigation and full feature tests.

### Task 6: Project scripts and full verification

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: repeatable `npm test` command for all `test/*.test.js` files.

- [ ] Add a test script after verifying the existing project has no conflicting runner.
- [ ] Run `npm test` and record pass/fail totals.
- [ ] Run `npm run lint` and record its configured result.
- [ ] Run `npm run package` as the available build/package check.
- [ ] Launch the Electron app and manually verify load, exact mappings, edit/save/reload, refresh, add/edit/delete, dirty navigation, and existing workspace links.
- [ ] Review the diff against every acceptance criterion and report any intentionally deferred item.
