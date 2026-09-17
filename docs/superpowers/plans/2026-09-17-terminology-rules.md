# Terminology Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the Terminology Rules tab with exactly 34 v5 seeds, secure persistence, editable rules, and restored workspace navigation.

**Architecture:** A pure service owns seed data, validation, hydration, filtering, and sorting. A repository owns encrypted-store persistence and audit metadata; narrow IPC/preload methods expose it to a vanilla-HTML renderer/controller. Existing Title Optimization shell patterns remain unchanged.

**Tech Stack:** Electron, Node CommonJS, `node:test`, HTML/CSS/vanilla JavaScript, encrypted Electron-store.

**Spec:** `docs/superpowers/specs/2026-09-17-terminology-rules-design.md`

## Global Constraints

- Seed exactly 34 terminology entries from the user-supplied v5 excerpt, ordered at priorities 10 through 340.
- `Anti-Lock Brake Part` is one rule with verified `ABS Pump` and otherwise `ABS Module` outcomes.
- Seeded rules are editable and toggleable but non-deletable. Custom deletion is soft and confirmed.
- No runtime title replacement, Airtable calls, AI, publishing, or new authorization model.
- Keep all unfinished tabs visible but disabled; restore the Title Optimization launcher.
- Use the current authenticated user or established `system` fallback for audit metadata.

## File map

- `electron_app/src/services/titleOptimizationTerminologyRulesService.js`: seed data, validation, hydration, sorting/filtering.
- `electron_app/src/services/titleOptimizationTerminologyRulesRepository.js`: read/write, add/update/toggle/soft-delete, audit and runtime read.
- `electron_app/src/main/titleOptimizationTerminologyRulesIpc.js`: narrow IPC, error serialization.
- `electron_app/src/config/configStore.js`, `electron_app/src/main/index.js`, `electron_app/src/preload/preload.js`: encrypted store and bridge registration.
- `electron_app/src/renderer/pages/title-optimization/terminology-rules.{html,css,js}`: shell, table/editor, controller.
- `electron_app/src/renderer/pages/title-optimization/{source-fields,source-priority}.html`: enable terminology tab.
- Four `electron_app/src/renderer/pages/milestone1/*.html` navigation pages: restore launcher/buttons.
- `electron_app/test/titleOptimizationTerminology*.test.js` and existing navigation/page tests: behavior and regression checks.

### Task 1: Pure rule model and exact v5 seeds

**Files:** Create service and `test/titleOptimizationTerminologyRulesService.test.js`.

**Interfaces:** `seedTerminologyRules(audit)`, `validateRule(rule, existing)`, `hydrateTerminologyConfiguration(config)`, `visibleRules(config)`, `enabledRules(config)`. Rule shape matches the spec.

- [ ] Write a test asserting 34 exact source/action/replacement/condition rows, origins, notes/context branches, priorities, and absence of excluded examples. Start with literals copied from the attached v5 excerpt.
- [ ] Run `node --test test/titleOptimizationTerminologyRulesService.test.js` and verify missing-module failure.
- [ ] Implement the 34-entry seed constant and pure seed generator, including `conditionConfig: { criterion, whenVerified, otherwise }` for the two context-verified entries.
- [ ] Add failing tests for Replace/Remove validation, active duplicate detection, malformed-entry quarantine, and deterministic priority sort; run and observe failures.
- [ ] Implement the minimal pure helpers; rerun the focused test to green.

### Task 2: Persistence, audit, lifecycle, and IPC

**Files:** Create repository, IPC handler, tests; modify `configStore.js`, `main/index.js`, `preload/preload.js`.

**Interfaces:** Repository `load()`, `saveRule(input)`, `setEnabled(id, enabled)`, `softDelete(id)`, `getTitleOptimizationTerminologyRules()`; IPC channels `title-optimization-terminology-rules:{load,save,toggle,delete}`.

- [ ] Write repository tests: undefined seeds once, null/partial data never reseeds, add/edit custom and seeded, seeded delete rejection, custom soft-delete audit, failed persistence rollback, immediate toggle rollback, runtime enabled sort. Run tests and verify red.
- [ ] Implement repository against injected `getStored`, `setStored`, `getActor`, and `now`; use a cloned configuration and persist only after validation.
- [ ] Run repository tests to green.
- [ ] Write IPC contract test for four channels and serialized errors; verify red.
- [ ] Add config-store methods, IPC handler, preload bridge, and main registration using existing actor fallback; run IPC and full service/repository tests to green.

### Task 3: Page/controller and navigation

**Files:** Create terminology HTML/CSS/JS and renderer/page tests; modify existing Title Optimization and Milestone 1 navigation pages/tests.

**Interfaces:** Renderer calls only `window.titleOptimizationTerminologyRulesAPI`; controller exposes load/add/edit/save/toggle/delete/filter/navigation state. No direct config store.

- [ ] Write page/navigation tests for an enabled Terminology tab, restored workspace buttons, disabled future tabs, semantic controls, and no screenshot sample seed rows; verify red.
- [ ] Create page using Source Fields shell/tokens with responsive main table and side editor, accessible labeled inputs/buttons/feedback, and informational panel; enable/restore navigation links. Run page tests to green.
- [ ] Write controller tests for Add/Edit explicit save, search, filters, immediate toggle with revert on error, confirmed custom deletion, seeded protection, failed save retained form, and dirty navigation; verify red.
- [ ] Implement controller and DOM bindings with existing dialog/guard patterns; run focused renderer tests to green.

### Task 4: Full regression and review

**Files:** Only test/production files required by observed failures; no unrelated refactor.

- [ ] Run `npm.cmd test` from the isolated worktree `electron_app`; expect all tests passing.
- [ ] Run `git diff --check` and inspect `git diff --stat`/diff for seed accuracy, secret leakage, scope, and unintended changes.
- [ ] Manually inspect UI at desktop and narrow widths if Electron/browser launch is available; otherwise report that visual runtime verification was not possible.
- [ ] Commit feature locally on the worktree branch; do not push. Return integration choice to the user unless they have already requested a merge.
