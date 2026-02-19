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

References:
- UI form fields and run button: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:350`
- Airtable base picker action: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:382`
- ClickUp list picker action: `electron_app/src/renderer/pages/milestone1/phase2-master-parts.html:407`

### 3.2 Save and Run Behavior
On run, frontend passes full config object to backend, so selected base/list/token values are used directly.

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
- totals, skips, created, updated, categoryResolved, clickupTasksCreated, errors.

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

### 11.2 Safe Live Run Checklist
1. Confirm selected Airtable Base ID is your intended environment (copy/prod).
2. Monitor progress heartbeat in write stage.
3. Inspect summary errors after run and fix schema mismatches.

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
1. Write-back depends on manual ClickUp dropdown setup (`Resolved Category`) and consistent status names in the target list.
2. Error list is capped to avoid log explosion; additional errors are summarized.

References:
- Error cap behavior: `electron_app/src/services/airtableService.js:142`

## 14. Phase 2 Write-Back (ClickUp -> Airtable)
Phase 2 now supports polling ClickUp tasks in `Category Determined` status and writing the selected category back to Airtable Master Parts.

### 14.1 Manual ClickUp Setup (required)
In the ClickUp category-resolution list, create a custom dropdown field:
1. Field name: `Resolved Category`
2. Type: `Dropdown`
3. Values: category names that exist in Airtable Category table (`Category Name` field)

If the field is missing, write-back run fails with a clear error.

### 14.2 Poller Behavior
Poller service:
- `electron_app/src/services/phase2WritebackPollerService.js`
- Core logic: `electron_app/src/services/phase2WritebackService.js`

Each run:
1. Fetch tasks in status `Category Determined`.
2. Parse IPN from task title `Resolve Category - {IPN}` or description.
3. Read selected `Resolved Category`.
4. Skip excluded IPNs (`900/950/999`) without Airtable write.
5. If Master Parts already has `Categories`, do not overwrite; complete task.
6. Map selected category by `(IPN Prefix + Category Name)` in Airtable Category table.
7. Update Master Parts `Categories` link.
8. Move task to `Completed` only after successful write-back.

### 14.3 Write-Back Summary Object
Each run records:
- `tasksProcessed`
- `tasksCompleted`
- `tasksErrored`
- `airtableUpdates`
- `skippedExcluded`
- `skippedAlreadyResolved`

The poller logs:
- `Phase2 write-back poll summary { ... }`

### 14.4 Start/Stop/Run-Once Controls
IPC endpoints:
- `phase2-writeback-start`
- `phase2-writeback-stop`
- `phase2-writeback-status`
- `phase2-writeback-run-once`

Preload bridge:
- `phase2API.startWriteback(options)`
- `phase2API.stopWriteback()`
- `phase2API.getWritebackStatus()`
- `phase2API.runWritebackOnce(options)`

### 14.5 Config / Env for Write-Back
Add these env vars as needed:

```env
PHASE2_WRITEBACK_ENABLED=true
WRITEBACK_POLL_INTERVAL_MINUTES=5
CLICKUP_RESOLVED_CATEGORY_FIELD_NAME=Resolved Category
CLICKUP_STATUS_DETERMINED=Category Determined
CLICKUP_STATUS_COMPLETED=Completed
```

### 14.8 Phase 2 Auto-Run on Sheet Changes
Phase 2 can now run automatically when source sheet data changes.

Triggers:
1. Immediate trigger after successful Phase 1 inventory push.
2. Background poller that fingerprints source sheet content and runs Phase 2 only on change.

Safety controls:
- No concurrent Phase 2 runs.
- Cooldown window to avoid thrashing.
- Baseline initialization on first poll (no forced replay).

Env keys:
```env
PHASE2_AUTORUN_ENABLED=true
PHASE2_AUTORUN_POLL_MINUTES=3
PHASE2_AUTORUN_COOLDOWN_MINUTES=5
```

IPC controls:
- `phase2-autorun-status`
- `phase2-autorun-start`
- `phase2-autorun-stop`
- `phase2-autorun-run-now`

Also ensure these existing values are set:
- `CLICKUP_TOKEN`
- `CLICKUP_LIST_ID`
- `AIRTABLE_TOKEN`
- `AIRTABLE_BASE_ID`
- `AIRTABLE_MASTER_TABLE`
- `AIRTABLE_CATEGORY_TABLE`

### 14.6 Verification Steps
1. Set a task to `Category Determined` and choose `Resolved Category`.
2. Run once via IPC (`phase2-writeback-run-once`) or wait for poll interval.
3. Confirm Airtable Master Parts record for that IPN now has `Categories` set.
4. Confirm task moved to `Completed`.

### 14.7 Edge Cases Handled
1. Missing IPN in task: comment + task stays open.
2. Missing Resolved Category selection: comment + task stays open.
3. Master Parts record missing: comment + task stays open.
4. Duplicate or missing category mapping for prefix+name: comment + task stays open.
5. Excluded IPNs: no write-back; task auto-completed with comment.

## 15. Remote Task Dedupe During Phase 2 Task Creation
Before creating new ClickUp tasks, Phase 2 now preloads open tasks in the target list and skips creation when an open task for the same IPN already exists.

References:
- Dedupe preload: `electron_app/src/services/phase2Service.js`
- Open task IPN scan: `electron_app/src/services/clickupService.js`
