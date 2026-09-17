(function initSynonyms(globalScope) {
  function blankForm(priority = 10) {
    return { primaryTerm: '', synonyms: [], condition: 'always', appliesTo: 'all', priority, enabled: true };
  }

  function createSynonymsController(options = {}) {
    const api = options.api || {};
    const confirmDiscard = options.confirmDiscard || (async () => true);
    const confirmDelete = options.confirmDelete || (async () => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      enabled: true, rules: [], policies: {}, issues: [], updatedAt: null,
      form: blankForm(), synonymDraft: '', editingId: null, formRevision: 0, formErrors: {},
      search: '', conditionFilter: 'all', statusFilter: 'all', dirty: false,
      loading: false, saving: false, togglingId: null, togglingMaster: false,
      error: '', success: ''
    };
    const notify = () => onChange(state);
    const sortRules = () => state.rules.sort((a, b) => a.priority - b.priority || String(a.id).localeCompare(String(b.id)));
    function resetForm() {
      state.form = blankForm(Math.max(0, ...state.rules.map(rule => Number(rule.priority) || 0)) + 10);
      state.synonymDraft = '';
      state.editingId = null;
      state.formErrors = {};
      state.dirty = false;
      state.formRevision += 1;
      notify();
    }
    async function load() {
      state.loading = true;
      state.error = '';
      notify();
      try {
        const result = await api.load();
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Synonyms.');
        state.enabled = result.data.enabled === true;
        state.rules = [...(result.data.rules || [])];
        state.policies = result.data.policies || {};
        state.issues = [...(result.data.issues || [])];
        state.updatedAt = result.data.updatedAt || null;
        sortRules();
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
      if (state.saving) return false;
      if (state.dirty && !await confirmDiscard()) return false;
      state.error = '';
      state.success = '';
      resetForm();
      return true;
    }
    async function beginEdit(id) {
      if (state.saving) return false;
      if (state.dirty && !await confirmDiscard()) return false;
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      state.form = {
        primaryTerm: rule.primaryTerm || '', synonyms: [...rule.synonyms],
        condition: rule.condition || 'always', appliesTo: rule.appliesTo || 'all',
        priority: rule.priority, enabled: rule.enabled === true
      };
      state.synonymDraft = '';
      state.editingId = id;
      state.formErrors = {};
      state.dirty = false;
      state.error = '';
      state.success = '';
      state.formRevision += 1;
      notify();
      return true;
    }
    function setFormField(field, value) {
      if (!Object.hasOwn(state.form, field) || field === 'synonyms' || field === 'priority') return;
      state.form[field] = value;
      state.dirty = true;
      state.success = '';
      state.error = '';
      delete state.formErrors[field];
      notify();
    }
    function setSynonymDraft(value) {
      state.synonymDraft = String(value ?? '');
      state.dirty = true;
      state.success = '';
      delete state.formErrors.synonyms;
      notify();
    }
    function addSynonym() {
      const term = state.synonymDraft.trim();
      if (!term) return false;
      if (state.form.synonyms.some(value => value.trim().toLocaleLowerCase() === term.toLocaleLowerCase())) {
        state.formErrors.synonyms = 'This synonym is already in the rule.';
        notify();
        return false;
      }
      state.form.synonyms.push(term);
      state.synonymDraft = '';
      state.dirty = true;
      state.formErrors.synonyms = '';
      notify();
      return true;
    }
    function removeSynonym(index) {
      if (!Number.isInteger(index) || index < 0 || index >= state.form.synonyms.length) return false;
      state.form.synonyms.splice(index, 1);
      state.dirty = true;
      notify();
      return true;
    }
    async function save() {
      if (state.saving) throw new Error('A synonym rule save is already in progress.');
      state.saving = true;
      state.error = '';
      state.formErrors = {};
      notify();
      try {
        const pending = state.synonymDraft.trim();
        const input = {
          ...(state.editingId ? { id: state.editingId } : {}),
          primaryTerm: state.form.primaryTerm,
          synonyms: [...state.form.synonyms, ...(pending ? [pending] : [])],
          condition: state.form.condition, appliesTo: state.form.appliesTo,
          priority: Number(state.form.priority), enabled: Boolean(state.form.enabled)
        };
        const result = await api.save(input);
        if (!result?.success) {
          state.formErrors = Object.fromEntries((result?.error?.details || []).map(item => [item.field, item.message]));
          throw new Error(result?.error?.message || 'Unable to save the synonym rule.');
        }
        const saved = result.data;
        const index = state.rules.findIndex(rule => rule.id === saved.id);
        if (index >= 0) state.rules[index] = saved;
        else state.rules.push(saved);
        sortRules();
        state.updatedAt = saved.updatedAt || state.updatedAt;
        resetForm();
        state.success = 'Synonym rule saved.';
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
    async function toggleRule(id, enabled) {
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
        const result = await api.setRuleEnabled(id, enabled);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to update the rule.');
        state.rules[index] = result.data;
        if (state.editingId === id) state.form.enabled = enabled;
        state.updatedAt = result.data.updatedAt || state.updatedAt;
        state.success = `${result.data.primaryTerm || 'Rule'} ${enabled ? 'enabled' : 'disabled'}.`;
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
    async function toggleMaster(enabled) {
      const previous = state.enabled;
      if (previous === enabled) return true;
      state.enabled = enabled;
      state.togglingMaster = true;
      state.error = '';
      state.success = '';
      notify();
      try {
        const result = await api.setMasterEnabled(enabled);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to update Synonym Enrichment.');
        state.enabled = result.data.enabled === true;
        state.updatedAt = result.data.updatedAt || state.updatedAt;
        state.success = `Synonym Enrichment ${state.enabled ? 'enabled' : 'disabled'}.`;
        notify();
        return true;
      } catch (error) {
        state.enabled = previous;
        state.error = `${error.message} The setting was restored.`;
        notify();
        throw error;
      } finally {
        state.togglingMaster = false;
        notify();
      }
    }
    async function deleteRule(id) {
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      if (rule.origin !== 'custom') {
        state.error = 'This rule cannot be deleted. Disable it instead.';
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
        state.success = `“${rule.primaryTerm}” archived.`;
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
        if (query && !`${rule.primaryTerm || ''} ${(rule.synonyms || []).join(' ')}`.toLocaleLowerCase().includes(query)) return false;
        if (state.conditionFilter !== 'all' && rule.condition !== state.conditionFilter) return false;
        if (state.statusFilter === 'enabled' && !rule.enabled) return false;
        if (state.statusFilter === 'disabled' && rule.enabled) return false;
        return true;
      });
    }
    async function canNavigateAway() {
      if (state.saving) return false;
      if (!state.dirty) return true;
      if (!await confirmDiscard()) return false;
      allowNextUnload = true;
      return true;
    }
    function shouldBlockUnload() {
      if (state.saving) return true;
      if (allowNextUnload) { allowNextUnload = false; return false; }
      return state.dirty;
    }
    async function cancel() {
      if (state.saving) return false;
      if (state.dirty && !await confirmDiscard()) return false;
      resetForm();
      return true;
    }
    async function refresh() {
      if (state.saving) return false;
      if (state.dirty && !await confirmDiscard()) return false;
      await load();
      return true;
    }
    return { state, load, beginAdd, beginEdit, setFormField, setSynonymDraft, addSynonym, removeSynonym, save, toggleRule, toggleMaster, deleteRule, setFilters, filteredRules, canNavigateAway, shouldBlockUnload, cancel, refresh };
  }

  const exported = { createSynonymsController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationSynonyms = exported;
  if (typeof document === 'undefined') return;

  const elements = {};
  let controller;
  let renderedFormRevision = -1;
  const formIds = { primaryTerm: 'primary-term', condition: 'condition', appliesTo: 'applies-to', enabled: 'enabled' };
  const errorIds = { primaryTerm: 'primary-term-error', synonyms: 'synonyms-error', condition: 'condition-error', appliesTo: 'applies-to-error' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  function formatDate(value) {
    if (!value) return 'Not saved yet';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  function render() {
    const state = controller.state;
    elements.loading.hidden = !state.loading;
    elements.error.hidden = !state.error;
    elements.error.textContent = state.error;
    elements.success.hidden = !state.success;
    elements.success.textContent = state.success;
    elements.quarantine.hidden = !state.issues.length;
    elements.quarantine.textContent = state.issues.length ? `Saved synonym entries requiring correction: ${state.issues.map(issue => issue.message).join(' ')}` : '';
    elements.dirty.hidden = !state.dirty;
    elements.updated.textContent = formatDate(state.updatedAt);
    elements.count.textContent = `${controller.filteredRules().length} of ${state.rules.length} rules`;
    elements.master.checked = state.enabled;
    elements.master.disabled = state.togglingMaster || state.loading;
    elements.policy.textContent = state.policies?.cvAxleFrontHalfShaft?.note || 'CV Axle policy is unavailable in the saved configuration.';
    elements.editorHeading.textContent = state.editingId ? 'Edit Synonym Rule' : 'Add Synonym Rule';
    elements.save.disabled = state.saving;
    elements.save.textContent = state.saving ? 'Saving…' : 'Save Rule';
    elements.form.querySelectorAll('input, select, button').forEach(control => { control.disabled = state.saving; });
    document.querySelector('#close-rule').disabled = state.saving;
    elements.rows.innerHTML = controller.filteredRules().map(rule => `<tr data-id="${escapeHtml(rule.id)}">
      <td data-label="Primary Term"><span class="term-name">${escapeHtml(rule.primaryTerm)}</span></td>
      <td data-label="Approved Synonyms"><div class="synonym-chip-list">${(rule.synonyms || []).map(value => `<span class="synonym-chip">${escapeHtml(value)}</span>`).join('')}</div></td>
      <td data-label="Condition">${rule.condition === 'always' ? 'Always' : escapeHtml(rule.condition)}</td>
      <td data-label="Applies To">${rule.appliesTo === 'all' ? 'All Categories' : escapeHtml(rule.appliesTo)}</td>
      <td data-label="Enabled"><input class="enabled-switch" type="checkbox" aria-label="Enable ${escapeHtml(rule.primaryTerm)}" ${rule.enabled ? 'checked' : ''} ${state.togglingId === rule.id ? 'disabled' : ''}></td>
      <td data-label="Actions"><div class="row-actions"><button class="edit-row" type="button" aria-label="Edit ${escapeHtml(rule.primaryTerm)}">Edit</button>${rule.origin === 'custom' ? `<button class="delete-row" type="button" aria-label="Delete ${escapeHtml(rule.primaryTerm)}">Delete</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty-row">No synonym rules match these filters.</td></tr>';
    if (renderedFormRevision !== state.formRevision) {
      Object.entries(formIds).forEach(([field, id]) => {
        const element = document.getElementById(id);
        if (field === 'enabled') element.checked = Boolean(state.form.enabled);
        else element.value = state.form[field] ?? '';
      });
      elements.synonymInput.value = state.synonymDraft;
      renderedFormRevision = state.formRevision;
    }
    elements.chips.innerHTML = state.form.synonyms.map((value, index) => `<span class="synonym-chip">${escapeHtml(value)}<button type="button" data-index="${index}" aria-label="Remove ${escapeHtml(value)}">×</button></span>`).join('');
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
      master: document.querySelector('#master-enabled'), policy: document.querySelector('#cv-policy-note'),
      editorDialog: document.querySelector('#synonym-editor'), editorHeading: document.querySelector('#editor-heading'),
      save: document.querySelector('#save-rule'), form: document.querySelector('#rule-form'),
      formError: document.querySelector('#form-error'), chips: document.querySelector('#synonym-chips'),
      synonymInput: document.querySelector('#synonym-input'),
      discardDialog: document.querySelector('#discard-changes-dialog'), deleteDialog: document.querySelector('#delete-rule-dialog')
    });
    controller = createSynonymsController({
      api: window.titleOptimizationSynonymsAPI,
      confirmDiscard: () => confirmDialog(elements.discardDialog, 'discard'),
      confirmDelete: () => confirmDialog(elements.deleteDialog, 'delete'),
      onChange: render
    });
    const editorDialog = elements.editorDialog;
    const openEditor = () => { editorDialog.showModal(); document.querySelector('#primary-term').focus(); };
    const closeEditor = async () => { if (await controller.cancel()) editorDialog.close(); };
    elements.rows.addEventListener('click', event => {
      const id = event.target.closest('tr[data-id]')?.dataset.id;
      if (!id) return;
      if (event.target.closest('.edit-row')) controller.beginEdit(id).then(changed => { if (changed) openEditor(); });
      if (event.target.closest('.delete-row')) controller.deleteRule(id).catch(() => {});
    });
    elements.rows.addEventListener('change', event => {
      const id = event.target.closest('tr[data-id]')?.dataset.id;
      if (id && event.target.matches('.enabled-switch')) controller.toggleRule(id, event.target.checked).catch(() => {});
    });
    elements.master.addEventListener('change', event => controller.toggleMaster(event.target.checked).catch(() => {}));
    elements.form.addEventListener('input', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
      if (event.target === elements.synonymInput) controller.setSynonymDraft(event.target.value);
    });
    elements.form.addEventListener('change', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.synonymInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (controller.addSynonym()) elements.synonymInput.value = '';
    });
    document.querySelector('#add-synonym').addEventListener('click', () => {
      if (controller.addSynonym()) elements.synonymInput.value = '';
    });
    elements.chips.addEventListener('click', event => {
      const index = Number(event.target.closest('button[data-index]')?.dataset.index);
      if (Number.isInteger(index)) controller.removeSynonym(index);
    });
    elements.form.addEventListener('submit', async event => {
      event.preventDefault();
      try { await controller.save(); editorDialog.close(); } catch { /* Preserve draft and errors. */ }
    });
    document.querySelector('#add-button').addEventListener('click', async () => { if (await controller.beginAdd()) openEditor(); });
    document.querySelector('#cancel-rule').addEventListener('click', () => closeEditor().catch(() => {}));
    document.querySelector('#close-rule').addEventListener('click', () => closeEditor().catch(() => {}));
    editorDialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor().catch(() => {}); });
    document.querySelector('#refresh-button').addEventListener('click', () => controller.refresh().catch(() => {}));
    document.querySelector('#rule-search').addEventListener('input', event => controller.setFilters({ search: event.target.value }));
    document.querySelector('#condition-filter').addEventListener('change', event => controller.setFilters({ condition: event.target.value }));
    document.querySelector('#status-filter').addEventListener('change', event => controller.setFilters({ status: event.target.value }));
    document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', event => { if (controller.shouldBlockUnload()) { event.preventDefault(); event.returnValue = ''; } });
    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
