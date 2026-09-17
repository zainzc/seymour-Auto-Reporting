# Synonyms Tab Design

The approved client specification is the pasted Synonyms task. This document records the approved correction and integration decisions.

## Scope and UX

- Add Synonyms to the existing Title Optimization workspace; enable that tab alongside Source Fields, Source Priority, and Terminology Rules. Keep later tabs visible and disabled.
- Use the existing top navigation, cards, table, tokens, notices, and native dialog styling. No sidebar or always-visible editor.
- Add/Edit opens one popup. Save closes it only after persistence succeeds; Cancel, Close, and Escape confirm before discarding a dirty draft. Table toggles and the master Synonym Enrichment toggle persist immediately and revert on failure.
- Keep Priority and origin metadata internal, following the current Terminology UI. Show search, condition/status filters, a vertically scrollable no-horizontal-scroll table, master toggle, and the “How Synonym Enrichment Works” panel.
- The UI configures optional search enrichment only. Do not perform title-generation, fitment, duplicate-term, or length evaluation.

## Configuration

- One encrypted Electron-store key: `titleOptimization.synonyms`. No existing persisted synonym setting was found. Store `{ version, enabled, rules, policies, updatedAt, updatedBy }` there, with master `enabled: true` on true first run.
- Seed exactly **ten** normal client-v5 synonym mappings: Headlight/Headlamp; Tail Light/Tail Lamp; Side View Mirror/Door Mirror + Side Mirror; Fuel Tank/Gas Tank; Air Filter Box/Air Cleaner; Sun Visor/Sunvisor; Instrument Cluster/Speedometer + Gauge Cluster; Caliper/Disc Brake; Blower Motor/Heater Fan; Radio/Stereo Receiver. Priorities are 10 through 100 internally.
- Store the eleventh client instruction separately as `policies.cvAxleFrontHalfShaft` (or equivalent stable policy key), with condition `confirmed-front-half-shaft` and note: “CV Axle may only be used for a confirmed FRONT half-shaft; never for rear axle or axle housing.” It is **not** a normal synonym rule and has no invented synonym mapping or empty `synonyms` rule. Exclude it from normal rule validation; retain it in future-facing config reads.
- First-run seeding occurs only when the key is absent (`undefined`). Existing empty, edited, disabled, deleted, or malformed configurations are never reset. Hydrate valid entries independently, surface invalid entries, and preserve invalid raw entries during valid edits.
- Normal rules contain ID, primaryTerm, array of one or more approved synonyms, condition (`always` initially), appliesTo (`all` initially), numeric internal priority, enabled, origin, note, created/updated/deleted audit fields. Seeded rules are editable and toggleable but not deletable; custom rules may be soft-deleted with confirmation.
- Reject blank primary terms, blank or duplicate synonym values, duplicate active rule fingerprints (`primaryTerm + condition + appliesTo` after trim/case-fold/whitespace-collapse), invalid condition/scope/priority/enabled values, and duplicate IDs. Preserve entered display text.
- Future read API returns `{ enabled, rules, policies }`, with only valid enabled undeleted rules sorted by priority then ID. It does not apply rules to titles.

## Boundaries and checks

- Renderer uses a narrow preload bridge and IPC; no direct configStore or secrets. Main process repository uses the existing identity fallback and last-write-wins updates. No Airtable access.
- Tests cover exact seeds, CV policy separation, first-run-only behavior, validation and malformed preservation, audit/soft-delete, immediate toggle rollback, modal dirty drafts, filters, navigation, secure IPC, and existing-tab regressions.
