# Category Rules Design

## Goal

Add a configuration-only Category Rules tab to the existing Title Optimization workspace. It stores client-approved category guidance without performing category detection, title generation, prefix execution, fitment validation, or publishing.

## Architecture

Follow the existing Restricted Terms pattern: pure validation/hydration service, encrypted Electron-store repository, narrow main-process IPC, narrow preload bridge, and renderer controller plus popup UI. Persist under `titleOptimization.categoryRules`. Use the existing authenticated-user audit fallback and serialized last-write-wins mutations.

## Data and first run

Only absent configuration seeds exactly the authoritative 20 client-v5 categories. Each seed stores an explicit `seedOrder` 1–20, exact ordered `priorityDetails`, separate `prefixRefs` and `seriesRefs`, approved multiline note or `null`, audit fields, and `origin: client-v5`. Existing configuration is never reseeded or silently repaired.

Lists trim whitespace, reject blanks, and reject duplicates within the same list using collapsed-whitespace case-insensitive comparison while preserving display text and order. Category names are globally unique among non-deleted records by the same normalization. Every member of a persisted duplicate-name group is quarantined; unrelated valid rules remain usable.

## Protection and mutation

Seeded category name and both reference arrays are immutable, including empty arrays. Seeded details, notes, and Enabled may change; seeded rules cannot be deleted. Custom rules are editable and soft-deletable with confirmation. Main-table toggles persist immediately and roll back on failure. Popup changes, including Enabled and detail reordering, remain local until Save.

## UI

Enable Category Rules after Restricted Terms and retain the existing workspace shell. Provide search, status filter, reference-presence filter, vertically scrolling responsive table, information panel, and scrollable Add/Edit dialog. Use separate chip inputs for prefixes, series, and details. Details have accessible Move Up/Move Down controls; references preserve insertion order.

## Ordering and future read

Seeded rules sort by explicit `seedOrder`; custom rules sort by normalized name then stable ID. Search and filters preserve this order. `getTitleOptimizationCategoryRules()` returns only valid, enabled, non-deleted rules in the same order.

## Resilience and scale

Quarantine malformed records without rewriting them, preserve raw invalid entries during mutations, show actionable warnings, and never retry writes automatically. Design for 20 seeds plus roughly 100 custom rules and up to 50 entries per list without virtualization or pagination.

## Verification

Use test-first service, repository, IPC, and renderer/controller coverage, including exact seed contents, protection, uniqueness, duplicate-group quarantine, mutation serialization, rollback, dirty navigation, filters, ordering, and future reads. Run focused tests, the full suite, syntax checks, `git diff --check`, and an Electron smoke test if shared dependencies permit.
