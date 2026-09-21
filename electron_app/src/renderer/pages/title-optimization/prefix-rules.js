(function initPrefixRules(globalScope) {
  const blankForm = () => ({ prefix: '', approvedPartTerms: [], specialTrigger: '', specialReplacement: '', note: '', enabled: true });

  function createPrefixRulesController(options = {}) {
    const api = options.api || {};
    const confirmDiscard = options.confirmDiscard || (async () => true);
    const confirmDelete = options.confirmDelete || (async () => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      rules: [], issues: [], updatedAt: null, form: blankForm(), termDraft: '',
      editingId: null, prefixLocked: false, formRevision: 0, formErrors: {},
      search: '', statusFilter: 'all', dirty: false, loading: false, saving: false,
      togglingId: null, error: '', success: ''
    };
    const notify = () => onChange(state);
    const sortRules = () => state.rules.sort((a, b) => (a.priority || 0) - (b.priority || 0) || String(a.prefix).localeCompare(String(b.prefix)));
    function resetForm() {
      state.form = blankForm();
      state.termDraft = '';
      state.editingId = null;
      state.prefixLocked = false;
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
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Prefix Rules.');
        state.rules = [...(result.data.rules || [])];
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
        prefix: rule.prefix || '', approvedPartTerms: [...(rule.approvedPartTerms || [])],
        specialTrigger: rule.specialTrigger || '', specialReplacement: rule.specialReplacement || '',
        note: rule.note || '', enabled: rule.enabled === true
      };
      state.termDraft = '';
      state.editingId = id;
      state.prefixLocked = false;
      state.formErrors = {};
      state.dirty = false;
      state.error = '';
      state.success = '';
      state.formRevision += 1;
      notify();
      return true;
    }
    function setFormField(field, value) {
      if (state.saving || !Object.hasOwn(state.form, field) || field === 'approvedPartTerms') return false;
      state.form[field] = value;
      state.dirty = true;
      state.success = '';
      state.error = '';
      delete state.formErrors[field];
      notify();
      return true;
    }
    function setTermDraft(value) {
      if (state.saving) return false;
      state.termDraft = String(value ?? '');
      state.dirty = true;
      state.success = '';
      delete state.formErrors.approvedPartTerms;
      notify();
      return true;
    }
    function addTerm() {
      if (state.saving) return false;
      const term = state.termDraft.trim();
      if (!term) return false;
      if (state.form.approvedPartTerms.some(value => value.trim().toLocaleLowerCase() === term.toLocaleLowerCase())) {
        state.formErrors.approvedPartTerms = 'This term is already in the rule.';
        notify();
        return false;
      }
      state.form.approvedPartTerms.push(term);
      state.termDraft = '';
      state.dirty = true;
      delete state.formErrors.approvedPartTerms;
      notify();
      return true;
    }
    function removeTerm(index) {
      if (state.saving || !Number.isInteger(index) || index < 0 || index >= state.form.approvedPartTerms.length) return false;
      state.form.approvedPartTerms.splice(index, 1);
      state.dirty = true;
      notify();
      return true;
    }
    async function save() {
      if (state.saving) throw new Error('A prefix rule save is already in progress.');
      state.saving = true;
      state.error = '';
      state.formErrors = {};
      notify();
      try {
        const trigger = String(state.form.specialTrigger || '').trim();
        const replacement = String(state.form.specialReplacement || '').trim();
        if (Boolean(trigger) !== Boolean(replacement)) {
          const missingField = trigger ? 'specialReplacement' : 'specialTrigger';
          state.formErrors[missingField] = trigger ? 'Enter a replacement for this trigger.' : 'Enter a trigger for this replacement.';
          throw new Error('Enter both a trigger and a replacement, or leave both blank.');
        }
        const pending = state.termDraft.trim();
        const input = {
          ...(state.editingId ? { id: state.editingId } : {}),
          prefix: state.form.prefix, approvedPartTerms: [...state.form.approvedPartTerms, ...(pending ? [pending] : [])],
          specialTrigger: trigger || null, specialReplacement: replacement || null,
          note: String(state.form.note || '').trim() || null, enabled: Boolean(state.form.enabled)
        };
        const result = await api.save(input);
        if (!result?.success) {
          state.formErrors = Object.fromEntries((result?.error?.details || []).map(item => [item.field, item.message]));
          throw new Error(result?.error?.message || 'Unable to save the prefix rule.');
        }
        const saved = result.data;
        const index = state.rules.findIndex(rule => rule.id === saved.id);
        if (index >= 0) state.rules[index] = saved;
        else state.rules.push(saved);
        sortRules();
        state.updatedAt = saved.updatedAt || state.updatedAt;
        resetForm();
        state.success = 'Prefix rule saved.';
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
        state.success = `Prefix ${result.data.prefix || previous.prefix} ${enabled ? 'enabled' : 'disabled'}.`;
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
        state.success = `Prefix ${rule.prefix} archived.`;
        state.error = '';
        notify();
        return true;
      } catch (error) {
        state.error = error.message;
        notify();
        throw error;
      }
    }
    function setFilters({ search = state.search, status = state.statusFilter } = {}) {
      state.search = String(search || '');
      state.statusFilter = status;
      notify();
    }
    function filteredRules() {
      const query = state.search.trim().toLocaleLowerCase();
      return state.rules.filter(rule => {
        if (query && !`${rule.prefix || ''} ${(rule.approvedPartTerms || []).join(' ')} ${rule.specialTrigger || ''} ${rule.specialReplacement || ''}`.toLocaleLowerCase().includes(query)) return false;
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
    return { state, load, beginAdd, beginEdit, setFormField, setTermDraft, addTerm, removeTerm, save, toggleRule, deleteRule, setFilters, filteredRules, canNavigateAway, shouldBlockUnload, cancel, refresh };
  }

  const exported = { createPrefixRulesController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationPrefixRules = exported;
  if (typeof document === 'undefined') return;

  const elements = {};
  let controller;
  let renderedFormRevision = -1;
  const formIds = { prefix: 'prefix', specialTrigger: 'special-trigger', specialReplacement: 'special-replacement', note: 'note', enabled: 'enabled' };
  const errorIds = { prefix: 'prefix-error', approvedPartTerms: 'approvedPartTerms-error', specialTrigger: 'specialTrigger-error', specialReplacement: 'specialReplacement-error', note: 'note-error' };
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
    elements.quarantine.textContent = state.issues.length ? `Saved prefix entries requiring correction: ${state.issues.map(issue => issue.message).join(' ')}` : '';
    elements.dirty.hidden = !state.dirty;
    elements.updated.textContent = formatDate(state.updatedAt);
    elements.count.textContent = `${controller.filteredRules().length} of ${state.rules.length} rules`;
    elements.editorHeading.textContent = state.editingId ? 'Edit Prefix Rule' : 'Add Prefix Rule';
    elements.save.disabled = state.saving;
    elements.save.textContent = state.saving ? 'Saving…' : 'Save Rule';
    elements.form.querySelectorAll('input, textarea, button').forEach(control => { control.disabled = state.saving; });
    document.querySelector('#close-rule').disabled = state.saving;
    elements.prefix.readOnly = state.prefixLocked;
    elements.prefix.setAttribute('aria-readonly', String(state.prefixLocked));
    elements.rows.innerHTML = controller.filteredRules().map(rule => `<tr data-id="${escapeHtml(rule.id)}">
      <td data-label="Prefix"><span class="term-name">${escapeHtml(rule.prefix)}</span></td>
      <td data-label="Approved Part Terms"><div class="term-chip-list">${(rule.approvedPartTerms || []).map(value => `<span class="term-chip">${escapeHtml(value)}</span>`).join('')}</div></td>
      <td data-label="Special Rule / Note"><div class="prefix-rule-detail">${rule.specialTrigger ? `<span>${escapeHtml(rule.specialTrigger)} → ${escapeHtml(rule.specialReplacement)}</span>` : '<span>—</span>'}${rule.note ? `<small>${escapeHtml(rule.note)}</small>` : ''}</div></td>
      <td data-label="Enabled"><input class="enabled-switch" type="checkbox" aria-label="Enable prefix ${escapeHtml(rule.prefix)}" ${rule.enabled ? 'checked' : ''} ${state.togglingId === rule.id ? 'disabled' : ''}></td>
      <td data-label="Actions"><div class="row-actions"><button class="edit-row" type="button" aria-label="Edit prefix ${escapeHtml(rule.prefix)}">Edit</button>${rule.origin === 'custom' ? `<button class="delete-row" type="button" aria-label="Delete prefix ${escapeHtml(rule.prefix)}">Delete</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-row">No prefix rules match these filters.</td></tr>';
    if (renderedFormRevision !== state.formRevision) {
      Object.entries(formIds).forEach(([field, id]) => {
        const element = document.getElementById(id);
        if (field === 'enabled') element.checked = Boolean(state.form.enabled);
        else element.value = state.form[field] ?? '';
      });
      elements.termInput.value = state.termDraft;
      renderedFormRevision = state.formRevision;
    }
    elements.chips.innerHTML = state.form.approvedPartTerms.map((value, index) => `<span class="term-chip">${escapeHtml(value)}<button type="button" data-index="${index}" aria-label="Remove ${escapeHtml(value)}">×</button></span>`).join('');
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
      editorDialog: document.querySelector('#prefix-editor'), editorHeading: document.querySelector('#editor-heading'),
      save: document.querySelector('#save-rule'), form: document.querySelector('#rule-form'),
      formError: document.querySelector('#form-error'), chips: document.querySelector('#approved-term-chips'),
      termInput: document.querySelector('#approved-term-input'), prefix: document.querySelector('#prefix'),
      discardDialog: document.querySelector('#discard-changes-dialog'), deleteDialog: document.querySelector('#delete-rule-dialog')
    });
    controller = createPrefixRulesController({
      api: window.titleOptimizationPrefixRulesAPI,
      confirmDiscard: () => confirmDialog(elements.discardDialog, 'discard'),
      confirmDelete: () => confirmDialog(elements.deleteDialog, 'delete'),
      onChange: render
    });
    const editorDialog = elements.editorDialog;
    const openEditor = () => { editorDialog.showModal(); elements.prefix.focus(); };
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
    elements.form.addEventListener('input', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
      if (event.target === elements.termInput) controller.setTermDraft(event.target.value);
    });
    elements.form.addEventListener('change', event => {
      const field = Object.keys(formIds).find(key => formIds[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.termInput.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (controller.addTerm()) elements.termInput.value = '';
    });
    document.querySelector('#add-term').addEventListener('click', () => { if (controller.addTerm()) elements.termInput.value = ''; });
    elements.chips.addEventListener('click', event => {
      const button = event.target.closest('button[data-index]');
      if (button) controller.removeTerm(Number(button.dataset.index));
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
    document.querySelector('#status-filter').addEventListener('change', event => controller.setFilters({ status: event.target.value }));
    document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', event => { if (controller.shouldBlockUnload()) { event.preventDefault(); event.returnValue = ''; } });
    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
