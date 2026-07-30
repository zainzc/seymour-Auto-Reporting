#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const outDir = path.join(root, '.ua');
const outPath = path.join(outDir, 'knowledge-graph.json');
const metaPath = path.join(outDir, 'meta.json');

fs.mkdirSync(outDir, { recursive: true });

const gitCommitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

const rawFiles = execFileSync('rg', ['--files', '.'], {
  cwd: root,
  encoding: 'utf8',
}).split(/\r?\n/).map(s => s.trim()).filter(Boolean);

const files = rawFiles
  .map(f => f.replace(/^\.\//, '').replace(/^\.\\/, '').replace(/\\/g, '/'))
  .filter(f => !f.includes('/node_modules/'))
  .filter(f => !f.startsWith('node_modules/'))
  .filter(f => !f.startsWith('.git/'));

const tracked = new Set(files);

function posix(p) {
  return p.split(path.sep).join('/');
}

function titleCase(input) {
  return String(input)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase());
}

function stripExt(filePath) {
  return filePath.replace(/\.[^.]+$/, '');
}

function baseName(rel) {
  return path.posix.basename(rel);
}

function summaryFor(rel) {
  const p = rel;
  const b = baseName(rel);

  const specific = new Map([
    ['MILESTONE_11_REPORTING.md', 'Overview and setup guide for Seymour Auto Reporting.'],
    ['electron_app/PHASE2_README.md', 'Milestone guide for the Phase 2 Google Sheets to Airtable master-parts flow.'],
    ['electron_app/PHASE3_README.md', 'Milestone guide for the Phase 3 ShipStation and Powerlink flow.'],
    ['electron_app/package.json', 'Electron app manifest and npm scripts.'],
    ['electron_app/package-lock.json', 'Electron app npm lockfile snapshot.'],
    ['package-lock.json', 'Repository-level npm lockfile snapshot.'],
    ['electron_app/forge.config.js', 'Electron Forge packaging and maker configuration.'],
    ['electron_app/src/main/index.js', 'Electron main-process bootstrap that wires windows, IPC, and feature services.'],
    ['electron_app/src/preload/preload.js', 'Secure preload bridge that exposes renderer-safe APIs with contextBridge.'],
    ['electron_app/src/config/loadEnv.js', 'Loads environment variables before the Electron app starts.'],
    ['electron_app/src/config/env.js', 'Central environment settings for reporting and scheduling.'],
    ['electron_app/src/config/configStore.js', 'Persistent store helpers for application configuration and workflow state.'],
    ['electron_app/src/services/db.js', 'Database initialization and connection helpers.'],
    ['electron_app/src/services/reportingService.js', 'Reporting workflow for invoice retrieval and salesperson lookup.'],
    ['electron_app/src/services/excelService.js', 'Builds Excel exports for reporting workflows.'],
    ['electron_app/src/services/sheetsService.js', 'Google Sheets integration for reporting exports and raw-tab writes.'],
    ['electron_app/src/services/scheduleService.js', 'Schedules reporting jobs and records execution logs.'],
    ['electron_app/src/services/workOrdersGoogleSheetsSync.js', 'Synchronizes work orders between Google Sheets and ClickUp.'],
    ['electron_app/src/services/workOrdersScheduleService.js', 'Schedules work-order sync jobs and logs executions.'],
    ['electron_app/src/services/oauth2Service.js', 'OAuth2 helper for Google authentication.'],
    ['electron_app/src/services/phase2Service.js', 'Phase 2 orchestration for Google Sheets to Airtable master-parts processing.'],
    ['electron_app/src/services/phase3Service.js', 'Phase 3 orchestration for ShipStation mapping and Powerlink enrichment.'],
    ['electron_app/src/services/phase4MirroringService.js', 'Phase 4 orchestration for item-specific mirroring workflows.'],
    ['electron_app/src/services/phase5Service.js', 'Phase 5 publishing workflow for approved listings.'],
    ['electron_app/src/services/phase6FitmentService.js', 'Phase 6 fitment workflow service.'],
    ['electron_app/src/services/phase72FitmentImageService.js', 'Phase 72 fitment image workflow service.'],
    ['electron_app/src/services/phase74TitleDescriptionService.js', 'Phase 74 title and description workflow service.'],
    ['electron_app/src/services/inventoryService.js', 'Inventory synchronization and data access helpers.'],
    ['electron_app/src/services/inventoryScheduleService.js', 'Schedules inventory sync jobs and execution tracking.'],
    ['electron_app/src/services/googleSheetsInventoryService.js', 'Google Sheets integration for inventory workflows.'],
    ['electron_app/src/services/googleDriveImageService.js', 'Google Drive image upload and retrieval helpers.'],
    ['electron_app/src/services/batchCreationService.js', 'Creates publish batches from listing data.'],
    ['electron_app/src/services/rulesLogicService.js', 'Business rules engine for item-specific transformations.'],
    ['electron_app/src/services/phase2ValidationService.js', 'Validation logic for Phase 2 data quality checks.'],
    ['electron_app/src/services/phase2SheetsService.js', 'Google Sheets helpers for Phase 2 intake and writeback.'],
    ['electron_app/src/services/phase2WritebackService.js', 'Phase 2 writeback workflow for persisting processed data.'],
    ['electron_app/src/services/phase2WritebackPollerService.js', 'Background poller for Phase 2 writeback status.'],
    ['electron_app/src/services/phase2AutoRunService.js', 'Automatic run orchestration for Phase 2.'],
    ['electron_app/src/services/phase2CategoryResolutionV2Service.js', 'Category resolution helpers for Phase 2 processing.'],
    ['electron_app/src/services/phase3PlanningService.js', 'Planning helpers for Phase 3 processing.'],
    ['electron_app/src/services/phase3PowerlinkMappingService.js', 'Powerlink mapping helpers for Phase 3.'],
    ['electron_app/src/services/phase3ShipstationService.js', 'ShipStation integration for Phase 3.'],
    ['electron_app/src/services/phase3ShipstationDebugExportService.js', 'Debug export helpers for Phase 3 ShipStation data.'],
    ['electron_app/src/services/phase4AiEvaluatorService.js', 'AI evaluation helpers used during Phase 4 workflows.'],
    ['electron_app/src/services/phase5ApprovalService.js', 'Approval checks for Phase 5 publishing.'],
    ['electron_app/src/services/phase5AutoPushScheduleService.js', 'Auto-push scheduling for Phase 5 publishing.'],
    ['electron_app/src/services/phase5BatchGovernanceService.js', 'Batch governance and validation helpers for Phase 5.'],
    ['electron_app/src/services/phase5EbayPublishService.js', 'eBay publish integration for Phase 5 listings.'],
    ['electron_app/src/services/phase5GovernanceService.js', 'Governance rules for listing publication.'],
    ['electron_app/src/services/phase5IdentityService.js', 'Identity and account helpers for Phase 5.'],
    ['electron_app/src/services/phase5PublishLogService.js', 'Publication logging helpers for Phase 5.'],
    ['electron_app/src/services/masterEbayItemSpecificsUrlService.js', 'Backfills master eBay item-specific URLs.'],
    ['electron_app/src/services/ebayBrandPropagationService.js', 'Propagates brand data for eBay workflows.'],
    ['electron_app/src/services/ebayListingsScheduleService.js', 'Schedules eBay listing import and refresh jobs.'],
    ['electron_app/src/scripts/syncItemSpecificTables.js', 'Utility script for synchronizing item-specific tables.'],
    ['electron_app/src/scripts/runPhase4Mirroring.js', 'CLI wrapper for running the Phase 4 mirroring workflow.'],
    ['electron_app/src/scripts/runPhase4BLite.js', 'CLI wrapper for the Phase 4B-lite workflow.'],
    ['electron_app/src/scripts/runPhase4RulesPopulate.js', 'CLI wrapper for populating fixed Phase 4 rules.'],
    ['electron_app/src/scripts/runPhase6Fitment.js', 'CLI wrapper for the Phase 6 fitment workflow.'],
    ['electron_app/src/scripts/runPhase72FitmentImage.js', 'CLI wrapper for the Phase 72 fitment image workflow.'],
    ['electron_app/src/scripts/runPhase74TitleDescription.js', 'CLI wrapper for the Phase 74 title-description workflow.'],
    ['electron_app/src/scripts/runEbayMockImport.js', 'CLI wrapper for the eBay mock import workflow.'],
    ['electron_app/src/scripts/runEbaySandboxInventoryImport.js', 'CLI wrapper for the eBay sandbox inventory import workflow.'],
    ['electron_app/scripts/test-workorders-sync.js', 'Manual test harness for the work-order sync workflow.'],
    ['electron_app/scripts/test-workorders-query.js', 'Manual test harness for work-order query behavior.'],
    ['electron_app/scripts/test-drive-image-upload.js', 'Manual test harness for Drive image upload behavior.'],
    ['electron_app/src/renderer/styles/index.css', 'Global renderer stylesheet.'],
    ['electron_app/src/renderer/pages/main-dashboard.html', 'Main renderer dashboard shell.'],
    ['electron_app/src/renderer/pages/milestone1/index.html', 'Milestone 1 landing page for the reporting and inventory workflows.'],
    ['electron_app/src/renderer/pages/milestone1/powerlink-sheets.html', 'Milestone 1 page for Powerlink and Sheets setup.'],
    ['electron_app/src/renderer/pages/milestone1/phase2-master-parts.html', 'Milestone 1 page for Phase 2 master-parts setup.'],
    ['electron_app/src/renderer/pages/milestone1/phase5-batch-approval.html', 'Milestone 1 page for batch approval and governance.'],
    ['electron_app/src/renderer/pages/milestone11/index.html', 'Milestone 11 reporting UI page.'],
    ['electron_app/src/renderer/pages/shared/setup.html', 'Shared setup page for initial application configuration.'],
    ['electron_app/src/renderer/pages/shared/webhook.html', 'Shared webhook configuration page.'],
    ['electron_app/output/itemSpecificExtracted.json', 'Generated item-specific extraction output snapshot.'],
  ]);

  if (specific.has(p)) return specific.get(p);

  if (p.startsWith('electron_app/output/fitment-images/')) {
    return 'Generated fitment image asset used by the fitment workflow.';
  }

  if (p.startsWith('electron_app/src/services/phase2')) {
    return 'Phase 2 workflow support module for master-parts intake, validation, and writeback.';
  }
  if (p.startsWith('electron_app/src/services/phase3')) {
    return 'Phase 3 workflow support module for ShipStation mapping and Powerlink enrichment.';
  }
  if (p.startsWith('electron_app/src/services/phase4')) {
    return 'Phase 4 workflow support module for mirroring, rules, and evaluation.';
  }
  if (p.startsWith('electron_app/src/services/phase5')) {
    return 'Phase 5 workflow support module for publishing, governance, and scheduling.';
  }
  if (p.startsWith('electron_app/src/services/phase6')) {
    return 'Phase 6 workflow support module for fitment handling.';
  }
  if (p.startsWith('electron_app/src/services/phase72')) {
    return 'Phase 72 workflow support module for fitment images.';
  }
  if (p.startsWith('electron_app/src/services/phase74')) {
    return 'Phase 74 workflow support module for title and description generation.';
  }
  if (p.includes('/services/')) {
    return `Service module for ${titleCase(stripExt(b).replace(/Service$/, ''))}.`;
  }
  if (p.includes('/scripts/')) {
    return `Script entry point for ${titleCase(stripExt(b))}.`;
  }
  if (p.includes('/renderer/pages/')) {
    return `Renderer page for ${titleCase(stripExt(b))}.`;
  }
  if (p.includes('/renderer/styles/')) {
    return 'Renderer stylesheet and UI theme definitions.';
  }
  if (p.endsWith('.md')) {
    return `Documentation file for ${titleCase(stripExt(b))}.`;
  }
  if (p.endsWith('.json')) {
    return `Structured data file for ${titleCase(stripExt(b))}.`;
  }
  if (p.endsWith('.svg')) {
    return 'Vector asset used by the Electron app UI or workflow outputs.';
  }
  return `Project file for ${titleCase(stripExt(b))}.`;
}

function nodeTypeFor(rel) {
  const p = rel.replace(/\\/g, '/');
  const lower = p.toLowerCase();
  const base = path.posix.basename(lower);

  if (p.startsWith('electron_app/output/')) return 'resource';
  if (lower.endsWith('.svg') || lower.endsWith('.csv')) return 'resource';
  if (base === 'package.json' || base === 'package-lock.json' || base === 'pnpm-lock.yaml' || base === 'pnpm-workspace.yaml' || base === 'tsconfig.json' || base === 'vitest.config.ts' || base === '.gitignore' || base === 'forge.config.js') return 'config';
  if (lower.endsWith('.md')) return 'document';
  if (lower.includes('/services/')) return 'service';
  if (lower.endsWith('.html') || lower.endsWith('.css') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'file';
  if (lower.endsWith('.json')) return 'config';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml') || lower.endsWith('.ini') || lower.endsWith('.env')) return 'config';
  return 'file';
}

function nodeIdFor(type, rel) {
  return `${type}:${rel}`;
}

function tokensFor(rel) {
  const text = rel
    .replace(/^electron_app\//, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/_.\-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

  const pieces = text.split(/\s+/).filter(Boolean);
  const tags = new Set();

  for (const piece of pieces) {
    if (piece.length >= 3) tags.add(piece);
    if (/^phase\d+/.test(piece)) tags.add(piece);
  }

  if (rel.includes('/services/')) tags.add('service');
  if (rel.includes('/scripts/')) tags.add('script');
  if (rel.includes('/renderer/')) tags.add('renderer');
  if (rel.includes('/config/')) tags.add('config');
  if (rel.includes('/output/')) tags.add('asset');
  if (rel.includes('/docs/') || rel.endsWith('.md')) tags.add('documentation');
  if (rel.includes('reporting')) tags.add('reporting');
  if (rel.includes('workOrders') || rel.includes('workorders')) tags.add('workorders');
  if (rel.includes('inventory')) tags.add('inventory');
  if (rel.includes('eBay') || rel.includes('ebay')) tags.add('ebay');
  if (rel.includes('clickup')) tags.add('clickup');
  if (rel.includes('airtable')) tags.add('airtable');
  if (rel.includes('google')) tags.add('google');
  if (rel.includes('phase2')) tags.add('phase2');
  if (rel.includes('phase3')) tags.add('phase3');
  if (rel.includes('phase4')) tags.add('phase4');
  if (rel.includes('phase5')) tags.add('phase5');
  if (rel.includes('phase6')) tags.add('phase6');
  if (rel.includes('phase72')) tags.add('phase72');
  if (rel.includes('phase74')) tags.add('phase74');
  if (rel.includes('main') || rel.includes('preload')) tags.add('bootstrap');
  if (rel.endsWith('.html')) tags.add('ui');

  return [...tags];
}

function layerFor(rel) {
  const p = rel.replace(/\\/g, '/');
  if (p === '.gitignore' || p === 'package-lock.json' || p === 'electron_app/package.json' || p === 'electron_app/package-lock.json' || p === 'electron_app/forge.config.js' || p.startsWith('electron_app/src/main/') || p.startsWith('electron_app/src/preload/') || p.startsWith('electron_app/src/config/') || p.startsWith('electron_app/src/utils/')) {
    return 'layer:bootstrap-and-foundation';
  }
  if (p.startsWith('electron_app/src/services/reporting') || p.startsWith('electron_app/src/services/excel') || p.startsWith('electron_app/src/services/sheets') || p.startsWith('electron_app/src/services/schedule') || p.startsWith('electron_app/src/services/workOrders') || p === 'MILESTONE_11_REPORTING.md') {
    return 'layer:reporting-and-workorders';
  }
  if (p.startsWith('electron_app/src/services/phase2') || p.startsWith('electron_app/src/services/phase3') || p.startsWith('electron_app/src/services/phase4') || p.startsWith('electron_app/src/services/phase5') || p.startsWith('electron_app/src/services/phase6') || p.startsWith('electron_app/src/services/phase72') || p.startsWith('electron_app/src/services/phase74') || p.startsWith('electron_app/src/services/inventory') || p.startsWith('electron_app/src/services/google') || p.startsWith('electron_app/src/services/oauth2') || p.startsWith('electron_app/src/services/clickup') || p.startsWith('electron_app/src/services/airtable') || p.startsWith('electron_app/src/services/masterEbay') || p.startsWith('electron_app/src/services/ebay') || p.startsWith('electron_app/src/services/batchCreation') || p.startsWith('electron_app/src/services/rulesLogic')) {
    return 'layer:inventory-and-marketplace';
  }
  if (p.startsWith('electron_app/src/renderer/')) {
    return 'layer:renderer-ui';
  }
  if (p.startsWith('electron_app/scripts/') || p.startsWith('electron_app/src/scripts/')) {
    return 'layer:scripts-and-tests';
  }
  if (p.endsWith('.md') || p.endsWith('.svg') || p.endsWith('.csv') || p.endsWith('.json') || p === 'electron_app/PHASE2_README.md' || p === 'electron_app/PHASE3_README.md') {
    return 'layer:docs-and-assets';
  }
  return 'layer:docs-and-assets';
}

function displayName(rel) {
  const base = baseName(rel);
  if (base === 'package.json' || base === 'package-lock.json' || base === 'pnpm-workspace.yaml' || base === 'pnpm-lock.yaml' || base === 'tsconfig.json' || base === 'vitest.config.ts' || base === '.gitignore' || base === 'forge.config.js') {
    return base;
  }
  if (rel.endsWith('.md')) {
    const filePath = path.join(root, rel);
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const heading = text.match(/^#\s+(.+)$/m);
      if (heading) return heading[1].replace(/[^\w\s\-–—]/g, '').trim();
    } catch {
      /* ignore */
    }
  }
  return titleCase(stripExt(base));
}

const nodes = [];
const nodeIds = new Set();
const relToNodeId = new Map();

for (const rel of files.sort((a, b) => a.localeCompare(b))) {
  const type = nodeTypeFor(rel);
  const id = nodeIdFor(type, rel);
  const summary = summaryFor(rel);
  const tags = tokensFor(rel);
  const node = {
    id,
    type,
    name: displayName(rel),
    filePath: rel,
    summary,
    tags: tags.length ? tags : [type],
  };
  nodes.push(node);
  nodeIds.add(id);
  relToNodeId.set(rel, id);
}

function resolveRelative(sourceRel, spec) {
  if (!spec || !spec.startsWith('.')) return null;
  const sourceDir = path.posix.dirname(sourceRel);
  const normalized = path.posix.normalize(path.posix.join(sourceDir, spec));
  const candidates = [];
  const push = (candidate) => {
    const clean = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!candidates.includes(clean)) candidates.push(clean);
  };

  push(normalized);
  if (!path.posix.extname(normalized)) {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css']) {
      push(`${normalized}${ext}`);
    }
    for (const ext of ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.html', '.css']) {
      push(path.posix.join(normalized, `index${ext}`));
    }
  }

  for (const candidate of candidates) {
    if (tracked.has(candidate)) return candidate;
  }
  return null;
}

function extractImportSpecs(text, rel) {
  const specs = [];
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      specs.push(match[1]);
    }
  }
  if (rel.endsWith('.html')) {
    let match;
    const htmlPatterns = [
      /<script[^>]+src=["']([^"']+)["']/g,
      /<link[^>]+href=["']([^"']+)["']/g,
    ];
    for (const re of htmlPatterns) {
      while ((match = re.exec(text)) !== null) specs.push(match[1]);
    }
  }
  return specs;
}

const edges = [];
const seenEdges = new Set();

function addEdge(source, target, type, weight = 0.7) {
  const key = `${source}|${target}|${type}`;
  if (seenEdges.has(key)) return;
  seenEdges.add(key);
  edges.push({ source, target, type, weight });
}

for (const rel of files) {
  if (!/\.(js|mjs|cjs|ts|tsx|html)$/i.test(rel)) continue;
  const abs = path.join(root, rel);
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const sourceId = relToNodeId.get(rel);
  if (!sourceId) continue;
  const specs = extractImportSpecs(text, rel);
  for (const spec of specs) {
    const targetRel = resolveRelative(rel, spec);
    if (!targetRel) continue;
    const targetId = relToNodeId.get(targetRel);
    if (!targetId) continue;
    addEdge(sourceId, targetId, 'imports', 0.7);
  }
}

// Documentation links that are useful for orientation.
const docEdges = [
  ['document:MILESTONE_11_REPORTING.md', 'file:electron_app/src/main/index.js'],
  ['document:MILESTONE_11_REPORTING.md', 'service:electron_app/src/services/reportingService.js'],
  ['document:MILESTONE_11_REPORTING.md', 'service:electron_app/src/services/sheetsService.js'],
  ['document:MILESTONE_11_REPORTING.md', 'service:electron_app/src/services/scheduleService.js'],
  ['document:electron_app/PHASE2_README.md', 'service:electron_app/src/services/phase2Service.js'],
  ['document:electron_app/PHASE2_README.md', 'service:electron_app/src/services/phase2ValidationService.js'],
  ['document:electron_app/PHASE2_README.md', 'service:electron_app/src/services/phase2WritebackService.js'],
  ['document:electron_app/PHASE3_README.md', 'service:electron_app/src/services/phase3Service.js'],
  ['document:electron_app/PHASE3_README.md', 'service:electron_app/src/services/phase3ShipstationService.js'],
  ['document:electron_app/PHASE3_README.md', 'service:electron_app/src/services/phase3PowerlinkMappingService.js'],
];

for (const [source, target] of docEdges) {
  if (nodeIds.has(source) && nodeIds.has(target)) addEdge(source, target, 'documents', 0.5);
}

const layers = [
  {
    id: 'layer:bootstrap-and-foundation',
    name: 'Bootstrap and Foundation',
    description: 'Electron startup, shared configuration, utilities, and workspace metadata.',
    nodeIds: [],
  },
  {
    id: 'layer:reporting-and-workorders',
    name: 'Reporting and Work Orders',
    description: 'Reporting exports, Google Sheets sync, scheduling, and work-order flows.',
    nodeIds: [],
  },
  {
    id: 'layer:inventory-and-marketplace',
    name: 'Inventory and Marketplace Automation',
    description: 'Phase 2 through Phase 74 automation, integrations, and publishing workflows.',
    nodeIds: [],
  },
  {
    id: 'layer:renderer-ui',
    name: 'Renderer UI',
    description: 'HTML pages and global styles for the Electron renderer experience.',
    nodeIds: [],
  },
  {
    id: 'layer:scripts-and-tests',
    name: 'Scripts and Tests',
    description: 'Command-line wrappers and manual test harnesses for specific workflows.',
    nodeIds: [],
  },
  {
    id: 'layer:docs-and-assets',
    name: 'Docs and Assets',
    description: 'Markdown guides, sample data, generated assets, and repository output files.',
    nodeIds: [],
  },
];

const layerById = new Map(layers.map(layer => [layer.id, layer]));
for (const node of nodes) {
  const layerId = layerFor(node.filePath);
  const layer = layerById.get(layerId) || layerById.get('layer:docs-and-assets');
  layer.nodeIds.push(node.id);
}

for (const layer of layers) {
  layer.nodeIds.sort((a, b) => a.localeCompare(b));
}

const tour = [
  {
    order: 1,
    title: 'Project Overview',
    description: 'Start with the domain docs and package manifests to understand the app purpose and the Electron runtime.',
    nodeIds: ['document:MILESTONE_11_REPORTING.md', 'config:electron_app/package.json'],
  },
  {
    order: 2,
    title: 'Application Bootstrap',
    description: 'Trace how the Electron main process and preload bridge wire the app together.',
    nodeIds: ['file:electron_app/src/main/index.js', 'file:electron_app/src/preload/preload.js'],
  },
  {
    order: 3,
    title: 'Shared Foundation',
    description: 'Inspect the shared configuration, environment loading, database setup, and utility helpers.',
    nodeIds: [
      'file:electron_app/src/config/loadEnv.js',
      'file:electron_app/src/config/configStore.js',
      'service:electron_app/src/services/db.js',
      'file:electron_app/src/utils/retry.js',
      'file:electron_app/src/utils/chunk.js',
    ],
  },
  {
    order: 4,
    title: 'Reporting Flows',
    description: 'Follow the reporting, Sheets, Excel, and scheduling services that back the reporting UI.',
    nodeIds: [
      'service:electron_app/src/services/reportingService.js',
      'service:electron_app/src/services/excelService.js',
      'service:electron_app/src/services/sheetsService.js',
      'service:electron_app/src/services/scheduleService.js',
      'service:electron_app/src/services/workOrdersGoogleSheetsSync.js',
    ],
  },
  {
    order: 5,
    title: 'Marketplace Automation',
    description: 'Explore the phase-based workflow modules that implement inventory, listing, and publishing automation.',
    nodeIds: [
      'service:electron_app/src/services/phase2Service.js',
      'service:electron_app/src/services/phase3Service.js',
      'service:electron_app/src/services/phase4MirroringService.js',
      'service:electron_app/src/services/phase5Service.js',
      'service:electron_app/src/services/phase6FitmentService.js',
      'service:electron_app/src/services/phase74TitleDescriptionService.js',
    ],
  },
  {
    order: 6,
    title: 'Renderer Experience',
    description: 'Use the renderer pages and stylesheet to understand the user-facing screens.',
    nodeIds: [
      'file:electron_app/src/renderer/pages/main-dashboard.html',
      'file:electron_app/src/renderer/pages/milestone1/index.html',
      'file:electron_app/src/renderer/styles/index.css',
    ],
  },
  {
    order: 7,
    title: 'Assets and Outputs',
    description: 'Review the generated output files and image assets used by the workflows.',
    nodeIds: [
      'resource:electron_app/output/itemSpecificExtracted.json',
      'resource:electron_app/output/fitment-images/166-02246L.svg',
      'resource:electron_app/output/fitment-images/267-00232.svg',
      'resource:electron_app/output/fitment-images/257-52413.svg',
      'resource:electron_app/output/fitment-images/337-60940.svg',
    ],
  },
];

const projectLanguages = ['JavaScript', 'HTML', 'CSS', 'JSON', 'Markdown', 'SVG', 'CSV'];

const projectFrameworks = ['Electron', 'Electron Forge', 'Node.js'];

const projectDescription = 'Electron app for Seymour Auto Reporting and eBay automation workflows.';

const knowledgeGraph = {
  version: '1.0.0',
  project: {
    name: 'electron demo',
    languages: projectLanguages,
    frameworks: projectFrameworks,
    description: projectDescription,
    analyzedAt: new Date().toISOString(),
    gitCommitHash,
  },
  nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
  edges: edges.sort((a, b) => {
    const left = `${a.source}|${a.target}|${a.type}`;
    const right = `${b.source}|${b.target}|${b.type}`;
    return left.localeCompare(right);
  }),
  layers,
  tour: tour.sort((a, b) => a.order - b.order),
};

fs.writeFileSync(outPath, `${JSON.stringify(knowledgeGraph, null, 2)}\n`);
fs.writeFileSync(metaPath, `${JSON.stringify({
  lastAnalyzedAt: knowledgeGraph.project.analyzedAt,
  gitCommitHash,
  version: '1.0.0',
  analyzedFiles: nodes.length,
}, null, 2)}\n`);

console.log(`Wrote ${outPath}`);
console.log(`Nodes: ${nodes.length}, edges: ${edges.length}, layers: ${layers.length}, tour steps: ${tour.length}`);
