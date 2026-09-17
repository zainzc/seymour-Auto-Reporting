(function initTerminologyRules(globalScope) {
  function blankForm(priority = 10) {
    return {
      sourceTerm: '', action: 'replace', replacementTerm: '', condition: 'always',
      verificationCriterion: '', verifiedReplacement: '', otherwiseReplacement: '',
      appliesTo: 'all', priority, enabled: true, note: ''
    };
  }

  function formFromRule(rule) {
    return {
      sourceTerm: rule.sourceTerm || '', action: rule.action || 'replace',
      replacementTerm: rule.replacementTerm || '', condition: rule.condition || 'always',
      verificationCriterion: rule.conditionConfig?.criterion || '',
      verifiedReplacement: rule.conditionConfig?.whenVerified || '',
      otherwiseReplacement: rule.conditionConfig?.otherwise || '',
      appliesTo: rule.appliesTo || 'all', priority: rule.priority,
      enabled: rule.enabled === true, note: rule.note || ''
    };
  }

  function createTerminologyRulesController(options = {}) {
    const api = options.api || {};
    const confirmDiscard = options.confirmDiscard || (async () => true);
    const confirmDelete = options.confirmDelete || (async () => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      rules: [], issues: [], updatedAt: null, updatedBy: null,
      form: blankForm(), editingId: null, formRevision: 0, formErrors: {},
      search: '', conditionFilter: 'all', statusFilter: 'all',
      dirty: false, loading: false, saving: false, togglingId: null,
      error: '', success: ''
    };

    function notify() { onChange(state); }
    function sortRules() { state.rules.sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id))); }
    function resetForm(priority = Math.max(0, ...state.rules.map(rule => Number(rule.priority) || 0)) + 10) {
      state.form = blankForm(priority);
      state.editingId = null;
      state.dirty = false;
      state.formErrors = {};
      state.formRevision += 1;
      notify();
    }

    async function load() {
      state.loading = true;
      state.error = '';
      notify();
      try {
        const result = await api.load();
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Terminology Rules.');
        state.rules = [...(result.data?.rules || [])];
        sortRules();
        state.issues = [...(result.data?.issues || [])];
        state.updatedAt = result.data?.updatedAt || null;
        state.updatedBy = result.data?.updatedBy || null;
        state.success = '';
        resetForm();
        return result.data;
      } catch (error) {
        state.error = error.message;
        notify();
        throw error;
      } finally {
        state.loading = false;
        notify();
      }
    }

    async function beginAdd() {
      if (state.dirty && !await confirmDiscard()) return false;
      state.error = '';
      state.success = '';
      resetForm();
      return true;
    }

    async function beginEdit(id) {
      if (state.dirty && !await confirmDiscard()) return false;
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      state.form = formFromRule(rule);
      state.editingId = id;
      state.dirty = false;
      state.formErrors = {};
      state.error = '';
      state.success = '';
      state.formRevision += 1;
      notify();
      return true;
    }

    function setFormField(field, value) {
      if (!Object.hasOwn(state.form, field)) return;
      state.form[field] = value;
      if (field === 'action' && value === 'remove') state.form.replacementTerm = '';
      if (field === 'condition' && value === 'transmission-context') state.form.appliesTo = 'transmission';
      if (field === 'action' || field === 'condition') state.formRevision += 1;
      state.dirty = true;
      state.success = '';
      state.error = '';
      delete state.formErrors[field];
      notify();
    }

    function payload() {
      const form = state.form;
      return {
        ...(state.editingId ? { id: state.editingId } : {}),
        sourceTerm: form.sourceTerm,
        action: form.action,
        replacementTerm: form.action === 'remove' ? null : form.replacementTerm,
        condition: form.condition,
        conditionConfig: form.condition === 'context-verified' ? {
          criterion: form.verificationCriterion,
          whenVerified: form.verifiedReplacement,
          otherwise: form.otherwiseReplacement || null
        } : null,
        appliesTo: form.appliesTo,
        priority: Number(form.priority),
        enabled: Boolean(form.enabled),
        note: String(form.note || '').trim() || null
      };
    }

    async function save() {
      state.saving = true;
      state.error = '';
      state.formErrors = {};
      notify();
      try {
        const result = await api.save(payload());
        if (!result?.success) {
          state.formErrors = Object.fromEntries((result?.error?.details || []).map(item => [item.field, item.message]));
          throw new Error(result?.error?.message || 'Unable to save the rule.');
        }
        const saved = result.data;
        const index = state.rules.findIndex(rule => rule.id === saved.id);
        if (index >= 0) state.rules[index] = saved;
        else state.rules.push(saved);
        sortRules();
        state.updatedAt = saved.updatedAt || state.updatedAt;
        resetForm();
        state.success = 'Terminology rule saved.';
        notify();
        return saved;
      } catch (error) {
        state.error = error.message;
        state.dirty = true;
        notify();
        throw error;
      } finally {
        state.saving = false;
        notify();
      }
    }

    async function toggle(id, enabled) {
      const index = state.rules.findIndex(rule => rule.id === id);
      if (index < 0) return false;
      const previous = state.rules[index];
      if (previous.enabled === enabled) return true;
      state.togglingId = id;
      state.rules[index] = { ...previous, enabled };
      state.error = '';
      state.success = '';
      notify();
      try {
        const result = await api.setEnabled(id, enabled);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to update the Enabled setting.');
        state.rules[index] = result.data;
        if (state.editingId === id) state.form.enabled = enabled;
        state.updatedAt = result.data.updatedAt || state.updatedAt;
        state.success = `${result.data.sourceTerm || 'Rule'} ${enabled ? 'enabled' : 'disabled'}.`;
        notify();
        return true;
      } catch (error) {
        state.rules[index] = previous;
        state.error = `${error.message} The toggle was restored.`;
        notify();
        throw error;
      } finally {
        state.togglingId = null;
        notify();
      }
    }

    async function deleteRule(id) {
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      if (rule.origin !== 'custom') {
        state.error = 'Client-v5 rules cannot be deleted. Disable the rule instead.';
        notify();
        return false;
      }
      if (!await confirmDelete(rule)) return false;
      if (state.editingId === id && state.dirty && !await confirmDiscard()) return false;
      try {
        const result = await api.softDelete(id);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to delete the rule.');
        state.rules = state.rules.filter(item => item.id !== id);
        if (state.editingId === id) resetForm();
        state.success = `“${rule.sourceTerm}” archived.`;
        state.error = '';
        notify();
        return true;
      } catch (error) {
        state.error = error.message;
        notify();
        throw error;
      }
    }

    function setFilters({ search = state.search, condition = state.conditionFilter, status = state.statusFilter } = {}) {
      state.search = String(search || '');
      state.conditionFilter = condition;
      state.statusFilter = status;
      notify();
    }

    function filteredRules() {
      const query = state.search.trim().toLocaleLowerCase();
      return state.rules.filter(rule => {
        if (query && !`${rule.sourceTerm || ''} ${rule.replacementTerm || ''}`.toLocaleLowerCase().includes(query)) return false;
        if (state.conditionFilter !== 'all' && rule.condition !== state.conditionFilter) return false;
        if (state.statusFilter === 'enabled' && !rule.enabled) return false;
        if (state.statusFilter === 'disabled' && rule.enabled) return false;
        return true;
      });
    }

    async function canNavigateAway() {
      if (!state.dirty) return true;
      if (!await confirmDiscard()) return false;
      allowNextUnload = true;
      return true;
    }

    async function refresh() {
      if (state.dirty && !await confirmDiscard()) return false;
      await load();
      return true;
    }

    async function cancel() {
      if (state.dirty && !await confirmDiscard()) return false;
      resetForm();
      return true;
    }

    function shouldBlockUnload() {
      if (allowNextUnload) { allowNextUnload = false; return false; }
      return state.dirty;
    }

    return { state, load, beginAdd, beginEdit, setFormField, save, toggle, deleteRule, setFilters, filteredRules, canNavigateAway, shouldBlockUnload, refresh, cancel };
  }

  const exported = { createTerminologyRulesController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationTerminologyRules = exported;
  if (typeof document === 'undefined') return;

  const elements = {};
  let controller;
  let renderedFormRevision = -1;
  const formIds = {
    sourceTerm: 'source-term', action: 'action', replacementTerm: 'replacement-term', condition: 'condition',
    verificationCriterion: 'verification-criterion', verifiedReplacement: 'verified-replacement',
    otherwiseReplacement: 'otherwise-replacement', appliesTo: 'applies-to', priority: 'priority', enabled: 'enabled', note: 'note'
  };
  const errorIds = { sourceTerm: 'source-term-error', action: 'action-error', replacementTerm: 'replacement-term-error', condition: 'condition-error', 'conditionConfig.criterion': 'verification-criterion-error', 'conditionConfig.whenVerified': 'verified-replacement-error', appliesTo: 'applies-to-error', priority: 'priority-error' };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function formatDate(value) {
    if (!value) return 'Not saved yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function conditionLabel(value) {
    return { always: 'Always', 'transmission-context': 'Transmission Context Only', 'context-verified': 'Context Verified' }[value] || value;
  }

  function replacementLabel(rule) {
    if (rule.action === 'remove') return '—';
    if (rule.conditionConfig?.otherwise && rule.conditionConfig?.whenVerified) return `${rule.conditionConfig.whenVerified} if verified; otherwise ${rule.conditionConfig.otherwise}`;
    return rule.replacementTerm || '—';
  }

  function render() {
    const state = controller.state;
    elements.loading.hidden = !state.loading;
    elements.error.hidden = !state.error;
    elements.error.textContent = state.error;
    elements.success.hidden = !state.success;
    elements.success.textContent = state.success;
    elements.quarantine.hidden = !state.issues.length;
    elements.quarantine.textContent = state.issues.length ? `Saved rules requiring correction: ${state.issues.map(issue => issue.message).join(' ')}` : '';
    elements.dirty.hidden = !state.dirty;
    elements.updated.textContent = formatDate(state.updatedAt);
    elements.count.textContent = `${controller.filteredRules().length} of ${state.rules.length} rules`;
    elements.editorHeading.textContent = state.editingId ? 'Edit Terminology Rule' : 'Add Terminology Rule';
    elements.save.disabled = state.saving;
    elements.save.textContent = state.saving ? 'Saving…' : 'Save Rule';
    elements.rows.innerHTML = controller.filteredRules().map(rule => `<tr data-id="${escapeHtml(rule.id)}">
      <td data-label="Source Term"><span class="term-name">${escapeHtml(rule.sourceTerm)}</span><span class="origin-label">${rule.origin === 'client-v5' ? 'Client v5 default' : 'Custom rule'}</span></td>
      <td data-label="Action">${rule.action === 'remove' ? 'Remove' : 'Replace'}</td>
      <td data-label="Replacement Term">${escapeHtml(replacementLabel(rule))}</td>
      <td data-label="Condition">${escapeHtml(conditionLabel(rule.condition))}</td>
      <td data-label="Applies To">${rule.appliesTo === 'transmission' ? 'Transmission' : 'All Categories'}</td>
      <td data-label="Enabled"><input class="enabled-switch" type="checkbox" aria-label="Enable ${escapeHtml(rule.sourceTerm)}" ${rule.enabled ? 'checked' : ''} ${state.togglingId === rule.id ? 'disabled' : ''}></td>
      <td data-label="Priority" class="priority-cell">${escapeHtml(rule.priority)}</td>
      <td data-label="Actions"><div class="row-actions"><button class="edit-row" type="button" aria-label="Edit ${escapeHtml(rule.sourceTerm)}">Edit</button>${rule.origin === 'custom' ? `<button class="delete-row" type="button" aria-label="Delete ${escapeHtml(rule.sourceTerm)}">Delete</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty-row">No rules match these filters.</td></tr>';

    if (renderedFormRevision !== state.formRevision) {
      Object.entries(formIds).forEach(([field, id]) => {
        const element = document.getElementById(id);
        if (field === 'enabled') element.checked = Boolean(state.form.enabled);
        else element.value = state.form[field] ?? '';
      });
      renderedFormRevision = state.formRevision;
    }
    elements.replacementGroup.hidden = state.form.action === 'remove';
    elements.verificationGroup.hidden = state.form.condition !== 'context-verified';
    elements.formError.hidden = !state.error || !state.dirty;
    elements.formError.textContent = state.dirty ? state.error : '';
    Object.entries(errorIds).forEach(([field, id]) => {
      const element = document.getElementById(id);
      element.textContent = state.formErrors[field] || '';
      element.hidden = !state.formErrors[field];
    });
  }

  function confirmDialog(dialog, acceptedValue) {
    return new Promise(resolve => {
      dialog.returnValue = 'cancel';
      dialog.addEventListener('close', () => resolve(dialog.returnValue === acceptedValue), { once: true });
      dialog.showModal();
    });
  }

  async function navigate(target) {
    if (!await controller.canNavigateAway()) return;
    requestAnimationFrame(() => { window.location.href = target; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    Object.assign(elements, {
      rows: document.querySelector('#rule-rows'), loading: document.querySelector('#loading-state'),
      error: document.querySelector('#error-message'), success: document.querySelector('#success-message'),
      quarantine: document.querySelector('#quarantine-message'), dirty: document.querySelector('#dirty-state'),
      updated: document.querySelector('#last-updated'), count: document.querySelector('#rule-count'),
      editorHeading: document.querySelector('#editor-heading'), save: document.querySelector('#save-rule'),
      form: document.querySelector('#rule-form'), formError: document.querySelector('#form-error'),
      replacementGroup: document.querySelector('#replacement-group'), verificationGroup: document.querySelector('#verification-group'),
      discardDialog: document.querySelector('#discard-changes-dialog'), deleteDialog: document.querySelector('#delete-rule-dialog')
    });
    controller = createTerminologyRulesController({
      api: window.titleOptimizationTerminologyRulesAPI,
      confirmDiscard: () => confirmDialog(elements.discardDialog, 'discard'),
      confirmDelete: () => confirmDialog(elements.deleteDialog, 'delete'),
      onChange: render
    });
    elements.rows.addEventListener('click', event => {
      const id = event.target.closest('tr[data-id]')?.dataset.id;
      if (!id) return;
      if (event.target.closest('.edit-row')) controller.beginEdit(id).then(changed => { if (changed) document.getElementById('source-term').focus(); });
      if (event.target.closest('.delete-row')) controller.deleteRule(id).catch(() => {});
    });
    elements.rows.addEventListener('change', event => {
      const id = event.target.closest('tr[data-id]')?.dataset.id;
      if (id && event.target.matches('.enabled-switch')) controller.toggle(id, event.target.checked).catch(() => {});
    });
    elements.form.addEventListener('input', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.form.addEventListener('change', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.form.addEventListener('submit', event => { event.preventDefault(); controller.save().catch(() => {}); });
    document.querySelector('#add-button').addEventListener('click', async () => {
      if (await controller.beginAdd()) document.getElementById('source-term').focus();
    });
    document.querySelector('#cancel-rule').addEventListener('click', () => controller.cancel().catch(() => {}));
    document.querySelector('#refresh-button').addEventListener('click', () => controller.refresh().catch(() => {}));
    document.querySelector('#rule-search').addEventListener('input', event => controller.setFilters({ search: event.target.value }));
    document.querySelector('#condition-filter').addEventListener('change', event => controller.setFilters({ condition: event.target.value }));
    document.querySelector('#status-filter').addEventListener('change', event => controller.setFilters({ status: event.target.value }));
    document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', event => { if (controller.shouldBlockUnload()) { event.preventDefault(); event.returnValue = ''; } });
    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
