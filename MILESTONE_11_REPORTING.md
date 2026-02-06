# 📊 Milestone 11 – Seymour Auto Reporting

## Overview

**Seymour Auto Reporting** is a controlled data extraction system that pulls invoice data from Powerlink (SQL Server) and exports it either as manual Excel files or scheduled Google Sheets updates.

---

## ✨ Key Features

### 1. **Manual Export Mode** (Excel Only)
- One-off, human-triggered exports
- Date range filtering
- Salesperson filtering (with ALL option)
- Direct browser download to `.xlsx`
- Stateless execution

### 2. **Scheduled Download Mode** (Google Sheets Only)
- Nightly runs (previous calendar day, 00:00-23:59)
- Weekly runs (last completed week, configurable start day)
- Optional end date (auto-deactivates schedule)
- Overwrites RAW tab only
- Includes last-run timestamp
- Mutually exclusive with manual mode

### 3. **Data Governance**
- **Invoice-only extraction** from Powerlink
- UI shows 4 data types (Invoices enabled, others disabled 🔒)
- No transformations, business rules, or enrichment
- Raw data only

---

## 📋 Setup

### Prerequisites
```bash
npm install exceljs googleapis node-cron
```

### Google Sheets Setup (Required for Scheduled Mode)

1. **Create Service Account** (Google Cloud Console)
   - Project → Service Accounts
   - Create new service account
   - Create JSON key
   - Grant "Editor" access to Sheets API

2. **Add Credentials File**
   ```
   electron_app/src/config/google-credentials.json
   ```

3. **Configure Spreadsheet ID**
   - Copy Google Sheets URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
   - Store in app via UI or directly in config

### Invoice Table Schema (Required)

Your Powerlink database must have an `Invoices` table with at least these columns:

```sql
CREATE TABLE Invoices (
  InvoiceNumber NVARCHAR(50),
  InvoiceDate DATETIME,
  CustomerName NVARCHAR(200),
  Salesperson NVARCHAR(100),
  TotalAmount DECIMAL(18, 2),
  Status NVARCHAR(50),
  PaymentStatus NVARCHAR(50)
)
```

---

## 🎯 UI Walkthrough

### Dashboard
- Click **📊 Auto Reporting** button to access the reporting interface

### Reporting Page

#### Step 1: Select Data Type
- **✔️ Invoices** (enabled, clickable)
- 🔒 Quotes (disabled)
- 🔒 Work Orders (disabled)
- 🔒 Inventory (disabled)

#### Step 2: Choose Execution Mode

##### Manual Export (Excel)
```
┌─────────────────────────┐
│ Date Range              │
├─────────────────────────┤
│ From: [date picker]     │
│ To:   [date picker]     │
├─────────────────────────┤
│ Salesperson: [dropdown] │
├─────────────────────────┤
│ Export Now to .xls      │
└─────────────────────────┘
```

**Action:** Click "Export Now" → browser downloads Excel file

##### Scheduled Download (Google Sheets)
```
┌─────────────────────────┐
│ Frequency: [dropdown]   │
│  - Nightly              │
│  - Weekly               │
├─────────────────────────┤
│ Week Start: [dropdown]  │ (weekly only)
├─────────────────────────┤
│ End Date: [optional]    │
├─────────────────────────┤
│ Destination: RAW Tab    │ (fixed, read-only)
├─────────────────────────┤
│ Save Schedule | Cancel  │
└─────────────────────────┘
```

**Actions:**
- **Save Schedule** → Starts automated job
- **Cancel Schedule** → Stops future runs

---

## 🔧 How It Works

### Manual Export Flow

```
User clicks "Export Now"
    ↓
Validate date range & salesperson filter
    ↓
Query Powerlink Invoices table
    ↓
Generate Excel workbook
    ↓
Trigger browser download
    ↓
Log execution (success/failure)
    ↓
Done (system forgets it happened)
```

### Scheduled Export Flow

```
User saves schedule config (Nightly/Weekly)
    ↓
Schedule stored in electron-store
    ↓
App startup → Resume schedule from config
    ↓
Cron job runs at specified time
    ↓
Query Powerlink invoices (date range based on frequency)
    ↓
Check end date → deactivate if reached
    ↓
Write to Google Sheets RAW tab (overwrites)
    ↓
Add last-run timestamp
    ↓
Log execution + update lastRun timestamp
    ↓
Next run at scheduled time
```

---

## 📊 Nightly Schedule Logic

**Frequency:** Once per day at **00:00 (midnight)**

**Date Window:** Previous calendar day
- Pulls invoices from 00:00 → 23:59 of yesterday

**Example:**
- Today: Wednesday, Jan 29
- Run pulls: Tuesday, Jan 28 (00:00-23:59)
- Run time: Tonight at midnight

---

## 📈 Weekly Schedule Logic

**Frequency:** Once per week at specified day + **00:00 (midnight)**

**Date Window:** Last completed week
- Default: Monday → Sunday
- Configurable: Custom week start day

**Example (Monday start):**
- Today: Wednesday, Jan 29, 2025
- Last completed week: Mon Jan 20 → Sun Jan 26
- Run pulls: Invoices from Jan 20-26
- Next run: Monday, Jan 27 at midnight

---

## 🔐 Google Sheets Constraints

### RAW Tab Only
- **Write:** RAW tab ONLY
- **Read:** None
- **Ignore:** All other tabs

### Overwrite Behavior
- **Every run:** Clears old data, writes new data
- **Never:** Appends, merges, or partial updates
- **Result:** RAW tab is always a snapshot

### Column Rules
- Column order must match invoices exactly
- Column names must match invoices exactly
- No added columns
- No removed columns

### Last Run Timestamp
- Written to a separate cell after data
- Format: ISO 8601 (e.g., `2025-01-29T14:23:45.123Z`)
- Human-readable for visibility

---

## 📝 Execution Logs

All executions (manual & scheduled) are logged:

```javascript
{
  timestamp: "2025-01-29T14:23:45.123Z",
  type: "Manual" | "Scheduled",
  success: true | false,
  message: "X records exported" | error message
}
```

**Stored:** `electron-store` under `reporting.executionLogs`
**Retention:** Last 100 logs (oldest auto-pruned)

---

## 🛑 Error Handling

### All-or-Nothing Guarantee
If an error occurs:
- ❌ Do NOT partially overwrite RAW tab
- ❌ Do NOT corrupt file
- ❌ Do NOT leave mixed data

**Behavior:**
- Log the error
- Retain previous data (no write = no change)
- Return error message to user/logs

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `DB not ready` | Database connection failed | Check Powerlink connection in setup |
| `No data to export` | No invoices match criteria | Try broader date range |
| `Google Sheets credentials not found` | Missing google-credentials.json | Add service account JSON to config folder |
| `Cannot access Google Sheets` | Invalid spreadsheet ID or permissions | Verify sheet ID & sharing settings |
| `RAW tab not found` | Sheet doesn't have RAW tab | Add tab or use different sheet |

---

## 🔄 Mutually Exclusive Modes

### Design Guarantee
- Only **ONE** active schedule at a time
- Switching modes:
  - Hides disabled mode controls
  - Deactivates any active schedule in other mode
  - Prevents accidental overlap

### Why?
- Avoids duplicate data pulls
- Prevents conflicting Google Sheets writes
- Ensures clear user intention

---

## 📂 Project Structure

```
electron_app/src/
├── main/
│   └── index.js                 # IPC handlers for reporting
├── services/
│   ├── reportingService.js      # Invoice extraction queries
│   ├── excelService.js          # Excel generation
│   ├── sheetsService.js         # Google Sheets API integration
│   └── scheduleService.js       # Cron job management
├── config/
│   ├── configStore.js           # Reporting config storage
│   └── google-credentials.json  # Google service account (add manually)
├── preload/
│   └── preload.js               # Reporting API exposure
└── renderer/
    └── pages/
        └── reporting.html       # Seymour Auto Reporting UI
```

---

## 🔌 API Reference

### Renderer API (IPC Channels)

#### `window.reportingAPI.getSalespeople()`
Get list of salespeople from invoices

**Returns:** `Promise<Array<string>>`

#### `window.reportingAPI.exportToExcel(params)`
Export invoices to Excel file

**Params:**
```javascript
{
  dataType: 'invoices',
  dateFrom: '2025-01-01',
  dateTo: '2025-01-31',
  salesperson: 'John Doe' | 'ALL'
}
```

**Returns:** `Promise<{success: boolean, message: string}>`

#### `window.reportingAPI.saveSchedule(config)`
Save & activate scheduled export

**Params:**
```javascript
{
  dataType: 'invoices',
  frequency: 'nightly' | 'weekly',
  weekStartDay: 1,  // 0=Sun, 1=Mon, etc. (weekly only)
  endDate: '2025-12-31' | null
}
```

**Returns:** `Promise<{success: boolean, message: string}>`

#### `window.reportingAPI.cancelSchedule()`
Deactivate active schedule

**Returns:** `Promise<{success: boolean, message: string}>`

#### `window.reportingAPI.getCurrentSchedule()`
Get currently active schedule config

**Returns:** `Promise<Object | null>`

#### `window.reportingAPI.getExecutionLogs(limit)`
Get recent execution logs

**Params:** `limit` (default 50)

**Returns:** `Promise<Array<ExecutionLog>>`

---

## 🚀 Usage Examples

### Example 1: Manual Monthly Export
1. Go to Dashboard → **Auto Reporting**
2. Select **Manual Export (Excel)**
3. Set dates: Jan 1 → Jan 31
4. Select salesperson or leave as **ALL**
5. Click **Export Now to .xls**
6. Save file to Downloads

### Example 2: Daily Nightly Schedule
1. Go to Dashboard → **Auto Reporting**
2. Select **Scheduled Download (Google Sheets)**
3. Frequency: **Nightly**
4. Click **Save Schedule**
5. System runs every midnight, pulls previous day's invoices, overwrites RAW tab

### Example 3: Weekly Report Every Friday
1. Go to Dashboard → **Auto Reporting**
2. Select **Scheduled Download (Google Sheets)**
3. Frequency: **Weekly**
4. Week Start Day: **Friday**
5. Click **Save Schedule**
6. System runs every Friday at midnight with last week's data

---

## 🐛 Troubleshooting

### Schedule Not Running?
1. Check if app is still running
2. Verify database connection (check Dashboard)
3. Check execution logs for errors
4. System tray may minimize app (currently disabled, but planned)

### Excel Export Empty?
1. Verify date range includes invoices
2. Check if salesperson filter is too narrow
3. Try **ALL** for salesperson
4. Check invoice table is populated

### Google Sheets Not Updating?
1. Verify credentials file exists: `src/config/google-credentials.json`
2. Check spreadsheet ID is correct
3. Verify sheet has **RAW** tab
4. Check service account has Editor permissions on sheet
5. Check execution logs for API errors

---

## 🔮 Future Enhancements (Not in Scope)

- System tray background running
- Email notifications on schedule completion
- Multiple tables extraction (currently invoice-only)
- Data transformations & enrichment
- BI dashboards & analytics
- Slack notifications
- Custom export formats (CSV, PDF)

---

## ✅ Testing Checklist

- [ ] Manual export with date range works
- [ ] Salesperson filter works (and ALL default)
- [ ] Excel file downloads correctly
- [ ] Nightly schedule saves & shows in current schedule
- [ ] Weekly schedule with custom week start day works
- [ ] End date auto-deactivates schedule
- [ ] Google Sheets RAW tab overwrites correctly
- [ ] Last-run timestamp appears in sheet
- [ ] Switching modes disables the other mode
- [ ] Execution logs record both manual & scheduled runs
- [ ] Errors don't corrupt Google Sheets data

---

## 📞 Support

For issues or questions:
1. Check **Execution Logs** (visible in Reporting UI)
2. Review error messages in logs
3. Verify prerequisites (DB, Google credentials)
4. Check this documentation

---

**Built with:** Electron + Node.js + ExcelJS + Google Sheets API + node-cron
