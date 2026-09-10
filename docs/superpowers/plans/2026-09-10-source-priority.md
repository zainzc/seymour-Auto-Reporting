# Source Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, persistent, accessible Source Priority editor to the existing Title Optimization Workspace.

**Architecture:** Stable authority metadata lives in a focused service while electron-store persists only ordering and audit metadata. A repository owns first-run seeding, malformed-data hydration, validation, and last-write-wins saves; IPC/preload expose load/save only. A dedicated renderer controller keeps reorder/reset state local until explicit save and reuses the Source Fields navigation and visual patterns.

**Tech Stack:** Electron, CommonJS, plain HTML/CSS/JavaScript, electron-store, Node.js test runner.

**Spec:** `docs/superpowers/specs/2026-09-10-source-priority-design.md`

## Global Constraints

- Keep Manual Override locked at priority 1 and allow only priorities 2–9 to move.
- Persist under `titleOptimization.sourcePriority`; never expose configStore to the renderer.
- Do not use Airtable credentials and do not implement AI/runtime conflict resolution.
- Keep Source Fields functional and all other unfinished Title Optimization tabs visible but disabled.
- Use explicit Save Changes, last-write-wins, no automatic retry, and no silent malformed-config repair.

---

### Task 1: Source Priority domain and repository

**Files:**
- Create: `electron_app/src/services/titleOptimizationSourcePriorityService.js`
- Create: `electron_app/src/services/titleOptimizationSourcePriorityRepository.js`
- Create: `electron_app/test/titleOptimizationSourcePriorityService.test.js`
- Create: `electron_app/test/titleOptimizationSourcePriorityRepository.test.js`

**Interfaces:**
- Produces: `DEFAULT_SOURCE_PRIORITY`, `SOURCE_PRIORITY_METADATA`, `validateSourcePriority(order)`, `hydrateSourcePriority(raw)`, `moveSource(order, key, direction)`, and `createTitleOptimizationSourcePriorityRepository({ getStored, setStored, getActor, now })`.
- Repository returns `{ version, policy, order, rows, updatedAt, updatedBy, issues, requiresCorrection }` from `load()` and `save(order)`; `getTitleOptimizationSourcePriority()` returns the ordered keys.

- [ ] **Step 1: Write failing service tests** for exact defaults, unique known keys, Manual Override locking, rank 2–9 movement, and malformed hydration that preserves valid relative order while surfacing issues.
- [ ] **Step 2: Run `node --test test/titleOptimizationSourcePriorityService.test.js`** and confirm failure because the service does not exist.
- [ ] **Step 3: Implement metadata, validation, movement, and non-persisting safe-display hydration** with fixed nine-key definitions and structured issue objects.
- [ ] **Step 4: Run the service test** and confirm all cases pass.
- [ ] **Step 5: Write failing repository tests** for first-run seed, reload without reseed, idempotent save, audit fields, save rejection preserving storage, malformed load without writes, and clean future-runtime order retrieval.
- [ ] **Step 6: Implement the repository** using injected storage and audit functions; call `setStored` only for first-run or a valid explicit save.
- [ ] **Step 7: Run both domain tests** and confirm they pass.
- [ ] **Step 8: Commit** with `feat: add source priority domain persistence`.

### Task 2: Secure storage and IPC wiring

**Files:**
- Modify: `electron_app/src/config/configStore.js`
- Modify: `electron_app/src/preload/preload.js`
- Modify: `electron_app/src/main/index.js`
- Create: `electron_app/src/main/titleOptimizationSourcePriorityIpc.js`
- Create: `electron_app/test/titleOptimizationSourcePriorityIpc.test.js`

**Interfaces:**
- Consumes repository `load()` and `save(order)`.
- Produces renderer API `window.titleOptimizationSourcePriorityAPI.load()` and `.save(order)` on channels `title-optimization-source-priority:load` and `:save`.

- [ ] **Step 1: Write a failing IPC contract test** asserting exactly load/save handlers, serialized failures, and no configStore or credential exposure.
- [ ] **Step 2: Run the IPC test** and confirm module/channel failures.
- [ ] **Step 3: Add config-store getters/setters**, preload bridge, IPC serialization/registration, repository construction, existing OAuth user identity fallback, and main-process registration.
- [ ] **Step 4: Run IPC, repository, and existing Source Fields IPC tests** and confirm they pass.
- [ ] **Step 5: Commit** with `feat: expose secure source priority ipc`.

### Task 3: Renderer controller and interaction behavior

**Files:**
- Create: `electron_app/src/renderer/pages/title-optimization/source-priority.js`
- Create: `electron_app/test/titleOptimizationSourcePriorityRenderer.test.js`

**Interfaces:**
- Consumes `titleOptimizationSourcePriorityAPI`.
- Produces `createSourcePriorityController({ api, confirmReset, confirmDiscard, onChange })` with `load`, `move`, `drop`, `reset`, `save`, `canNavigateAway`, `shouldBlockUnload`, and `authorizeNextUnload`.

- [ ] **Step 1: Write failing controller tests** for clean load, locked Manual Override, move up/down bounds, drag reorder, immediate numbering, dirty state, reset confirmation/local-only behavior, save success, save failure preservation, malformed warning state, and navigation protection.
- [ ] **Step 2: Run the renderer test** and confirm the missing-module failure.
- [ ] **Step 3: Implement the controller** as a DOM-independent CommonJS/browser module, using immutable local order changes and explicit async save.
- [ ] **Step 4: Run renderer and service tests** and confirm they pass.
- [ ] **Step 5: Commit** with `feat: add source priority editor controller`.

### Task 4: Source Priority page and workspace navigation

**Files:**
- Create: `electron_app/src/renderer/pages/title-optimization/source-priority.html`
- Create: `electron_app/src/renderer/pages/title-optimization/source-priority.css`
- Modify: `electron_app/src/renderer/pages/title-optimization/source-priority.js`
- Modify: `electron_app/src/renderer/pages/title-optimization/source-fields.html`
- Modify: `electron_app/test/titleOptimizationNavigation.test.js`
- Modify: `electron_app/test/applicationLayout.test.js`
- Create: `electron_app/test/titleOptimizationSourcePriorityPage.test.js`

**Interfaces:**
- Consumes the controller and existing top-navigation paths/styles.
- Produces an enabled Source Priority route with semantic ordered table, lock/status text, HTML drag events, Move Up/Down controls, reset/save actions, feedback regions, confirmation dialogs, and explanation panel.

- [ ] **Step 1: Write failing page/navigation tests** for both enabled tabs, all unfinished disabled tabs, no sidebar, 1280px shell, nine rows, lock label, drag handle, move buttons, reset/save controls, info panel, and Source Fields route preservation.
- [ ] **Step 2: Run page/navigation tests** and confirm missing page/link failures.
- [ ] **Step 3: Build the HTML/CSS and DOM bindings** by reusing Source Fields tokens and visual hierarchy; keep focus states visible and controls labeled.
- [ ] **Step 4: Implement in-app reset/discard dialogs and `beforeunload` integration**, ensuring Reset changes local order only.
- [ ] **Step 5: Run renderer, page, navigation, layout, and existing Source Fields tests** and confirm they pass.
- [ ] **Step 6: Commit** with `feat: build source priority workspace tab`.

### Task 5: Full verification and manual Electron check

**Files:**
- Modify only if verification exposes a Source Priority defect covered by a new failing regression test.

**Interfaces:**
- Verifies all prior outputs without adding runtime title logic.

- [ ] **Step 1: Run focused tests** with `node --test test/titleOptimizationSourcePriority*.test.js test/titleOptimizationSourceFields*.test.js test/titleOptimizationNavigation.test.js test/applicationLayout.test.js`.
- [ ] **Step 2: Run the complete suite** with `npm.cmd test` and require zero failures.
- [ ] **Step 3: Run `npm.cmd run lint`** and record the repository’s configured result; inspect package scripts for typecheck/build commands before claiming them.
- [ ] **Step 4: Run `git diff --check`** and inspect status/diff for unrelated changes.
- [ ] **Step 5: Launch Electron with `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npm.cmd run start`**, inspect Source Fields and Source Priority navigation, reorder, reset, save, reload, lock, dialogs, and focus; stop the process cleanly.
- [ ] **Step 6: Run `npm.cmd test` again after any manual-check changes**, then commit with `test: verify source priority workflow` only if verification required code changes.
