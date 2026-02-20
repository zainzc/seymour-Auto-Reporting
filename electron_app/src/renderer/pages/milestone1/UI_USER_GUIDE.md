# Milestone 1 UI Guide (User POV)

This is a simple user guide for both workspaces:
- Phase 1 = `Inventory Sync Workspace`
- Phase 2 = `Master Parts Sync Workspace`

## Phase 1: Inventory Sync Workspace

### Google Authentication
- `Connect to Google` : Connect your Google account for Sheets access.
- `Disconnect` (same button after connected) : Remove saved Google connection.
- `Connected: <email>` : Shows which Google account is currently connected.

### Google Sheets Configuration
- `Google Sheets URL` : Target spreadsheet link.
- `Target Worksheet Name` : Sheet tab name to write data into.
- `Test Connection` : Verifies URL/tab access and permissions.
- `Save Configuration` : Saves Spreadsheet + Worksheet settings.

### Schedule Control
- `Start Daily Schedule` : Starts automatic daily sync.
- `Stop Schedule` : Stops automatic daily sync.
- `Run Sync Now` : Runs one immediate manual sync.
- `Schedule Inactive/Active` : Current scheduler state.

### Execution History
- `Execution History` list : Shows latest run results (success/failure, timestamps).


## Phase 2: Master Parts Sync Workspace

### 1) Connect and Configure

#### Source (Google Sheets)
- `Google Sheet ID` : Spreadsheet ID used as input.
- `Google Tab Name` : Sheet tab used as input.

#### Destination (Airtable)
- `Airtable Token` : API token for Airtable access.
- `Airtable Base ID` : Target Airtable base.
- `Find Bases from Token` : Fetches base list from token and helps select Base ID.

#### Tasks (ClickUp)
- `ClickUp Token` : API token for ClickUp access.
- `ClickUp List ID` : Target ClickUp list.
- `Find Lists from Token` : Fetches list options from token and helps select List ID.

#### Setup Actions
- `Validate Setup` : Checks required fields and validates Airtable/ClickUp access.
- `Save Settings` : Saves current configuration.
- `Source/Airtable/ClickUp: Configured` badges : Quick readiness indicators.

### 2) Run and Automation
- `Run Sync` : Executes full master-parts sync pipeline.
- `Start Write-back` : Starts polling ClickUp for resolved-category updates.
- `Stop Write-back` : Stops write-back poller.
- `Run Write-back Once` : Executes one write-back cycle immediately.
- `Refresh Status` : Refreshes write-back poller status text.
- `Run state (Idle/Running/Success/Error)` : Current operation state.

### 3) Status and Progress
- `Progress bar` : Live progress through pipeline stages.
- `Stage text` : Current step details (read, normalize, writes, tasks).
- `Summary cards` : Key counters:
  - Total Rows
  - Valid Rows
  - Created
  - Updated
  - Category Resolved
  - Tasks Created
  - Skipped Missing IPN
  - Skipped Excluded Prefix

### Summary Cards Meaning (Phase 2)
- `Total Rows` : Total source rows read from Google tab (excluding header).
- `Valid Rows` : Rows that passed basic filters and were eligible for processing.
- `Created` : New records inserted into Airtable Master Parts.
- `Updated` : Existing Airtable Master Parts records that were updated.
- `Category Resolved` : Rows where category mapping was auto-resolved by rules.
- `Tasks Created` : New ClickUp tasks created for unresolved/ambiguous rows.
- `Skipped Missing IPN` : Rows skipped because IPN/Inventory number was blank.
- `Skipped Excluded Prefix` : Rows skipped due to excluded IPN prefixes (`900`, `950`, `999`).

### 4) Activity Log
- `Collapse/Expand Logs` : Hide or show log list.
- `All / Errors only / Latest 20` : Filter displayed logs.
- `Clear Logs` : Clear current log view.


## Recommended User Flow
1. In Phase 1, connect Google, test/save config, then run schedule or manual sync.
2. In Phase 2, fill tokens/IDs, validate setup, save settings.
3. Run `Run Sync`.
4. Use write-back controls if resolving categories via ClickUp.
