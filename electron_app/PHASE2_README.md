# Phase 2 Documentation
Google Sheets -> Airtable Master Parts + ClickUp exception tasks.

This document covers both:
1. User POV (how to operate it safely).
2. Developer POV (how it works internally and where to change behavior).

## 1. Purpose and Scope
Phase 2 reads inventory rows from a Google Sheet, upserts records in Airtable Master Parts, and creates ClickUp tasks for rows where category mapping cannot be resolved automatically.

Source of truth for orchestration:
- `electron_app/src/services/phase2Service.js:19`

## 2. End-to-End Flow
Execution pipeline stages:
1. Read source sheet.
2. Normalize/filter rows.
3. Load category reference rows from Airtable.
4. Load existing master-part records by IPN from Airtable.
5. Build create/update/task plan.
6. Execute Airtable writes.
7. Create ClickUp tasks for unresolved cases.

References:
- Stage emission and order: `electron_app/src/services/phase2Service.js:102`
- `execute_airtable_writes` stage: `electron_app/src/services/phase2Service.js:156`
- `create_clickup_tasks` stage: `electron_app/src/services/phase2Service.js:226`

## 3. User Runbook
### 3.1 UI Path
Open Milestone 1 Phase 2 workspace and configure:
- Google Sheet ID and tab name.
- Airtable token/base/table names.
- ClickUp token/list.
- Run mode (dry/live).

References:
- UI form fields and run button: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:350`
- Airtable base picker action: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:382`
- ClickUp list picker action: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:407`

### 3.2 Save and Run Behavior
On run, frontend passes full config object (not just `dryRun`) to backend, so selected base/list/token values are used directly.

Reference:
- `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:743`

### 3.3 Progress Interpretation
- 10-70%: read/normalize/planning.
- 82-91%: Airtable writes in progress (can be long for large datasets).
- 92%: ClickUp task creation.
- 100%: completed/error emitted.

References:
- Write heartbeat message: `electron_app/src/services/phase2Service.js:192`
- Stage completion message: `electron_app/src/services/phase2Service.js:223`

### 3.4 Dry Run vs Live Run
- Dry run:
  - Airtable writes are skipped.
  - Planned create/update counts are still shown.
  - ClickUp task creation still runs in current implementation.
- Live run:
  - Airtable writes + ClickUp task creation both run.

References:
- Dry-run branch: `electron_app/src/services/phase2Service.js:157`
- ClickUp stage runs after dry/live branch: `electron_app/src/services/phase2Service.js:226`

## 4. Configuration and Precedence
### 4.1 Config Sources (highest to lowest)
1. Runtime options passed into `runPhase2`.
2. Saved `phase2Config` in Electron Store.
3. Environment variables.
4. Inventory sheet fallback for `sheetId/tabName`.

Reference:
- `electron_app/src/services/phase2Service.js:19`

### 4.2 Keys
```env
GOOGLE_SHEET_ID=
GOOGLE_TAB_NAME=
AIRTABLE_TOKEN=
AIRTABLE_BASE_ID=
AIRTABLE_MASTER_TABLE=Master Parts Table
AIRTABLE_CATEGORY_TABLE=Category Names
CLICKUP_TOKEN=
CLICKUP_LIST_ID=
PHASE2_DRY_RUN=true
```

### 4.3 IPC Surface
Main handlers:
- `phase2-get-config`
- `phase2-save-config`
- `phase2-fetch-clickup-lists`
- `phase2-fetch-airtable-bases`
- `phase2-run`

References:
- `electron_app/src/main/index.js:844`
- `electron_app/src/main/index.js:861`
- `electron_app/src/main/index.js:872`
- `electron_app/src/main/index.js:897`
- `electron_app/src/main/index.js:921`

Renderer bridge:
- `electron_app/src/preload/preload.js:65`

## 5. Data Contracts
### 5.1 Expected Source Headers
Two supported header variants:
- Current Phase 1 headers.
- Legacy Phase 1 headers.

Reference:
- `electron_app/src/services/phase2ValidationService.js:1`
- `electron_app/src/services/phase2ValidationService.js:40`

### 5.2 Row Filtering
Rows are skipped when:
- Missing `InventoryNumber` -> `missing_ipn`.
- IPN starts with `900`, `950`, `999` -> `excluded_prefix`.

Reference:
- `electron_app/src/services/phase2ValidationService.js:149`

### 5.3 Normalized Fields
Key normalized values used downstream:
- `ipn`, `ipnPrefix`, `qoh`, `categoryCode`, `conditionsAndOptions`, metadata fields.

Reference:
- `electron_app/src/services/phase2ValidationService.js:166`

## 6. Category Resolution Logic
### 6.1 Category Index Build
Category table rows are indexed by `IPN Prefix`, with optional keyword from `Conditions & Options`.

Reference:
- `electron_app/src/services/phase2CategoryService.js:3`

### 6.2 Resolution Outcomes
Resolved:
- `unique_prefix` (single candidate).
- `keyword_match` (exactly one keyword match in row text).

Unresolved:
- `invalid_prefix`
- `no_reference_rows`
- `ambiguous_prefix`

References:
- `electron_app/src/services/phase2CategoryService.js:28`
- `electron_app/src/services/phase2PlanningService.js:34`

## 7. Airtable Upsert Logic
### 7.1 Existing Record Matching
Existing master parts are fetched by IPN and indexed in memory by `record.fields.IPN`.

Reference:
- `electron_app/src/services/phase2Service.js:141`

### 7.2 Create/Update Payload Rules
Create fields:
- `IPN`
- `Quantity (QOH)`
- `Categories` only when resolved.

Update fields:
- `Quantity (QOH)` only when changed.
- `Categories` only when resolved and currently empty.

References:
- `electron_app/src/services/phase2PlanningService.js:44`
- `electron_app/src/services/phase2PlanningService.js:55`

Note:
- `IPN Prefix` is intentionally not written anymore because target base may define it as computed, which is non-writable in Airtable API.

### 7.3 Throughput, Retry, and 422 Fallback
Behavior:
- Throttled to ~5 requests/sec.
- Batched writes of 10 records.
- `typecast: true` on writes.
- If batch gets HTTP 422, retries record-by-record, writes valid ones, collects per-record errors.

References:
- Throttle: `electron_app/src/services/airtableService.js:11`
- Batch write path: `electron_app/src/services/airtableService.js:135`
- 422 fallback: `electron_app/src/services/airtableService.js:162`
- Typecast payload: `electron_app/src/services/airtableService.js:151`

## 8. ClickUp Task Logic
### 8.1 When Task Is Created
Task is planned only when:
- Category could not be resolved.
- Existing Airtable record does not already have `Categories`.
- Task key not already present in cache.

Reference:
- `electron_app/src/services/phase2PlanningService.js:70`

### 8.2 Task Identity and Deduplication
Task key format:
- `ipn::reason`

Saved in:
- `inventoryWebhook.phase2TaskCache` (Electron Store).

References:
- Key: `electron_app/src/services/phase2PlanningService.js:14`
- Cache read/write: `electron_app/src/services/phase2Service.js:147`, `electron_app/src/services/phase2Service.js:248`

### 8.3 Task Payload and Status
Task payload:
- Name: `Resolve Category - <IPN>`
- Description: row details + reason.
- Preferred status: `Open / To-Do - Select Category`.
- If status is invalid (HTTP 400), retries without explicit status so ClickUp default applies.

References:
- `electron_app/src/services/clickupService.js:57`
- `electron_app/src/services/clickupService.js:79`
- `electron_app/src/services/clickupService.js:91`

### 8.4 After Task Is Solved in ClickUp
Current behavior:
- No automatic sync-back from ClickUp status to Airtable.
- Closing a task in ClickUp does not alter Phase 2 data path by itself.
- Cache prevents duplicate task creation for same `ipn::reason` unless cache cleared or reason changes.

## 9. Error Handling and Observability
### 9.1 Progress Event Contract
Event: `phase2-progress`
Payload:
- `stage`
- `percent`
- `counts`
- optional `message`

References:
- Emission: `electron_app/src/main/index.js:930`
- Bridge subscription: `electron_app/src/preload/preload.js:71`

### 9.2 Summary Counters
`summary` tracks:
- totals, skips, created, updated, categoryResolved, clickupTasksCreated, errors, dryRun.

Reference:
- `electron_app/src/services/phase2Service.js:59`

### 9.3 Common Failure Patterns
1. Header mismatch:
- Triggered when sheet columns do not match current or legacy schema.
- `electron_app/src/services/phase2ValidationService.js:114`

2. Airtable 422 (invalid or non-writable field):
- Now isolated per-record where possible.
- Error examples surfaced in summary/log.
- `electron_app/src/services/airtableService.js:116`

3. Missing OAuth/session:
- Source sheet read fails if inventory auth is not connected.
- `electron_app/src/services/phase2SheetsService.js:4`

4. ClickUp access/token/list issues:
- Pre-validated at run start.
- `electron_app/src/services/phase2Service.js:86`

## 10. Performance Notes
For large runs (example ~39k rows):
- Airtable stage dominates runtime.
- 10-record batches + 5 req/sec throttle imply long write windows.
- 422-heavy datasets are slower due to record-level fallback.

References:
- Throttle and batch settings: `electron_app/src/services/airtableService.js:11`, `electron_app/src/services/airtableService.js:135`

## 11. Operational Playbook
### 11.1 First-Time Setup Checklist
1. Connect Google account in Milestone 1 context.
2. Verify sheet tab exists and has supported headers.
3. Use `Find Bases from Token` and select target base.
4. Use `Find Lists from Token` and select target list.
5. Start with dry run to validate counts and task volume expectations.

### 11.2 Safe Live Run Checklist
1. Confirm `Run Mode = Live`.
2. Confirm selected Airtable Base ID is your intended environment (copy/prod).
3. Monitor progress heartbeat in write stage.
4. Inspect summary errors after run and fix schema mismatches.

### 11.3 Cache Management
Task dedupe cache can suppress expected re-creation.
If you intentionally want re-creation, clear `phase2TaskCache` in store before rerun.

## 12. Developer Change Guide
### 12.1 Most Common Change Points
1. Matching rules:
- `electron_app/src/services/phase2CategoryService.js`
2. Upsert payload logic:
- `electron_app/src/services/phase2PlanningService.js`
3. Retry/rate/write behavior:
- `electron_app/src/services/airtableService.js`
4. Run orchestration/progress:
- `electron_app/src/services/phase2Service.js`
5. UI behavior:
- `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html`

### 12.2 Guardrails
1. Never write Airtable computed fields.
2. Keep plan deterministic for idempotent reruns.
3. Preserve dedupe-key semantics when changing task rules.
4. If changing header schema, update both validation variants and migration notes.

## 13. Current Known Limitations
1. Dry run still allows ClickUp task creation in current code path.
2. No automatic task closure/reconciliation based on later Airtable state.
3. Error list is capped to avoid log explosion; additional errors are summarized.

References:
- Error cap behavior: `electron_app/src/services/airtableService.js:142`
