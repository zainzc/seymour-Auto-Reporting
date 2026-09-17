# Prefix Rules Design

Approved by the user on 2026-09-17. The attached Prefix Rules task is the detailed source of truth; this document records the final clarifications.

## Scope and architecture

Add Prefix Rules within the existing Title Optimization workspace. Reuse its top navigation, encrypted configuration store, narrow IPC/preload bridge, audit identity, popup editor, table, and dirty-navigation pattern. Do not add a sidebar or runtime title/prefix processing. Persist under `titleOptimization.prefixRules` with last-write-wins saves.

## Data and seeding

Only truly absent storage seeds exactly `234`, `257`, `268`, `285`, `323`, `375`, `629`, `641`, `646`, `659`, and `663` with the supplied approved-part-term arrays. `257` preserves the future `#SKU` note. `629` stores `Column Switch` → `Wiper / Turn Signal / Multifunction Switch`; `641` stores `Front Door Switch` → `Master Power Window Switch`. Never invent additional defaults. Prefixes are strings, including leading zeros.

Seeded `client-v5` rules are editable except for their immutable prefix, can be enabled/disabled, and cannot be deleted. Custom rules can be edited and soft-deleted with `deletedAt`/`deletedBy`; there is no restore UI. Audit `createdAt`/`createdBy` and `updatedAt`/`updatedBy` use the existing application actor fallback.

## Validation and resilience

Require a nonblank prefix and at least one nonblank approved part term. A special trigger and replacement must both be blank or both be supplied, with inline errors. Prefix uniqueness covers every non-deleted valid rule, even disabled rules; deleted custom history and quarantined malformed entries are excluded. This resolves the malformed-data edge case in favor of keeping valid rules usable while preserving invalid raw entries for audit. Do not coerce prefixes to numbers or strip leading zeros. Save fails without mutating persistence on validation or storage errors. Malformed existing configuration is warned about without resetting or reseeding; valid entries remain usable, and future reads exclude invalid, disabled, or deleted entries in deterministic order.

## Interface

Enable Prefix Rules while leaving later unfinished tabs visible and disabled. A full-width table shows prefix, approved terms, special rule/note, Enabled, and actions, with search and status filter. Keep origin as internal metadata to match Synonyms; do not show `Client v5`/`Custom` badges. Add/Edit opens an accessible popup, not a permanent side editor. Seeded prefix input is read-only. Add/Edit remains local until Save Rule; Enabled toggle persists immediately and rolls back with feedback on failure. Protect dirty popup edits on navigation/dismissal. Provide the specified “How Prefix Rules Work” guidance.

## Acceptance

Tests cover exact first-run seed, metadata and special pairs, edit/protection/delete rules, uniqueness across disabled records, leading-zero preservation, malformed isolation, audit, narrow IPC, popup/UI controls, dirty navigation, immediate-toggle rollback, future read filtering, and regression of existing tabs. Full `npm.cmd test` passes. No GitHub push.
