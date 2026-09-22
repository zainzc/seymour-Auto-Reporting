if (typeof window !== 'undefined' && typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[character]));
  const text = (id, value) => { document.getElementById(id).textContent = value; };
  const display = value => value == null || value === '' ? 'Not available' : String(value);
  const stateBadge = enabled => `<span class="state-badge ${enabled ? 'enabled' : 'disabled'}">${enabled ? 'Enabled' : 'Disabled'}</span>`;
  const emptyState = message => `<p class="table-state">${escapeHtml(message)}</p>`;
  const formatDate = value => {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Not available';
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const renderTable = (targetId, preview, columns, rowTemplate) => {
    const target = document.getElementById(targetId);
    if (!preview?.available) { target.innerHTML = emptyState('Unavailable'); return; }
    if (!preview.rows.length) { target.innerHTML = emptyState('No configured rules available.'); return; }
    target.innerHTML = `<table><thead><tr>${columns.map(column => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${preview.rows.map(rowTemplate).join('')}</tbody></table>${preview.totalCount > preview.rows.length ? `<p class="preview-count">Showing ${preview.rows.length} of ${preview.totalCount}</p>` : ''}`;
  };
  const details = item => {
    if (item?.details == null) return '';
    const value = typeof item.details === 'string' ? item.details : JSON.stringify(item.details);
    return `<pre>${escapeHtml(value)}</pre>`;
  };
  const summaryMarkup = (title, summary, lines) => {
    if (!summary?.available) return `<span><strong>${escapeHtml(title)}</strong><small>Unavailable</small></span><span class="compact-arrow" aria-hidden="true">&rarr;</span>`;
    return `<span><strong>${escapeHtml(title)}</strong><small>${lines.filter(Boolean).map(escapeHtml).join(' &middot; ')}</small></span><span class="compact-arrow" aria-hidden="true">&rarr;</span>`;
  };

  function render(data) {
    text('workspace-health', data.status);
    document.getElementById('workspace-health').dataset.status = data.status.toLowerCase().replaceAll(' ', '-');
    text('rail-health', data.status);
    text('configuration-version', display(data.configurationVersion));
    text('last-updated', formatDate(data.lastUpdated));
    text('maximum-title-length', data.globalProtections.maximumTitleLength == null ? 'Not available' : `${data.globalProtections.maximumTitleLength} characters`);
    text('synonym-enrichment', data.globalProtections.synonymEnrichment == null ? 'Unavailable' : data.globalProtections.synonymEnrichment ? 'Enabled' : 'Disabled');
    text('manual-override-protection', data.globalProtections.manualOverrideProtection ? 'Enabled' : 'Not available');
    text('sku-requirement', display(data.globalProtections.skuRequirement));
    text('active-configuration-items', data.activeConfigurationItems == null ? 'Unavailable' : data.activeConfigurationItems.toLocaleString());
    text('configured-tabs', `${data.configuredTabs} of ${data.totalTabs}`);
    text('configuration-warnings', data.warningCount.toLocaleString());

    renderTable('source-fields-preview', data.previews.sourceFields, ['Logical Field', 'Mapped Source / Airtable Field'], row => `<tr><td><strong>${escapeHtml(row.displayName || row.logicalKey)}</strong></td><td>${escapeHtml(row.sourceFieldName || 'Unmapped')}</td></tr>`);
    renderTable('source-priority-preview', data.previews.sourcePriority, ['Priority', 'Source'], row => `<tr><td>${escapeHtml(row.priority)}</td><td>${escapeHtml(row.label || row.key)}</td></tr>`);
    renderTable('terminology-preview', data.previews.terminologyRules, ['Source Term', 'Replacement Term', 'Condition', 'Status'], row => `<tr><td>${escapeHtml(row.sourceTerm)}</td><td>${escapeHtml(row.replacementTerm || 'Remove')}</td><td>${escapeHtml(row.condition || 'Always')}</td><td>${stateBadge(row.enabled !== false)}</td></tr>`);
    renderTable('synonyms-preview', data.previews.synonyms, ['Primary Term', 'Approved Synonyms', 'Status'], row => `<tr><td>${escapeHtml(row.primaryTerm)}</td><td>${escapeHtml(Array.isArray(row.synonyms) ? row.synonyms.join(', ') : '')}</td><td>${stateBadge(row.enabled !== false)}</td></tr>`);
    renderTable('prefix-preview', data.previews.prefixRules, ['Prefix', 'Approved Terms', 'Status'], row => `<tr><td><strong>${escapeHtml(row.prefix)}</strong></td><td>${escapeHtml(Array.isArray(row.approvedPartTerms) ? row.approvedPartTerms.join(', ') : '')}</td><td>${stateBadge(row.enabled !== false)}</td></tr>`);

    document.getElementById('restricted-summary').innerHTML = summaryMarkup('Restricted Terms', data.summaries.restrictedTerms, [`${data.summaries.restrictedTerms.activeCount} active`, `${data.summaries.restrictedTerms.lockedCount} safety locked`, `${data.summaries.restrictedTerms.warningCount} warnings`]);
    document.getElementById('category-summary').innerHTML = summaryMarkup('Category Rules', data.summaries.categoryRules, [`${data.summaries.categoryRules.activeCount} active`, `${data.summaries.categoryRules.seededCount} required`, `${data.summaries.categoryRules.customCount} custom`]);
    document.getElementById('structure-summary').innerHTML = summaryMarkup('Title Structure', data.summaries.titleStructure, [`${data.summaries.titleStructure.activeCount} active`, data.summaries.titleStructure.names.join(', ')]);
    document.getElementById('flag-summary').innerHTML = summaryMarkup('Flag Reasons', data.summaries.flagReasons, [`${data.summaries.flagReasons.requiredCount} required`, `${data.summaries.flagReasons.customActiveCount} custom enabled`]);
    document.getElementById('system-summary').innerHTML = summaryMarkup('System Rules', data.summaries.systemRules, [`${data.summaries.systemRules.lockedCount} locked`, display(data.summaries.systemRules.version), 'System managed']);

    const unavailable = data.sections.filter(section => !section.available);
    document.getElementById('availability-list').innerHTML = unavailable.length ? `<p><strong>Unavailable:</strong> ${unavailable.map(section => escapeHtml(section.name)).join(', ')}</p>` : '<p class="availability-ok"><span aria-hidden="true">&#10003;</span> All configuration services available</p>';
    document.getElementById('warning-groups').innerHTML = data.warningGroups.length ? data.warningGroups.map(group => `<section class="warning-group"><h3>${escapeHtml(group.section)}</h3>${group.items.map(item => `<article>${item.id ? `<span class="warning-id">${escapeHtml(item.id)}</span>` : ''}<p>${escapeHtml(item.message)}</p>${details(item)}</article>`).join('')}</section>`).join('') : '<p class="positive-state"><span aria-hidden="true">&#10003;</span> No configuration warnings detected.</p>';
    document.getElementById('safety-highlights').innerHTML = data.safetyHighlights.length ? data.safetyHighlights.map(item => `<li><span>${escapeHtml(item.id)}</span><strong>${escapeHtml(item.title)}</strong></li>`).join('') : '<li class="table-state">Unavailable</li>';
  }

  async function load() {
    const notice = document.getElementById('message');
    try {
      const result = await window.titleOptimizationOverviewAPI.load();
      if (!result?.success) throw Error(result?.error?.message || 'Unable to load Overview.');
      render(result.data);
      notice.hidden = true;
    } catch (error) {
      notice.textContent = error.message;
      notice.hidden = false;
    }
  }

  document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => { window.location.href = button.dataset.navigate; }));
  document.getElementById('refresh').addEventListener('click', load);
  load();
});
