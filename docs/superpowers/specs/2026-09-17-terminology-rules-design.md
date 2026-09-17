# Terminology Rules Design

Approved in chat on 2026-09-17. The 34-entry list in the user's attached v5 excerpt is the authoritative seed source. The earlier 12-entry list is superseded.

## Scope

Add Terminology Rules to the existing Title Optimization workspace and restore its Milestone 1 navigation links. Source Fields and Source Priority remain functional. All other Title Optimization tabs remain visible but disabled. The screenshot guides layout only; no screenshot row is seed data.

This task configures rules. It does not apply them to listing data, call AI, generate titles, or publish.

## Data and storage

Use encrypted Electron-store key `titleOptimization.terminologyRules`, narrow IPC/preload operations, and the existing `getTitleOptimizationActor` audit fallback. Configuration includes `version`, `rules`, `updatedAt`, and `updatedBy`. Rules include stable ID, source term, action, replacement term, condition, applies-to context, priority, enabled, origin, optional note/context configuration, created/updated audit fields, and optional soft-delete audit fields.

True first run (`undefined` store value) seeds exactly the 34 entries in the supplied v5 excerpt, in listed order at priorities 10 through 340. `origin: client-v5` identifies seeded entries. No synonyms, prefix-dependent rules, or mockup rows are seeded. Existing configuration, including malformed or empty configuration, is never reseeded automatically.

Actions are `replace` and `remove`. Conditions are `always`, `transmission-context`, and `context-verified`. Applies-to values are `all` and `transmission`. The `Auto` rule is transmission-only. The `User Defined` rule removes text and has null replacement. `Chassis ECM` retains its buyer-search note. `Anti-Lock Brake Part` is one context-verified rule with structured criterion `pump-verified`, verified result `ABS Pump`, and otherwise result `ABS Module`. `Coil / Ignitor` is context-verified with criterion `identity-confirmed`, verified result `Ignition Coil`, and no unverified replacement. These metadata are editable in the form; no runtime resolution is implemented.

## Operations and validation

The page supports Add, Edit, immediate Enabled toggle, confirmed soft-delete of custom rules, search, condition/status filters, and local Refresh. Seeded rules are editable/toggleable but non-deletable. Failed toggle persistence reverts the switch; failed Add/Edit save preserves the editor and prior persisted configuration. Soft-deleted custom rules stay stored with `deletedAt`/`deletedBy`, disabled and excluded from normal UI/runtime reads. No restore UI is included.

Replace requires a nonblank replacement; Remove requires null replacement. Source term and condition are required; priority is a positive integer; enabled is boolean. Context-verified rules require a structured verification criterion and verified result; an optional otherwise result is allowed. Duplicate active rules are rejected when trimmed, case-folded, whitespace-collapsed source term plus action, condition, and applies-to match. Stored display text is preserved. Runtime-facing read returns enabled valid nondeleted rules ordered by priority then ID.

Malformed entries are quarantined individually and reported in the UI without rewriting storage. Valid rules remain usable. Missing records do not cause reseeding. Last-write-wins applies to saves. No automatic retries or new permissions are introduced.

## UI

Reuse the existing 1280px Title Optimization shell, top navigation, tokens, cards, dialogs, feedback, and dirty-navigation pattern. The Terminology Rules tab has search, filters, Refresh, Add Rule, a table, a right-side editor, and a How Terminology Rules Work panel. The editor stacks below the table on narrow windows. Explicit Save Rule is required for Add/Edit; Enabled toggles save immediately. Destructive actions require confirmation. Form errors are adjacent to fields; all controls have visible labels, focus states, and keyboard access.

## Verification

Test exact 34 seeds and exclusions, true-first-run behavior, valid-entry preservation, data validation, add/edit/toggle/delete, failed-save rollback, search/filter/ordering, dirty navigation, IPC security, audit fields, restored navigation, and full app regression suite.
