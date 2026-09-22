# Title Optimization Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic read-only Title Optimization Overview with a dense, responsive control-center dashboard composed exclusively from the ten existing owning services.

**Architecture:** Expand the existing read-only Overview aggregation service so it normalizes service-owned display data, counts, timestamps, warnings, availability, and canonical System Rules metadata without duplicating validation or persistence. Render that payload through the existing Overview IPC bridge into a semantic dashboard using the established Title Optimization shell and design tokens.

**Tech Stack:** Electron, CommonJS, vanilla HTML/CSS/JavaScript, Node.js built-in test runner.

**Spec:** `C:/Users/hp/.codex/attachments/e8421e8c-cc62-4820-b2e2-ada7f6177205/pasted-text.txt` plus the approved interview corrections in the active conversation.

## Global Constraints

- Overview is read-only and must not create configuration persistence or mutation IPC.
- Preserve owning-service deterministic order; preview limits are Source Fields 8, Source Priority 9, Terminology 5, Synonyms 5, Prefix Rules 5, and Title Structure names 3.
- Configuration Version comes only from canonical System Rules metadata; Last Updated comes only from valid timestamps across the nine editable services.
- Active Configuration Items is numeric only when all nine editable services load; otherwise it is `Unavailable`.
- Omit Preferred Title Length and Test Playground entirely.
- Preserve every warning's owner order, ID, and details; service failures remain availability states.
- Do not change other tabs, add runtime title generation, merge, or push.

## Review Focus

- A malformed service payload must not crash the entire dashboard; the owning section should remain usable or clearly unavailable according to the loader outcome.
- Invalid timestamps must be ignored without falling back to schema, process, or System Rules timestamps.
- A disabled Synonym master must contribute zero active Synonym rules while retaining the real preview/status.
- Warning objects with IDs and structured details must survive aggregation without rewriting.
- Responsive reflow must not select different preview records or expose mutation controls.

---

### Task 1: Define the Overview aggregation contract

**Files:**
- Modify: `electron_app/test/titleOptimizationOverviewService.test.js`
- Modify: `electron_app/src/services/titleOptimizationOverviewService.js`

**Interfaces:**
- Consumes: the ten existing loader functions keyed by `SECTION_ORDER`.
- Produces: `createTitleOptimizationOverviewService(loaders).load()` returning hero metadata, five summary cards' data, previews, compact summaries, grouped warnings, availability, and canonical safety highlights.

- [ ] **Step 1: Write failing service tests** covering deterministic preview limits/order, five-card source values, canonical `v5`, latest valid editable timestamp, active-item counting, Synonym master-off behavior, all-or-nothing active total, warning identity/detail preservation, empty payloads, and unavailable services.
- [ ] **Step 2: Run `node --test test/titleOptimizationOverviewService.test.js` and confirm the new assertions fail.**
- [ ] **Step 3: Implement minimal pure aggregation helpers** for service-specific item extraction, active counting, preview shaping, timestamp selection, warning grouping, and System Rules metadata/highlights.
- [ ] **Step 4: Run the focused service test and confirm it passes.**

### Task 2: Build the dense read-only dashboard renderer

**Files:**
- Modify: `electron_app/test/titleOptimizationOverviewPage.test.js`
- Modify: `electron_app/src/renderer/pages/title-optimization/overview.html`
- Modify: `electron_app/src/renderer/pages/title-optimization/overview.js`
- Modify: `electron_app/src/renderer/pages/title-optimization/overview.css`

**Interfaces:**
- Consumes: the Task 1 Overview payload through `window.titleOptimizationOverviewAPI.load()`.
- Produces: hero/status panel, five summary cards, Source Fields/Priority and main rule previews, compact remaining-tab summaries, scrollable warning rail, canonical safety highlights, empty/unavailable states, and owning-tab navigation.

- [ ] **Step 1: Write failing page tests** for the dashboard regions, exact five summary cards, read-only behavior, navigation actions, warning rail, empty/unavailable templates, no Test Playground, and no fake/sample data.
- [ ] **Step 2: Run `node --test test/titleOptimizationOverviewPage.test.js` and confirm the new assertions fail.**
- [ ] **Step 3: Replace the Overview markup** with semantic dashboard regions while retaining the existing shell, hero, internal navigation, and refresh action.
- [ ] **Step 4: Implement escaped rendering helpers** for tables, badges, summary cards, warning groups, empty/unavailable states, and local date formatting without changing record selection.
- [ ] **Step 5: Implement responsive dashboard CSS** using existing tokens, clear visual priority, accessible focus states, a bounded warning scroller, and horizontal table overflow only where required.
- [ ] **Step 6: Run page and navigation tests and confirm they pass.**

### Task 3: Verify integration and commit the isolated feature

**Files:**
- Verify: `electron_app/src/main/titleOptimizationOverviewIpc.js`
- Verify: `electron_app/src/preload/preload.js`
- Verify all changed files from Tasks 1–2.

**Interfaces:**
- Consumes: existing read-only `title-optimization-overview:load` IPC.
- Produces: one local Overview redesign commit on `feature/title-optimization-overview-redesign`.

- [ ] **Step 1: Run focused Overview service/page/IPC tests.**
- [ ] **Step 2: Run the complete Title Optimization regression suite.**
- [ ] **Step 3: Run the full application test suite, JavaScript syntax checks for changed JS, and `git diff --check`.**
- [ ] **Step 4: Attempt the Electron smoke test using the existing dependency layout; report the exact blocker without changing dependency architecture if launch is unavailable.**
- [ ] **Step 5: Inspect the final diff for Overview-only scope and absence of persistence/mutation/runtime-AI changes.**
- [ ] **Step 6: Commit the implementation locally and record the hash; do not merge or push.**

