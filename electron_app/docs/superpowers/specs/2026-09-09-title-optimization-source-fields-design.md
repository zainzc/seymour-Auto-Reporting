# Title Optimization Source Fields Design

## Confirmed Requirements

Create a separate Title Optimization Workspace inside Milestone 1 navigation and implement only its Source Fields tab. Do not add a separate main-dashboard card. Use “app user” in product copy and documentation. Keep every planned internal tab visible, with only Source Fields enabled.

The page maps logical title inputs to live fields from the configured Airtable base's exact `eBay Listings (API)` table. It supports editing seeded mappings and adding, editing, disabling, and soft-deleting custom mappings. Changes remain local until an explicit save.

## Architecture

The renderer is a vanilla HTML/CSS/JavaScript page using the application's existing visual language. A narrow preload API invokes main-process handlers. The main process owns credentials, Airtable schema retrieval, audit identity fallback, validation, and persistence through the existing encrypted `electron-store` configuration module.

A focused service contains pure mapping behavior: first-run seeding, exact field matching, validation, status derivation, malformed-entry quarantine, custom mapping mutation, soft deletion/restoration, and normalized runtime data construction. This keeps business rules testable without Electron or network dependencies.

## Business Rules

- First-run auto-mapping requires one unique, case-sensitive, exact field-name match.
- No fuzzy, normalized, partial, or semantic matching is allowed.
- Seed expected names: `Title`, `Title Override Status`, `SKU`, `IPN`, `C:Brand`, `C:Manufacturer Part Number`, `Item Specifics`, `Conditions & Options`, `Category Name`, and `Hollander Title`.
- Seed `fixedIpnValues`, `year`, and `currentEbayFields` unmapped.
- Do not seed an authoritative `C:Model` mapping.
- All seeded mappings are protected from deletion and logical-key edits.
- Required is locked only for `existingTitle`, `manualOverrideStatus`, `sku`, and `ipnPrefix`.
- Custom keys are unique camelCase identifiers.
- Custom deletion sets `deletedAt`, `deletedBy`, disables the mapping, and excludes it from normal results. Restoration is service-only in this task.
- Saves are idempotent and last-write-wins.

## Data Flow

On first load, the main process reads stored mappings and last-known field metadata. With no existing configuration, it fetches the schema when possible and seeds mappings. Existing configuration is never reseeded merely because some entries are invalid.

Refresh performs one Airtable metadata request, selects the exact table, sanitizes its fields to ID/name/type, and returns updated mapping statuses. A failure retains saved mappings and cached metadata. Save validates required mappings and writes one configuration object.

## Data Model

Each mapping contains `id`, `logicalKey`, `displayName`, `description`, `sourceProvider`, `sourceFieldId`, `sourceFieldName`, `sourceFieldType`, `required`, `enabled`, `protected`, `isCustom`, `sortOrder`, `updatedAt`, `updatedBy`, `deletedAt`, and `deletedBy`.

The stored configuration contains a schema version, mappings, last-known Airtable field metadata, table ID/name, and update audit fields. Runtime retrieval omits soft-deleted mappings. Custom mapping values are placed under `additionalFields` by the normalization foundation.

## Status Rules

- `Disabled`: mapping is explicitly disabled.
- `Unmapped`: no Airtable field is selected.
- `Source Missing`: a selected saved field is absent from the last successful live schema.
- `Mapped`: enabled and the selected field exists.

## Errors and Safety

No Airtable token crosses IPC or appears in logs. Schema refresh has no feature-level automatic retry. Credential, table, empty-schema, rate-limit, network, malformed-config, and save errors produce user-facing messages without clearing saved state. Valid records survive partial corruption; invalid records are quarantined and identified.

Unsaved changes trigger the existing confirmation pattern on workspace navigation and browser/window unloading where cleanly supported.

## Scale and Accessibility

Support roughly 50 Airtable fields and 20–30 active mappings with a searchable native/custom selector and ordinary table. No virtualization is needed. Controls are keyboard accessible, focus-visible, labelled, and at least 40px high in this desktop application. Status uses text/icons as well as color. Narrow desktop overflow remains inside the table card.

## Out of Scope

AI calls, prompt generation, title generation/validation, source priority, terminology, synonyms, prefixes, restricted terms, category rules, structure, flag reasons, system rules, metrics, publishing, restoration UI, new roles/permissions, and conflict-version detection.

## Acceptance Criteria

The workspace is reachable from the Milestone 1 landing page and workspace navigation; seeded mappings, real schema choices, exact matching, statuses, explicit save, reload, refresh preservation, custom CRUD with protected-core rules, malformed-data preservation, dirty navigation, and error states work as specified. Existing workspace behavior remains intact and automated tests plus available lint/build checks pass.
