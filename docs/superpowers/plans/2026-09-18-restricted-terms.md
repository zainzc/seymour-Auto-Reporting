# Restricted Terms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Restricted Terms configuration tab to the existing Title Optimization Workspace.

**Architecture:** Reuse the Prefix Rules service/repository/IPC/preload/page pattern. A pure service owns the exact 20 seeds, validation, hydration, and safety-invariant future read; a repository owns encrypted-store persistence and audit; renderer owns popup-only editing and navigation guards.

**Tech Stack:** Electron, CommonJS Node services, Electron-store, vanilla HTML/CSS/JS, Node `node:test`.

**Spec:** User-provided `C:/Users/hp/.codex/attachments/cc4c9628-5204-4b2c-92c1-ee48d2607e83/pasted-text.txt` plus approved chat decisions: immutable seeded term/type/scope, globally unique term, in-memory mandatory Long/Short Block fallback.

## Global Constraints

- Configuration only; no title runtime enforcement, AI, Airtable, publishing, or other unfinished tabs.
- Seed exactly 20 written-spec rules only on absent storage.
- Long Block and Short Block are immutable, enabled Engine invariants; runtime read injects them in memory if saved data is missing/invalid/disabled, while storage remains untouched and UI warns.
- Existing seeded rules cannot be deleted; custom rules soft-delete with audit metadata.
- Add/Edit uses a popup, not a right-side editor; reuse existing top navigation and tokens.
- Keep changes local; no GitHub push.

---

### Task 1: Pure rules and safety invariants

**Files:** Create `electron_app/src/services/titleOptimizationRestrictedTermsService.js`; test `electron_app/test/titleOptimizationRestrictedTermsService.test.js`.

**Interfaces:** Produce `seedRestrictedTermsConfiguration({now,actor})`, `validateRestrictedTerm(rule, peers)`, `hydrateRestrictedTermsConfiguration(raw)`, `enabledRestrictedTerms(hydrated)`.

- [ ] Write tests that assert the exact literal 20-term list, locked Engine metadata, normalized uniqueness including disabled peers, partial corruption isolation, and in-memory safety fallback with warning.
- [ ] Run `node --test test/titleOptimizationRestrictedTermsService.test.js`; confirm expected failures because service is absent.
- [ ] Implement constants, deterministic seed order, validation, hydration, and future read in the service. Keep fallback objects out of the persisted raw configuration.
- [ ] Re-run the focused service tests to green.

### Task 2: Persistence and audit

**Files:** Create `electron_app/src/services/titleOptimizationRestrictedTermsRepository.js`; modify `electron_app/src/config/configStore.js`; test `electron_app/test/titleOptimizationRestrictedTermsRepository.test.js`.

**Interfaces:** Produce repository methods `load()`, `saveRule(input)`, `setRuleEnabled(id,enabled)`, `softDelete(id)`, `getTitleOptimizationRestrictedTerms()`; store accessors `getTitleOptimizationRestrictedTerms` and `saveTitleOptimizationRestrictedTerms` for `titleOptimization.restrictedTerms`.

- [ ] Write failing tests for first-run-only seed, existing malformed storage preservation, immutable seeded identity/scope, locked toggles, custom CRUD/soft-delete, actor timestamps, persistence failure rollback, and future read fallback.
- [ ] Run focused repository tests and confirm expected failures.
- [ ] Implement repository with existing Prefix Rules dependency-injection pattern, but reject seeded term/type/scope edits and locked disable. Preserve invalid raw entries on valid edits.
- [ ] Re-run focused repository tests to green.

### Task 3: Secure app integration

**Files:** Create `electron_app/src/main/titleOptimizationRestrictedTermsIpc.js`; modify `electron_app/src/main/index.js`, `electron_app/src/preload/preload.js`; test `electron_app/test/titleOptimizationRestrictedTermsIpc.test.js`.

**Interfaces:** IPC channels `title-optimization-restricted-terms:load|save|toggle|delete` return serializable `{success,data|error}`. Expose only corresponding methods on `titleOptimizationRestrictedTermsAPI`.

- [ ] Write failing IPC/preload tests that reject direct storage/credential exposure and verify serialized failures.
- [ ] Run focused IPC tests and confirm expected failures.
- [ ] Wire repository using `getTitleOptimizationActor` and the new config-store accessors.
- [ ] Re-run focused IPC tests to green.

### Task 4: Popup UI and tab navigation

**Files:** Create `electron_app/src/renderer/pages/title-optimization/restricted-terms.html`, `.css`, `.js`; modify the five existing Title Optimization HTML tabs; test `electron_app/test/titleOptimizationRestrictedTermsPage.test.js` and `electron_app/test/titleOptimizationRestrictedTermsRenderer.test.js`.

**Interfaces:** `titleOptimizationRestrictedTermsAPI` from Task 3. UI exposes search, type/scope/status filters, full-width table, warning/info panels, popup editor, immediate toggles, delete/discard confirmations.

- [ ] Write failing page/controller tests for tab enablement, popup-only Add/Edit, locked seeded controls, explicit form Save, toggle rollback, filters, dirty navigation, and no runtime-title logic.
- [ ] Run focused UI tests and confirm expected failures.
- [ ] Implement by adapting Prefix Rules page/controller and existing semantic CSS tokens; use a single full-width table and accessible dialogs.
- [ ] Re-run focused UI tests to green.

### Task 5: Full verification and handoff

**Files:** All files above.

- [ ] Run `npm.cmd test` from `electron_app` with root `node_modules` available via `NODE_PATH`; require zero failures.
- [ ] Run `git diff --check`, inspect changed-file list, and verify only Restricted Terms scope changed.
- [ ] Report test count, local branch/worktree path, no GitHub push, and any limits; do not auto-delete existing data or implement runtime enforcement.
