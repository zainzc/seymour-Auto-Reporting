function createPhase74Runner({ api, onChange = () => {}, confirmFullRun = () => false } = {}) {
  if (!api) throw new Error('Phase 7.4 API is unavailable.');
  const state = { listingsTableName: '', testIpns: '', maxListings: 5, running: false, status: 'idle', progress: 0, stage: '', message: '', summary: null, error: '' };
  let subscribed = false;
  const notify = () => onChange({ ...state });
  const update = changes => { Object.assign(state, changes); notify(); };
  const handleProgress = (_event, payload = {}) => update({
    progress: Number.isFinite(Number(payload.percent)) ? Math.max(0, Math.min(100, Number(payload.percent))) : state.progress,
    stage: payload.stage || state.stage,
    message: payload.message || state.message
  });

  async function load() {
    if (!subscribed && typeof api.onProgress === 'function') { api.onProgress(handleProgress); subscribed = true; }
    const config = await api.getConfig();
    update({
      listingsTableName: config?.listingsTableName || 'eBay Listings (API)',
      testIpns: config?.testIpns || '',
      maxListings: Number.isFinite(Number(config?.maxListings)) ? Number(config.maxListings) : 5
    });
    return config;
  }

  async function run() {
    if (state.running) return null;
    const listingsTableName = String(state.listingsTableName || '').trim();
    const maxListings = Number(state.maxListings);
    if (!listingsTableName) throw new Error('Listings Table Name is required.');
    if (!Number.isInteger(maxListings) || maxListings < 0) throw new Error('Max Listings must be a whole number of 0 or greater.');
    update({ running: true, status: 'running', progress: 0, stage: '', message: 'Starting Phase 7.4...', summary: null, error: '' });
    if (!String(state.testIpns || '').trim() && maxListings === 0 && !(await confirmFullRun())) {
      update({ running: false, status: 'idle', message: 'Run cancelled.' });
      return null;
    }
    try {
      const result = await api.run({ phase74ListingsTable: listingsTableName, phase74TestIpns: String(state.testIpns || '').trim(), phase74MaxListings: maxListings });
      if (!result?.success) throw new Error(result?.error?.message || result?.error || 'Phase 7.4 failed.');
      update({ status: 'completed', progress: 100, message: 'Phase 7.4 completed.', summary: result.summary || {} });
      return result;
    } catch (error) {
      update({ status: 'failed', message: error.message, error: error.message });
      throw error;
    } finally {
      update({ running: false });
    }
  }
  return { state, load, run, update, handleProgress };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createPhase74Runner };

if (typeof window !== 'undefined' && typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  const text = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  const display = value => value == null || value === '' ? 'Not available' : String(value);
  const formatDate = value => !value || !Number.isFinite(Date.parse(value)) ? 'Not available' : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const stateBadge = enabled => `<span class="state-badge ${enabled ? 'enabled' : 'disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>`;
  const emptyState = message => `<p class="table-state">${escapeHtml(message)}</p>`;
  const sectionPages = { sourceFields:'source-fields.html', sourcePriority:'source-priority.html', terminologyRules:'terminology-rules.html', synonyms:'synonyms.html', prefixRules:'prefix-rules.html', restrictedTerms:'restricted-terms.html', categoryRules:'category-rules.html', titleStructure:'title-structure.html', flagReasons:'flag-reasons.html', systemRules:'system-rules.html' };

  const renderTable = (targetId, preview, columns, rowTemplate) => {
    const target = document.getElementById(targetId);
    if (!preview?.available) { target.innerHTML = emptyState('Unavailable'); return; }
    if (!preview.rows?.length) { target.innerHTML = emptyState('No configured rules available.'); return; }
    target.innerHTML = `<table><thead><tr>${columns.map(column => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${preview.rows.map(rowTemplate).join('')}</tbody></table>${preview.totalCount > preview.rows.length ? `<p class="preview-count">Showing ${preview.rows.length} of ${preview.totalCount}</p>` : ''}`;
  };
  function render(data) {
    text('workspace-health', data.status);
    document.getElementById('workspace-health').dataset.status = data.status.toLowerCase().replaceAll(' ', '-');
    text('configuration-version', display(data.configurationVersion));
    text('last-updated', formatDate(data.lastUpdated));
    text('maximum-title-length', data.globalProtections.maximumTitleLength == null ? 'Not available' : `${data.globalProtections.maximumTitleLength} characters`);
    text('synonym-enrichment', data.globalProtections.synonymEnrichment == null ? 'Unavailable' : data.globalProtections.synonymEnrichment ? 'Enabled' : 'Disabled');
    text('manual-override-protection', data.globalProtections.manualOverrideProtection ? 'Enabled' : 'Not available');
    text('sku-requirement', display(data.globalProtections.skuRequirement));
    text('active-configuration-items', data.activeConfigurationItems == null ? 'Unavailable' : data.activeConfigurationItems.toLocaleString());
    text('configured-tabs', `${data.configuredTabs} of ${data.totalTabs}`);
    text('configuration-warnings', data.warningCount.toLocaleString());
    text('system-rule-count', data.systemRuleCount == null ? 'Unavailable' : data.systemRuleCount.toLocaleString());

    document.getElementById('coverage-rows').innerHTML = data.sections.map(section => {
      const page = sectionPages[section.key] || section.path || section.page || '';
      return `<tr><td><strong>${escapeHtml(section.name)}</strong></td><td><span class="availability ${section.available ? 'available' : 'unavailable'}">${section.available ? 'Available' : 'Unavailable'}</span></td><td>${escapeHtml(section.activeCount ?? section.totalCount ?? '—')}</td><td>${escapeHtml(section.warningCount ?? 0)}</td><td><button class="open-button" data-navigate="${escapeHtml(page)}" ${page ? '' : 'disabled'}>Open</button></td></tr>`;
    }).join('');
    document.getElementById('safety-highlights').innerHTML = data.safetyHighlights.length ? data.safetyHighlights.map(item => `<li><span>${escapeHtml(item.id)}</span><strong>${escapeHtml(item.title)}</strong></li>`).join('') : '<li class="table-state">Unavailable</li>';
    renderTable('source-fields-preview', data.previews.sourceFields, ['Logical Field', 'Airtable Field'], row => `<tr><td><strong>${escapeHtml(row.displayName || row.logicalKey)}</strong></td><td>${escapeHtml(row.sourceFieldName || 'Unmapped')}</td></tr>`);
    renderTable('source-priority-preview', data.previews.sourcePriority, ['Priority', 'Source'], row => `<tr><td>${escapeHtml(row.priority)}</td><td>${escapeHtml(row.label || row.key)}</td></tr>`);
    renderTable('terminology-preview', data.previews.terminologyRules, ['Source Term', 'Replacement', 'Status'], row => `<tr><td>${escapeHtml(row.sourceTerm)}</td><td>${escapeHtml(row.replacementTerm || 'Remove')}</td><td>${stateBadge(row.enabled !== false)}</td></tr>`);
  }

  async function loadOverview() {
    const notice = document.getElementById('message');
    try {
      const result = await window.titleOptimizationOverviewAPI.load();
      if (!result?.success) throw Error(result?.error?.message || 'Unable to load Overview.');
      render(result.data); notice.hidden = true;
    } catch (error) { notice.textContent = error.message; notice.hidden = false; }
  }

  const runner = createPhase74Runner({
    api: {
      getConfig: (...args) => window.phase74API.getConfig(...args),
      run: (...args) => window.phase74API.run(...args),
      onProgress: (...args) => window.phase74API.onProgress(...args)
    },
    confirmFullRun: () => window.confirm('This will run Phase 7.4 for every eligible listing and write results to Airtable. Continue?'),
    onChange: state => {
      const button = document.getElementById('run-phase74');
      button.disabled = state.running;
      button.textContent = state.running ? 'Running Playground...' : 'Run Playground';
      document.getElementById('phase74-progress').value = state.progress;
      text('phase74-progress-text', state.message || (state.status === 'idle' ? 'Ready' : state.status));
      text('phase74-status', state.status.charAt(0).toUpperCase() + state.status.slice(1));
      document.getElementById('phase74-status').dataset.status = state.status;
      const summary = document.getElementById('phase74-summary');
      if (state.summary) {
        const labels = { listingsScanned:'Listings scanned', listingsEligible:'Eligible listings', titleGenerated:'Titles generated', descriptionGenerated:'Descriptions generated', skippedManualOverride:'Manual overrides skipped', skippedAlreadyEnriched:'Already enriched skipped', aiFailures:'AI failures', writeFailures:'Write failures' };
        summary.innerHTML = Object.entries(labels).filter(([key]) => state.summary[key] != null).map(([key, label]) => `<div><span>${label}</span><strong>${escapeHtml(state.summary[key])}</strong></div>`).join('');
        summary.hidden = false;
      } else { summary.hidden = true; summary.innerHTML = ''; }
    }
  });

  const tableInput = document.getElementById('phase74-listings-table');
  const ipnInput = document.getElementById('phase74-test-ipns');
  const maxInput = document.getElementById('phase74-max-listings');
  tableInput.addEventListener('input', () => runner.update({ listingsTableName: tableInput.value }));
  ipnInput.addEventListener('input', () => runner.update({ testIpns: ipnInput.value }));
  maxInput.addEventListener('input', () => runner.update({ maxListings: Number(maxInput.value) }));
  document.getElementById('run-phase74').addEventListener('click', async () => {
    try { await runner.run(); } catch (error) { const notice = document.getElementById('message'); notice.textContent = error.message; notice.hidden = false; }
  });
  document.addEventListener('click', event => { const target = event.target.closest('[data-navigate]'); if (target?.dataset.navigate) window.location.href = target.dataset.navigate; });
  loadOverview();
  runner.load().then(() => { tableInput.value = runner.state.listingsTableName; ipnInput.value = runner.state.testIpns; maxInput.value = runner.state.maxListings; }).catch(error => { const notice = document.getElementById('message'); notice.textContent = error.message; notice.hidden = false; });
});
