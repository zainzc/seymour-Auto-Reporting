# Pages Directory Structure

This directory contains all the HTML pages organized by milestone for better developer navigation.

## File Organization

```
pages/
├── main-dashboard.html          # Main entry point for the application
├── milestone1/                  # Milestone 1: Listing Enrichment & Automation
│   ├── index.html              # Main milestone 1 dashboard
│   └── inventory-webhook.html  # Inventory webhook management
├── milestone11/                 # Milestone 11: Auto Reporting
│   └── index.html              # Reporting dashboard (formerly reporting.html)
├── seymour-autosync/           # Seymour AutoSync functionality
│   └── index.html              # Database sync dashboard (formerly dashboard.html)
└── shared/                     # Shared components across milestones
    ├── setup.html              # Database configuration
    └── webhook.html            # Webhook configuration
```

## Navigation Structure

- **main-dashboard.html**: Entry point with milestone selection
- **milestone1/**: Listing enrichment and automation features per SOW
- **milestone11/**: Auto reporting with Excel and Google Sheets integration  
- **seymour-autosync/**: Database synchronization and table management
- **shared/**: Configuration pages used across multiple milestones

## Developer Notes

- Each milestone has its own folder for easy identification
- `index.html` files serve as the main entry point for each milestone
- All navigation links have been updated to use relative paths
- CSS references have been adjusted for the new directory structure
- Back navigation consistently returns to the appropriate parent level