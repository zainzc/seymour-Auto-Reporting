# Phase 5: Approval Gate Publishing

## What Phase 5 does
- Reads listings from `eBay Listings (API) (Mock)` (or configured queue table).
- Publishes in revise-only mode (no create flow).
- Supports two publish modes:
  - Option A (Approval Gate): publishes only explicitly approved rows.
  - Option B (Scheduled Auto-Push): publishes on cron schedule when deterministic eligibility rules match.
- On successful publish, removes the record from the queue table.
- Keeps failed records in the queue for retry.

## Option A: How to mark a record approved
- In Airtable queue table, set your approval field to an explicit approved value, for example:
  - `Approved`
  - `Yes`
  - `True`
  - `Ready to Publish`
- You can also set the exact approval field name in the UI (`Approval Field Name`) if auto-detection is not correct.

## How to run from UI
1. Open Milestone 1 page.
2. Go to **Phase 5 (Approval Gate Publishing)**.
3. Confirm:
   - `Publishing Mode`:
     - `A` for approval-gated publishing
     - `B` for scheduled auto-push
   - eBay credentials:
     - `eBay Environment` (Sandbox/Production, default `Sandbox`)
     - `App ID (Client ID)`
     - `Dev ID`
     - `Cert ID (Client Secret)`
     - `RuName`
   - Click `Test eBay Credentials` before first publish run.
   - `Listings Queue Table` (default: `eBay Listings (API) (Mock)`)
   - Optional `Approval Field Name`
   - Optional `Batch/Group Field` + `Batch/Group Value`
4. Click:
   - `Dry Run Publish Approved` to validate without deleting queue records.
   - `Publish Approved` for real publishing.
5. For Option B:
   - Set `Auto-Push Enabled = true`
   - Set `Cron Expression`
   - Set `Eligibility Field` and `Eligibility Values`
   - Use `Start Auto-Push` (or `Run Auto-Push Now` for immediate execution)

## After publish
- If publish succeeds: record is deleted from queue table.
- If publish fails: record remains in queue and error is shown in logs.
- Rows missing `ItemID` are skipped in revise-only mode.
- Published identities are tracked and skipped in queue re-import/enrichment paths to reduce accidental reintroduction.
- Summary includes:
  - `phase5Mode`
  - `eligibilityField`
  - `eligibilityValues`
  - `approvedFound`
  - `publishedSuccess`
  - `publishedFailed`
  - `removedFromQueue`
  - `skippedNotApproved`
  - `errors[]`
