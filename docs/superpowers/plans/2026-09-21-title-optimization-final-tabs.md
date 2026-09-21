# Title Optimization Final Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Flag Reasons, System Rules, and Overview without adding runtime title processing or altering Title Structure.

**Architecture:** Flag Reasons follows the existing encrypted configuration repository/service/IPC/controller pattern. System Rules uses one immutable code-defined service exposed read-only through IPC. Overview loads the ten owning services through a dedicated read-only aggregator and displays their supplied counts, availability, and warnings without recreating validation.

**Tech Stack:** Electron, CommonJS, plain HTML/CSS/JavaScript, Node.js built-in test runner.

**Spec:** User-approved Final Implementation Specification in this conversation and attachment `3e4c2830-1398-4a94-8a19-4b162b26bac8/pasted-text.txt`.

## Global Constraints

- Build only Flag Reasons, System Rules, and Overview on prerequisite commit `d8024bb`.
- Preserve Title Structure and all existing Title Optimization behavior.
- Use exact approved client-v5 text and deterministic ordering.
- No runtime title generation, validation execution, AI, eBay publishing, merge, or push.
- Keep commits ordered: Flag Reasons, System Rules, Overview.

## Review Focus

- Existing malformed configuration must never be overwritten or reseeded during load or unrelated writes.
- Concurrent Flag Reason mutations must serialize and preserve unrelated raw records.
- Required seeded reasons must remain enabled and non-deletable under every UI/repository path.
- Overview must distinguish warning-bearing services from failed/unavailable services without manufacturing counts.
- Navigation changes across all existing pages must not regress dirty-state guards.

---

### Task 1: Flag Reasons

**Files:**
- Create service, repository, IPC, renderer page/controller/style, and focused service/repository/IPC/page/controller tests.
- Modify config storage accessors, main registration, preload bridge, and every Title Optimization page navigation.

**Interfaces:**
- `createTitleOptimizationFlagReasonsRepository({ getStored, setStored, getActor, now, createId })`
- Repository: `load()`, `saveReason(input)`, `setReasonEnabled(id, enabled)`, `softDelete(id)`, `getTitleOptimizationFlagReasons()`
- Renderer API: `load`, `save`, `setEnabled`, `softDelete`

- [ ] Write service tests for exact seeds, validation, duplicate quarantine, malformed preservation, and deterministic future reads.
- [ ] Run them and verify failure because the Flag Reasons modules do not exist.
- [ ] Implement the service minimally and rerun to green.
- [ ] Write repository/IPC tests for absent-only seeding, audit, serialization, CRUD protection, rollback-safe errors, and narrow channels.
- [ ] Run red, implement repository/IPC/storage/preload/main wiring, and rerun green.
- [ ] Write page/controller tests for shared shell, popup-only editing, friendly origin labels, filters, immediate toggle rollback, draft Save, confirmation, and dirty navigation.
- [ ] Run red, implement page/controller/style/navigation, and rerun green.
- [ ] Run all Flag Reasons and Title Optimization regressions, syntax checks, and `git diff --check`.
- [ ] Inspect scoped diff and commit `feat(title-optimization): add flag reasons`.

### Task 2: System Rules

**Files:**
- Create canonical definitions/service, read-only IPC, renderer page/controller/style, and tests.
- Modify main registration, preload, and all Title Optimization page navigation.

**Interfaces:**
- `getTitleOptimizationSystemRules()` returns immutable copies of SR-01 through SR-15.
- Renderer API exposes `load()` only.

- [ ] Write failing service tests using literal expected IDs, titles, categories, source, version, locked status, order, and behavior text.
- [ ] Implement the single canonical module/service and rerun green.
- [ ] Write failing IPC/page/controller tests for load-only access, read-only UI, search, and Category filtering.
- [ ] Implement IPC/preload/main/page/navigation and rerun green.
- [ ] Run System Rules and Title Optimization regressions, syntax checks, and `git diff --check`.
- [ ] Inspect scoped diff and commit `feat(title-optimization): add locked system rules`.

### Task 3: Overview

**Files:**
- Create read-only overview service/IPC/page/controller/style and tests.
- Modify main registration, preload, and all Title Optimization navigation so all tabs are enabled.

**Interfaces:**
- Overview aggregator consumes the ten existing owning repositories/services plus canonical System Rules.
- Returns section summaries, `configuredCount`, `totalCount: 10`, warnings, system highlights, and overall `healthy | needs-attention | unavailable` status.

- [ ] Write failing aggregation tests for Healthy, Needs Attention, Unavailable, real counts, warning passthrough, and locked System Rules.
- [ ] Implement the read-only overview aggregator and rerun green.
- [ ] Write failing IPC/page/controller tests for four summary cards, ten section rows, navigation, warning rendering, and no persistence/edit controls.
- [ ] Implement IPC/preload/main/page/navigation and rerun green.
- [ ] Run Overview, Title Optimization, and full application regressions plus syntax and `git diff --check`.
- [ ] Perform Electron smoke testing if shared dependencies permit it; otherwise record the exact blocker.
- [ ] Inspect scoped diff and commit `feat(title-optimization): add workspace overview`.

### Task 4: Final Verification and Review

- [ ] Confirm `developing` remains at prerequisite commit `d8024bb`.
- [ ] Run the full regression suite, all syntax checks, and `git diff --check` from the isolated worktree.
- [ ] Review the complete branch diff against the approved specification and fix Critical/Important findings test-first.
- [ ] Record manual-only acceptance items and Electron smoke-test evidence or blocker.
- [ ] Report prerequisite and three feature commit hashes; confirm no merge and no push.
