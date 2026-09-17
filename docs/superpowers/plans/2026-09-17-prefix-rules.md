# Prefix Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved Prefix Rules configuration tab to the existing Title Optimization workspace.

**Architecture:** A pure service seeds/validates/hydrates rules. A repository owns encrypted-store persistence and audit. Narrow IPC/preload methods expose operations to a popup-based renderer page. Existing tabs only gain a Prefix Rules navigation button.

**Tech Stack:** Electron, CommonJS Node.js, vanilla HTML/CSS/JavaScript, `node:test`, encrypted `electron-store` via existing configStore.

**Spec:** `docs/superpowers/specs/2026-09-17-prefix-rules-design.md` and the user-supplied Prefix Rules task.

## Global Constraints

- Seed exactly 11 approved prefixes on true first run; no invented mappings.
- Seeded prefix values are immutable and non-deletable; custom rules may soft-delete.
- Prefix uniqueness includes disabled non-deleted rules; trigger/replacement are paired.
- Store prefixes as strings, preserving leading zeroes. No runtime parsing or title execution.
- Add/Edit in a popup; no sidebar or permanent editor; existing tabs remain functional.
- No GitHub push.

---

### Task 1: Pure prefix model

**Files:** Create `electron_app/src/services/titleOptimizationPrefixRulesService.js`; test `electron_app/test/titleOptimizationPrefixRulesService.test.js`.

**Interfaces:** `seedPrefixRulesConfiguration({now, actor})`, `validatePrefixRule(rule, existing)`, `hydratePrefixRulesConfiguration(raw)`, `enabledPrefixRules(config)`.

- [ ] Write tests with literal expectations for all 11 prefixes, terms, notes, special pairs, audit fields, and string prefixes including `046`.
- [ ] Run `node --test test/titleOptimizationPrefixRulesService.test.js` and observe missing-module failure.
- [ ] Implement exact seed array and validation: nonblank string prefix; nonblank unique term array; paired special fields; boolean Enabled; duplicate prefix across non-deleted records; seeded prefix lock enforced in repository. Hydrate valid entries and quarantine invalid without persisting changes.
- [ ] Run focused tests green. Add red/green edge tests for disabled duplicate, soft-deleted exception, malformed entries, and deterministic future read.

### Task 2: Persistence and audit

**Files:** Create `electron_app/src/services/titleOptimizationPrefixRulesRepository.js`; modify `electron_app/src/config/configStore.js`; test `electron_app/test/titleOptimizationPrefixRulesRepository.test.js`.

**Interfaces:** `createTitleOptimizationPrefixRulesRepository({getStored,setStored,getActor,now,createId})` returns `load`, `saveRule`, `setRuleEnabled`, `softDelete`, `getTitleOptimizationPrefixRules`.

- [ ] Write tests for first-run only seeding, existing malformed/empty storage preservation, seeded prefix immutability, seeded delete rejection, custom edit/delete, audit, failed writes, and future valid-enabled-only read.
- [ ] Run focused tests red for missing repository.
- [ ] Implement repository using the existing Synonyms store/audit/error pattern and `titleOptimization.prefixRules`; never mutate saved raw config before successful persistence.
- [ ] Run focused tests green and check existing Synonyms/Terminology tests.

### Task 3: Secure bridge and navigation

**Files:** Create `electron_app/src/main/titleOptimizationPrefixRulesIpc.js`; modify `electron_app/src/main/index.js`, `electron_app/src/preload/preload.js`, and four existing Title Optimization HTML pages; test `electron_app/test/titleOptimizationPrefixRulesIpc.test.js` and `electron_app/test/titleOptimizationPrefixRulesPage.test.js`.

**Interfaces:** `window.titleOptimizationPrefixRules.load/save/setRuleEnabled/softDelete` only; main uses the existing `getTitleOptimizationActor`.

- [ ] Write tests for safe IPC serialization, preload bridge, Prefix Rules tab enabled on existing pages, and later tabs disabled.
- [ ] Run focused tests red.
- [ ] Register repository/IPC/preload and update tab navigation without touching unrelated workflows.
- [ ] Run focused tests green.

### Task 4: Popup renderer

**Files:** Create `electron_app/src/renderer/pages/title-optimization/prefix-rules.html`, `prefix-rules.css`, `prefix-rules.js`; test `electron_app/test/titleOptimizationPrefixRulesRenderer.test.js` and extend page tests.

**Interfaces:** `createPrefixRulesController({api,confirm,notify})` exposes load, beginAdd, beginEdit, updateDraft, add/remove term, save, toggle, delete, filters, dirty guard.

- [ ] Write failing controller/page tests for popup-only Add/Edit, seeded prefix read-only, terms as chips, Save-only draft persistence, paired inline errors, search/status, immediate toggle rollback, delete confirmation, dirty navigation, and info panel.
- [ ] Run focused tests red.
- [ ] Implement the full-width vertical-scroll table and accessible `<dialog>` following the existing Synonyms page and design tokens. Keep Origin/Priority internal.
- [ ] Run focused tests green and check relevant existing page/controller tests.

### Task 5: Full verification and handoff

**Files:** Only corrections identified by tests or review.

- [ ] Run `node --check` on new JavaScript and `git diff --check`.
- [ ] Run full suite with root dependency resolution: `$env:NODE_PATH='C:\Users\hp\Desktop\electron demo\electron_app\node_modules'; npm.cmd test` from worktree `electron_app`.
- [ ] Verify no prefix runtime calls, title generation, or unfinished tabs were changed.
- [ ] Commit locally in feature worktree; do not push. Report branch/worktree and ask before integration into `developing`.
