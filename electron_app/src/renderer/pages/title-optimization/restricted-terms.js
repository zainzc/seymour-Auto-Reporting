(function initRestrictedTerms(globalScope) {
  const blankForm = () => ({ term: '', ruleType: 'never-introduce', scope: 'all', note: '', enabled: true });
  const labels = { 'never-introduce': 'Never Introduce', 'remove-noise': 'Remove as Noise', 'requires-authorization': 'Requires Authorization', 'must-preserve': 'Protected / Must Preserve' };

  function createRestrictedTermsController(options = {}) {
    const api = options.api || {};
    const confirmDiscard = options.confirmDiscard || (async () => true);
    const confirmDelete = options.confirmDelete || (async () => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      rules: [], issues: [], updatedAt: null, form: blankForm(), formErrors: {}, formRevision: 0,
      editingId: null, identityLocked: false, safetyLocked: false, dirty: false,
      search: '', typeFilter: 'all', scopeFilter: 'all', statusFilter: 'all', loading: false, saving: false,
      togglingId: null, error: '', success: ''
    };
    const notify = () => onChange(state);
    const sortRules = () => state.rules.sort((a, b) => String(a.term).localeCompare(String(b.term)) || String(a.id).localeCompare(String(b.id)));
    function resetForm() {
      state.form = blankForm(); state.formErrors = {}; state.editingId = null;
      state.identityLocked = false; state.safetyLocked = false; state.dirty = false;
      state.formRevision += 1; notify();
    }
    async function load() {
      state.loading = true; state.error = ''; notify();
      try {
        const result = await api.load();
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Restricted Terms.');
        state.rules = [...(result.data.rules || [])]; state.issues = [...(result.data.issues || [])];
        state.updatedAt = result.data.updatedAt || null; sortRules(); resetForm();
        return result.data;
      } catch (error) { state.error = error.message; notify(); throw error; }
      finally { state.loading = false; notify(); }
    }
    async function beginAdd() {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      state.error = ''; state.success = ''; resetForm(); return true;
    }
    async function beginEdit(id) {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      state.form = { term: rule.term, ruleType: rule.ruleType, scope: rule.scope, note: rule.note || '', enabled: rule.enabled === true };
      state.editingId = id; state.identityLocked = rule.origin === 'client-v5'; state.safetyLocked = rule.locked === true;
      state.formErrors = {}; state.dirty = false; state.error = ''; state.success = ''; state.formRevision += 1; notify();
      return true;
    }
    function setFormField(field, value) {
      if (state.saving || !Object.hasOwn(state.form, field)) return false;
      if (state.identityLocked && ['term', 'ruleType', 'scope'].includes(field)) return false;
      if (state.safetyLocked && field === 'enabled') return false;
      state.form[field] = value; state.dirty = true; state.error = ''; state.success = '';
      delete state.formErrors[field]; notify(); return true;
    }
    async function save() {
      if (state.saving) throw new Error('A restricted term save is already in progress.');
      state.saving = true; state.error = ''; state.formErrors = {}; notify();
      try {
        const input = { ...(state.editingId ? { id: state.editingId } : {}), ...state.form,
          term: String(state.form.term || '').trim(), note: String(state.form.note || '').trim() || null,
          enabled: state.safetyLocked ? true : Boolean(state.form.enabled) };
        if (!input.term) { state.formErrors.term = 'Enter a term.'; throw new Error('Enter a term before saving.'); }
        const result = await api.save(input);
        if (!result?.success) {
          state.formErrors = Object.fromEntries((result?.error?.details || []).filter(item => item?.field).map(item => [item.field, item.message]));
          throw new Error(result?.error?.message || 'Unable to save the restricted term.');
        }
        const saved = result.data; const index = state.rules.findIndex(item => item.id === saved.id);
        if (index < 0) state.rules.push(saved); else state.rules[index] = saved;
        sortRules(); state.updatedAt = saved.updatedAt || state.updatedAt; resetForm();
        state.success = 'Restricted term saved.'; notify(); return saved;
      } catch (error) { state.error = error.message; state.dirty = true; notify(); throw error; }
      finally { state.saving = false; notify(); }
    }
    async function toggleRule(id, enabled) {
      const index = state.rules.findIndex(item => item.id === id);
      if (index < 0) return false;
      const previous = state.rules[index];
      if (previous.locked) return false;
      if (previous.enabled === enabled) return true;
      state.togglingId = id; state.rules[index] = { ...previous, enabled }; state.error = ''; state.success = ''; notify();
      try {
        const result = await api.setRuleEnabled(id, enabled);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to update the rule.');
        state.rules[index] = result.data; if (state.editingId === id && !state.dirty) state.form.enabled = enabled;
        state.updatedAt = result.data.updatedAt || state.updatedAt;
        state.success = `${result.data.term || previous.term} ${enabled ? 'enabled' : 'disabled'}.`; notify(); return true;
      } catch (error) { state.rules[index] = previous; state.error = `${error.message} The toggle was restored.`; notify(); throw error; }
      finally { state.togglingId = null; notify(); }
    }
    async function deleteRule(id) {
      const rule = state.rules.find(item => item.id === id);
      if (!rule) return false;
      if (rule.origin !== 'custom') { state.error = 'Client-v5 terms cannot be deleted.'; notify(); return false; }
      if (!await confirmDelete(rule)) return false;
      if (state.editingId === id && state.dirty && !await confirmDiscard()) return false;
      try {
        const result = await api.softDelete(id);
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to delete the rule.');
        state.rules = state.rules.filter(item => item.id !== id);
        if (state.editingId === id) resetForm();
        state.success = `${rule.term} archived.`; state.error = ''; notify(); return true;
      } catch (error) { state.error = error.message; notify(); throw error; }
    }
    function setFilters({ search = state.search, type = state.typeFilter, scope = state.scopeFilter, status = state.statusFilter } = {}) {
      state.search = String(search || ''); state.typeFilter = type; state.scopeFilter = scope; state.statusFilter = status; notify();
    }
    function filteredRules() {
      const query = state.search.trim().toLocaleLowerCase();
      return state.rules.filter(rule => {
        if (query && !`${rule.term || ''} ${rule.note || ''}`.toLocaleLowerCase().includes(query)) return false;
        if (state.typeFilter !== 'all' && rule.ruleType !== state.typeFilter) return false;
        if (state.scopeFilter !== 'all' && rule.scope !== (state.scopeFilter === 'all-categories' ? 'all' : state.scopeFilter)) return false;
        if (state.statusFilter === 'enabled' && !rule.enabled) return false;
        if (state.statusFilter === 'disabled' && rule.enabled) return false;
        return true;
      });
    }
    async function canNavigateAway() {
      if (state.saving) return false;
      if (!state.dirty) return true;
      if (!await confirmDiscard()) return false;
      allowNextUnload = true; return true;
    }
    function shouldBlockUnload() {
      if (state.saving) return true;
      if (allowNextUnload) { allowNextUnload = false; return false; }
      return state.dirty;
    }
    async function cancel() {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      resetForm(); return true;
    }
    async function refresh() {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      await load(); return true;
    }
    return { state, load, beginAdd, beginEdit, setFormField, save, toggleRule, deleteRule, setFilters, filteredRules, canNavigateAway, shouldBlockUnload, cancel, refresh };
  }

  const exported = { createRestrictedTermsController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationRestrictedTerms = exported;
  if (typeof document === 'undefined') return;

  const elements = {}; let controller; let renderedFormRevision = -1;
  const fields = { term: 'term', ruleType: 'rule-type', scope: 'scope', note: 'note', enabled: 'enabled' };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const formatDate = value => { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Not saved yet'; };
  function render() {
    const state = controller.state;
    elements.loading.hidden = !state.loading;
    elements.error.hidden = !state.error; elements.error.textContent = state.error;
    elements.success.hidden = !state.success; elements.success.textContent = state.success;
    elements.quarantine.hidden = !state.issues.length;
    elements.quarantine.textContent = state.issues.length ? `Saved configuration needs correction: ${state.issues.map(issue => issue.message).join(' ')}` : '';
    elements.dirty.hidden = !state.dirty; elements.updated.textContent = formatDate(state.updatedAt);
    elements.count.textContent = `${controller.filteredRules().length} of ${state.rules.length} rules`;
    elements.heading.textContent = state.editingId ? 'Edit Restricted Term' : 'Add Restricted Term';
    elements.save.disabled = state.saving; elements.save.textContent = state.saving ? 'Saving…' : 'Save Rule';
    elements.form.querySelectorAll('input, select, textarea').forEach(control => { control.disabled = state.saving; });
    elements.form.querySelector('#term').readOnly = state.identityLocked;
    elements.form.querySelector('#rule-type').disabled = state.saving || state.identityLocked;
    elements.form.querySelector('#scope').disabled = state.saving || state.identityLocked;
    elements.form.querySelector('#enabled').disabled = state.saving || state.safetyLocked;
    elements.lockedHelp.hidden = !state.safetyLocked;
    elements.rows.innerHTML = controller.filteredRules().map(rule => `<tr data-id="${escapeHtml(rule.id)}">
      <td data-label="Term"><span class="term-name">${escapeHtml(rule.term)}</span></td>
      <td data-label="Rule Type"><span class="rule-badge ${escapeHtml(rule.ruleType)}">${escapeHtml(labels[rule.ruleType] || rule.ruleType)}</span></td>
      <td data-label="Scope">${rule.scope === 'engine' ? 'Engine Only' : 'All Categories'}</td>
      <td data-label="Notes" class="note-cell">${escapeHtml(rule.note || '—')}</td>
      <td data-label="Enabled">${rule.locked ? '<span class="locked-label">Locked on</span>' : `<input class="enabled-switch" type="checkbox" aria-label="Enable ${escapeHtml(rule.term)}" ${rule.enabled ? 'checked' : ''} ${state.togglingId === rule.id ? 'disabled' : ''}>`}</td>
      <td data-label="Actions"><div class="row-actions"><button class="edit-row" type="button" aria-label="Edit ${escapeHtml(rule.term)}">Edit</button>${rule.origin === 'custom' ? `<button class="delete-row" type="button" aria-label="Delete ${escapeHtml(rule.term)}">Delete</button>` : ''}</div></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty-row">No restricted terms match these filters.</td></tr>';
    if (renderedFormRevision !== state.formRevision) {
      Object.entries(fields).forEach(([field, id]) => {
        const control = document.getElementById(id);
        if (field === 'enabled') control.checked = Boolean(state.form.enabled);
        else control.value = state.form[field] ?? '';
      });
      renderedFormRevision = state.formRevision;
    }
    elements.formError.hidden = !state.error || !state.dirty; elements.formError.textContent = state.dirty ? state.error : '';
    for (const field of ['term', 'ruleType', 'scope', 'note']) {
      const target = document.getElementById(`${field}-error`);
      target.textContent = state.formErrors[field] || ''; target.hidden = !state.formErrors[field];
    }
  }
  function confirmDialog(dialog, acceptedValue) {
    return new Promise(resolve => {
      dialog.returnValue = 'cancel'; dialog.addEventListener('close', () => resolve(dialog.returnValue === acceptedValue), { once: true }); dialog.showModal();
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
      editor: document.querySelector('#restricted-editor'), heading: document.querySelector('#editor-heading'),
      form: document.querySelector('#rule-form'), formError: document.querySelector('#form-error'),
      save: document.querySelector('#save-rule'), lockedHelp: document.querySelector('#locked-help'),
      discard: document.querySelector('#discard-changes-dialog'), deletion: document.querySelector('#delete-rule-dialog')
    });
    controller = createRestrictedTermsController({
      api: window.titleOptimizationRestrictedTermsAPI,
      confirmDiscard: () => confirmDialog(elements.discard, 'discard'),
      confirmDelete: () => confirmDialog(elements.deletion, 'delete'), onChange: render
    });
    const openEditor = () => { elements.editor.showModal(); document.querySelector('#term').focus(); };
    const closeEditor = async () => { if (await controller.cancel()) elements.editor.close(); };
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
      const field = Object.keys(fields).find(key => fields[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.form.addEventListener('change', event => {
      const field = Object.keys(fields).find(key => fields[key] === event.target.id);
      if (field) controller.setFormField(field, field === 'enabled' ? event.target.checked : event.target.value);
    });
    elements.form.addEventListener('submit', async event => {
      event.preventDefault(); try { await controller.save(); elements.editor.close(); } catch { /* Retain draft and error. */ }
    });
    document.querySelector('#add-button').addEventListener('click', async () => { if (await controller.beginAdd()) openEditor(); });
    document.querySelector('#cancel-rule').addEventListener('click', () => closeEditor().catch(() => {}));
    document.querySelector('#close-rule').addEventListener('click', () => closeEditor().catch(() => {}));
    elements.editor.addEventListener('cancel', event => { event.preventDefault(); closeEditor().catch(() => {}); });
    document.querySelector('#refresh-button').addEventListener('click', () => controller.refresh().catch(() => {}));
    document.querySelector('#rule-search').addEventListener('input', event => controller.setFilters({ search: event.target.value }));
    document.querySelector('#type-filter').addEventListener('change', event => controller.setFilters({ type: event.target.value }));
    document.querySelector('#scope-filter').addEventListener('change', event => controller.setFilters({ scope: event.target.value }));
    document.querySelector('#status-filter').addEventListener('change', event => controller.setFilters({ status: event.target.value }));
    document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', event => { if (controller.shouldBlockUnload()) { event.preventDefault(); event.returnValue = ''; } });
    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
