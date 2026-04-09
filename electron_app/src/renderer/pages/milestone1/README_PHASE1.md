# Phase 1: Powerlink → Google Sheets Integration

## Overview
This implements Phase 1 of Milestone 1, establishing a stable, automated pipeline for extracting inventory data from Powerlink (SQL Database) and writing it to Google Sheets on a 24-hour schedule.

## Key Features Implemented

### ✅ **Core Requirements Met**
- **24-Hour Automated Schedule**: Runs daily at midnight via cron job
- **Full Dataset Refresh**: Overwrites existing data (no append/partial updates)
- **Strict Column Adherence**: Maintains exact column ordering and definitions from Powerlink
- **External Authority**: Google Sheets serves as canonical raw inventory dataset
- **Decoupled Architecture**: Separates data extraction from downstream enrichment logic

### ✅ **Technical Implementation**
- **Google Sheets API Integration**: Full read/write access via OAuth2
- **Powerlink Database Connection**: Extracts all inventory fields as specified
- **Automated Schedule Management**: Start/stop 24-hour schedule with status monitoring
- **Error Handling & Logging**: Comprehensive execution history and error reporting
- **Configuration Management**: Persistent storage of Google Sheets settings

### ✅ **User Interface**
- **Phase 1 Dashboard**: Dedicated UI at `milestone1/powerlink-sheets.html`
- **Google Authentication**: Connect to Google account for Sheets access
- **Configuration Panel**: Set target spreadsheet and worksheet
- **Schedule Controls**: Start/stop automated 24-hour pipeline
- **Real-time Monitoring**: View execution logs and schedule status
- **Manual Testing**: Test push functionality for immediate verification

## File Structure
```
milestone1/
├── index.html              # Milestone 1 main dashboard
├── powerlink-sheets.html   # Phase 1: Powerlink → Google Sheets UI
└── (Phase 2-7 to be added here)

services/
├── googleSheetsInventoryService.js  # Google Sheets write operations
├── inventoryScheduleService.js      # 24-hour cron schedule management (updated)
├── inventoryService.js              # Powerlink database queries
└── oauth2Service.js                 # Google authentication (existing)
```

## Usage Instructions

### 1. **Connect to Google**
   - Click "Connect to Google" to authenticate
   - Grant permissions for Google Sheets access

### 2. **Configure Google Sheets**
   - Enter your Google Sheets URL
   - Specify the target worksheet name (must exist)
   - Test connection to validate settings

### 3. **Start 24-Hour Schedule** 
   - Save configuration first
   - Click "Start 24-Hour Schedule"
   - System will run daily at midnight

### 4. **Monitor Execution**
   - View real-time schedule status
   - Check execution history for success/failure logs
   - Use "Test Push Now" for manual verification

## Phase 1 Constraints (Enforced)

### ❌ **Prohibited Actions**
- ✗ Creating additional Google Sheets files
- ✗ Renaming, reordering, or removing columns  
- ✗ Adding calculated, derived, or transformed fields
- ✗ Partial updates or data appending
- ✗ Reference to legacy "Current Inventory" Airtable table

### ✅ **Required Behaviors**
- ✓ Full dataset overwrite on each execution
- ✓ Strict adherence to provided column definitions
- ✓ External worksheet name and structure definition
- ✓ Daily execution at fixed 24-hour intervals
- ✓ Google Sheets as sole upstream source for downstream phases

## Technical Notes

### **Data Flow**
1. **Extract**: Query all inventory records from Powerlink database
2. **Transform**: Format data according to Google Sheets requirements
3. **Load**: Clear existing worksheet data and write fresh dataset
4. **Log**: Record execution results with timestamp and record count

### **Schedule Management**  
- Uses `node-cron` for reliable 24-hour scheduling
- Persists schedule state across application restarts
- Automatic schedule restoration on app launch if previously active

### **Error Handling**
- Comprehensive Google Sheets API error handling
- Authentication status monitoring
- Detailed execution logging with success/failure tracking
- User-friendly error messages for common issues

## Next Steps
Phase 1 establishes the foundation for subsequent phases:
- **Phase 2**: Google Sheets → Airtable ingestion with IPN persistence
- **Phase 3**: ShipStation API integration for dimensions/weight
- **Phase 4**: Item Specifics automation with AI-assisted rules
- **Phase 5**: Pre-publication governance and approval workflows
- **Phase 6**: Fitment extraction and copyright-safe rewriting  
- **Phase 7**: Listing automation with title/description generation

This Phase 1 implementation provides the stable, externally-governed raw inventory dataset required as input for all downstream enrichment and automation workflows.

## Phase 5 Reference

For Approval Gate publishing setup and runtime behavior, see:
- `electron_app/src/renderer/pages/milestone1/README_PHASE5.md`
