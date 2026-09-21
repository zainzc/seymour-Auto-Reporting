(function initCategoryRules(globalScope) {
  const blankForm = () => ({ categoryName: '', prefixRefs: [], seriesRefs: [], priorityDetails: [], note: '', enabled: true });
  const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

  function createCategoryRulesController(options = {}) {
    const api = options.api || {}, confirmDiscard = options.confirmDiscard || (async () => true), confirmDelete = options.confirmDelete || (async () => true), onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      rules: [], issues: [], updatedAt: null, form: blankForm(), chipDrafts: { prefixRefs: '', seriesRefs: '', priorityDetails: '' }, formErrors: {}, formRevision: 0,
      editingId: null, identityLocked: false, dirty: false, loading: false, saving: false, togglingId: null,
      search: '', statusFilter: 'all', referenceFilter: 'all', error: '', success: ''
    };
    const notify = () => onChange(state);
    const sortRules = () => state.rules.sort((a, b) => {
      const aSeed = a.origin === 'client-v5', bSeed = b.origin === 'client-v5';
      if (aSeed !== bSeed) return aSeed ? -1 : 1;
      if (aSeed) return (a.seedOrder || 0) - (b.seedOrder || 0) || String(a.id).localeCompare(String(b.id));
      return normalize(a.categoryName).localeCompare(normalize(b.categoryName)) || String(a.id).localeCompare(String(b.id));
    });
    function resetForm() { state.form = blankForm(); state.chipDrafts = { prefixRefs: '', seriesRefs: '', priorityDetails: '' }; state.formErrors = {}; state.editingId = null; state.identityLocked = false; state.dirty = false; state.formRevision++; notify(); }
    async function load() {
      state.loading = true; state.error = ''; notify();
      try {
        const result = await api.load(); if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Category Rules.');
        state.rules = [...(result.data.rules || [])]; sortRules(); state.issues = [...(result.data.issues || [])]; state.updatedAt = result.data.updatedAt || null; resetForm(); return result.data;
      } catch (error) { state.error = error.message; notify(); throw error; }
      finally { state.loading = false; notify(); }
    }
    async function beginAdd() {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      state.error = ''; state.success = ''; resetForm(); return true;
    }
    async function beginEdit(id) {
      if (state.saving || (state.dirty && !await confirmDiscard())) return false;
      const rule = state.rules.find(item => item.id === id); if (!rule) return false;
      state.form = { categoryName: rule.categoryName, prefixRefs: [...rule.prefixRefs], seriesRefs: [...rule.seriesRefs], priorityDetails: [...rule.priorityDetails], note: rule.note || '', enabled: rule.enabled === true };
      state.chipDrafts = { prefixRefs: '', seriesRefs: '', priorityDetails: '' };
      state.editingId = id; state.identityLocked = rule.origin === 'client-v5'; state.formErrors = {}; state.dirty = false; state.error = ''; state.success = ''; state.formRevision++; notify(); return true;
    }
    function setFormField(field, value) {
      if (state.saving || !Object.hasOwn(state.form, field) || Array.isArray(state.form[field]) || (state.identityLocked && field === 'categoryName')) return false;
      state.form[field] = value; state.dirty = true; state.error = ''; state.success = ''; delete state.formErrors[field]; notify(); return true;
    }
    function addChip(field, value) {
      if (state.saving || !['prefixRefs', 'seriesRefs', 'priorityDetails'].includes(field) || (state.identityLocked && ['prefixRefs', 'seriesRefs'].includes(field))) return false;
      const display = String(value ?? '').trim();
      if (!display) { state.formErrors[field] = 'Blank values are not allowed.'; notify(); return false; }
      if (state.form[field].some(entry => normalize(entry) === normalize(display))) { state.formErrors[field] = 'This value is already in the list.'; notify(); return false; }
      state.form[field].push(display); state.dirty = true; delete state.formErrors[field]; state.success = ''; notify(); return true;
    }
    function setChipDraft(field, value) {
      if (state.saving || !Object.hasOwn(state.chipDrafts, field) || (state.identityLocked && ['prefixRefs', 'seriesRefs'].includes(field))) return false;
      state.chipDrafts[field] = String(value ?? ''); state.dirty = true; state.success = ''; delete state.formErrors[field]; notify(); return true;
    }
    function removeChip(field, index) {
      if (state.saving || !['prefixRefs', 'seriesRefs', 'priorityDetails'].includes(field) || (state.identityLocked && ['prefixRefs', 'seriesRefs'].includes(field)) || !Number.isInteger(index) || index < 0 || index >= state.form[field].length) return false;
      state.form[field].splice(index, 1); state.dirty = true; notify(); return true;
    }
    function moveDetail(index, delta) {
      const target = index + delta;
      if (state.saving || !Number.isInteger(index) || ![-1, 1].includes(delta) || index < 0 || target < 0 || target >= state.form.priorityDetails.length) return false;
      [state.form.priorityDetails[index], state.form.priorityDetails[target]] = [state.form.priorityDetails[target], state.form.priorityDetails[index]];
      state.dirty = true; notify(); return true;
    }
    async function save() {
      if (state.saving) throw new Error('A Category Rule save is already in progress.');
      state.saving = true; state.error = ''; state.formErrors = {}; notify();
      try {
        const existing = state.rules.find(item => item.id === state.editingId);
        const lists = {};
        for (const field of ['prefixRefs', 'seriesRefs', 'priorityDetails']) {
          lists[field] = [...state.form[field]];
          const pending = state.chipDrafts[field].trim();
          if (pending) {
            if (lists[field].some(value => normalize(value) === normalize(pending))) { state.formErrors[field] = 'This value is already in the list.'; throw new Error('Remove duplicate list values before saving.'); }
            lists[field].push(pending);
          }
        }
        const input = { ...(state.editingId ? { id: state.editingId } : {}), ...state.form,
          categoryName: String(state.form.categoryName || '').trim(), prefixRefs: lists.prefixRefs, seriesRefs: lists.seriesRefs, priorityDetails: lists.priorityDetails,
          note: state.form.note === '' ? null : state.form.note, enabled: Boolean(state.form.enabled), ...(existing ? { seedOrder: existing.seedOrder } : {}) };
        if (!input.categoryName) { state.formErrors.categoryName = 'Enter a Category Name.'; throw new Error('Enter a Category Name before saving.'); }
        if (!input.priorityDetails.length) { state.formErrors.priorityDetails = 'Add at least one important verified detail.'; throw new Error('Add at least one important verified detail before saving.'); }
        const result = await api.save(input);
        if (!result?.success) { state.formErrors = Object.fromEntries((result?.error?.details || []).filter(item => item?.field).map(item => [item.field, item.message])); throw new Error(result?.error?.message || 'Unable to save the Category Rule.'); }
        const saved = result.data, index = state.rules.findIndex(item => item.id === saved.id);
        if (index < 0) state.rules.push(saved); else state.rules[index] = saved;
        sortRules();
        state.updatedAt = saved.updatedAt || state.updatedAt; resetForm(); state.success = 'Category Rule saved.'; notify(); return saved;
      } catch (error) { state.error = error.message; state.dirty = true; notify(); throw error; }
      finally { state.saving = false; notify(); }
    }
    async function toggleRule(id, enabled) {
      const index = state.rules.findIndex(item => item.id === id); if (index < 0) return false;
      const previous = state.rules[index]; if (previous.enabled === enabled) return true;
      state.togglingId = id; state.rules[index] = { ...previous, enabled }; state.error = ''; state.success = ''; notify();
      try {
        const result = await api.setRuleEnabled(id, enabled); if (!result?.success) throw new Error(result?.error?.message || 'Unable to update the rule.');
        const currentIndex = state.rules.findIndex(item => item.id === id);
        if (currentIndex >= 0) state.rules[currentIndex] = result.data;
        state.updatedAt = result.data.updatedAt || state.updatedAt; state.success = `${result.data.categoryName || previous.categoryName} ${enabled ? 'enabled' : 'disabled'}.`; notify(); return true;
      } catch (error) {
        const currentIndex = state.rules.findIndex(item => item.id === id);
        if (currentIndex >= 0) state.rules[currentIndex] = previous;
        state.error = `${error.message} The toggle was restored.`; notify(); throw error;
      }
      finally { state.togglingId = null; notify(); }
    }
    async function deleteRule(id) {
      const rule = state.rules.find(item => item.id === id); if (!rule) return false;
      if (rule.origin !== 'custom') { state.error = 'Client-v5 category rules cannot be deleted.'; notify(); return false; }
      if (!await confirmDelete(rule) || (state.editingId === id && state.dirty && !await confirmDiscard())) return false;
      try {
        const result = await api.softDelete(id); if (!result?.success) throw new Error(result?.error?.message || 'Unable to delete the rule.');
        state.rules = state.rules.filter(item => item.id !== id); if (state.editingId === id) resetForm(); state.success = `${rule.categoryName} archived.`; state.error = ''; notify(); return true;
      } catch (error) { state.error = error.message; notify(); throw error; }
    }
    function setFilters({ search = state.search, status = state.statusFilter, references = state.referenceFilter } = {}) { state.search = String(search || ''); state.statusFilter = status; state.referenceFilter = references; notify(); }
    function filteredRules() {
      const query = normalize(state.search);
      return state.rules.filter(rule => {
        if (query && !normalize(`${rule.categoryName} ${(rule.priorityDetails || []).join(' ')} ${rule.note || ''} ${(rule.prefixRefs || []).join(' ')} ${(rule.seriesRefs || []).join(' ')}`).includes(query)) return false;
        if (state.statusFilter === 'enabled' && !rule.enabled) return false;
        if (state.statusFilter === 'disabled' && rule.enabled) return false;
        const hasPrefix = Boolean(rule.prefixRefs?.length), hasSeries = Boolean(rule.seriesRefs?.length);
        if (state.referenceFilter === 'has-prefix' && !hasPrefix) return false;
        if (state.referenceFilter === 'has-series' && !hasSeries) return false;
        if (state.referenceFilter === 'has-any' && !hasPrefix && !hasSeries) return false;
        if (state.referenceFilter === 'no-references' && (hasPrefix || hasSeries)) return false;
        return true;
      });
    }
    async function canNavigateAway() { if (state.saving) return false; if (!state.dirty) return true; if (!await confirmDiscard()) return false; allowNextUnload = true; return true; }
    function shouldBlockUnload() { if (state.saving) return true; if (allowNextUnload) { allowNextUnload = false; return false; } return state.dirty; }
    async function cancel() { if (state.saving || (state.dirty && !await confirmDiscard())) return false; resetForm(); return true; }
    async function refresh() { if (state.saving || (state.dirty && !await confirmDiscard())) return false; await load(); return true; }
    return { state, load, beginAdd, beginEdit, setFormField, setChipDraft, addChip, removeChip, moveDetail, save, toggleRule, deleteRule, setFilters, filteredRules, canNavigateAway, shouldBlockUnload, cancel, refresh };
  }

  const exported = { createCategoryRulesController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationCategoryRules = exported;
  if (typeof document === 'undefined') return;

  const elements = {}; let controller; let renderedFormRevision = -1;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const formatDate = value => { const date = new Date(value); return value && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : 'Not saved yet'; };
  function renderChipList(field, target, locked) {
    target.innerHTML = controller.state.form[field].map((value, index) => `<span class="rule-chip">${escapeHtml(value)}${locked ? '' : `<button type="button" data-field="${field}" data-remove="${index}" aria-label="Remove ${escapeHtml(value)}">&times;</button>`}</span>`).join('');
  }
  function render() {
    const state = controller.state;
    elements.loading.hidden = !state.loading; elements.error.hidden = !state.error; elements.error.textContent = state.error;
    elements.success.hidden = !state.success; elements.success.textContent = state.success;
    elements.warning.hidden = !state.issues.length; elements.warning.textContent = state.issues.length ? `Saved configuration needs correction: ${state.issues.map(issue => issue.message).join(' ')}` : '';
    elements.dirty.hidden = !state.dirty; elements.updated.textContent = formatDate(state.updatedAt); elements.count.textContent = `${controller.filteredRules().length} of ${state.rules.length} rules`;
    elements.heading.textContent = state.editingId ? 'Edit Category Rule' : 'Add Category Rule'; elements.save.disabled = state.saving; elements.save.textContent = state.saving ? 'Saving…' : 'Save Rule';
    elements.rows.innerHTML = controller.filteredRules().map(rule => `<tr data-id="${escapeHtml(rule.id)}"><td data-label="Category"><span class="term-name">${escapeHtml(rule.categoryName)}</span>${rule.note ? '<small class="note-indicator">Notes configured</small>' : ''}</td><td data-label="Prefix / Series"><div class="reference-groups">${rule.prefixRefs?.length ? `<small>Prefixes</small><div class="table-chip-list">${rule.prefixRefs.map(value => `<span class="rule-chip">${escapeHtml(value)}</span>`).join('')}</div>` : ''}${rule.seriesRefs?.length ? `<small>Series</small><div class="table-chip-list">${rule.seriesRefs.map(value => `<span class="rule-chip">${escapeHtml(value)}</span>`).join('')}</div>` : ''}${!rule.prefixRefs?.length && !rule.seriesRefs?.length ? '<span>—</span>' : ''}</div></td><td data-label="Important Verified Details"><div class="table-chip-list">${(rule.priorityDetails || []).map(value => `<span class="rule-chip">${escapeHtml(value)}</span>`).join('')}</div></td><td data-label="Enabled"><input class="enabled-switch" type="checkbox" aria-label="Enable ${escapeHtml(rule.categoryName)}" ${rule.enabled ? 'checked' : ''} ${state.togglingId === rule.id ? 'disabled' : ''}></td><td data-label="Actions"><div class="row-actions"><button class="edit-row" type="button" aria-label="Edit ${escapeHtml(rule.categoryName)}">Edit</button>${rule.origin === 'custom' ? `<button class="delete-row" type="button" aria-label="Delete ${escapeHtml(rule.categoryName)}">Delete</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="5" class="empty-row">No Category Rules match these filters.</td></tr>';
    if (renderedFormRevision !== state.formRevision) {
      elements.category.value = state.form.categoryName; elements.note.value = state.form.note; elements.enabled.checked = state.form.enabled;
      document.querySelector('#prefix-input').value = state.chipDrafts.prefixRefs; document.querySelector('#series-input').value = state.chipDrafts.seriesRefs; document.querySelector('#detail-input').value = state.chipDrafts.priorityDetails;
      renderedFormRevision = state.formRevision;
    }
    elements.category.readOnly = state.identityLocked; elements.prefixFieldset.disabled = state.identityLocked || state.saving; elements.seriesFieldset.disabled = state.identityLocked || state.saving;
    elements.category.disabled = state.saving; elements.note.disabled = state.saving; elements.enabled.disabled = state.saving; elements.detailFieldset.disabled = state.saving;
    renderChipList('prefixRefs', elements.prefixChips, state.identityLocked); renderChipList('seriesRefs', elements.seriesChips, state.identityLocked);
    elements.detailChips.innerHTML = state.form.priorityDetails.map((value, index, list) => `<div class="detail-item"><span>${escapeHtml(value)}</span><button type="button" data-move="-1" data-index="${index}" aria-label="Move ${escapeHtml(value)} up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="1" data-index="${index}" aria-label="Move ${escapeHtml(value)} down" ${index === list.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-field="priorityDetails" data-remove="${index}" aria-label="Remove ${escapeHtml(value)}">×</button></div>`).join('');
    elements.formError.hidden = !state.error || !state.dirty; elements.formError.textContent = state.dirty ? state.error : '';
    for (const field of ['categoryName', 'prefixRefs', 'seriesRefs', 'priorityDetails', 'note']) { const target = document.getElementById(`${field}-error`); target.textContent = state.formErrors[field] || ''; target.hidden = !state.formErrors[field]; }
  }
  function confirmDialog(dialog, accepted) { return new Promise(resolve => { dialog.returnValue = 'cancel'; dialog.addEventListener('close', () => resolve(dialog.returnValue === accepted), { once: true }); dialog.showModal(); }); }
  async function navigate(target) { if (!await controller.canNavigateAway()) return; requestAnimationFrame(() => { window.location.href = target; }); }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => {
    Object.assign(elements, {
      rows: document.querySelector('#rule-rows'), loading: document.querySelector('#loading-state'), error: document.querySelector('#error-message'), success: document.querySelector('#success-message'), warning: document.querySelector('#quarantine-message'), dirty: document.querySelector('#dirty-state'), updated: document.querySelector('#last-updated'), count: document.querySelector('#rule-count'),
      editor: document.querySelector('#category-editor'), heading: document.querySelector('#editor-heading'), form: document.querySelector('#rule-form'), formError: document.querySelector('#form-error'), save: document.querySelector('#save-rule'), category: document.querySelector('#category-name'), note: document.querySelector('#note'), enabled: document.querySelector('#enabled'),
      prefixFieldset: document.querySelector('#prefix-chips').closest('fieldset'), seriesFieldset: document.querySelector('#series-chips').closest('fieldset'), detailFieldset: document.querySelector('#detail-chips').closest('fieldset'), prefixChips: document.querySelector('#prefix-chips'), seriesChips: document.querySelector('#series-chips'), detailChips: document.querySelector('#detail-chips'), discard: document.querySelector('#discard-changes-dialog'), deletion: document.querySelector('#delete-rule-dialog')
    });
    controller = createCategoryRulesController({ api: window.titleOptimizationCategoryRulesAPI, confirmDiscard: () => confirmDialog(elements.discard, 'discard'), confirmDelete: () => confirmDialog(elements.deletion, 'delete'), onChange: render });
    const openEditor = () => { elements.editor.showModal(); elements.category.focus(); };
    const closeEditor = async () => { if (await controller.cancel()) elements.editor.close(); };
    elements.rows.addEventListener('click', event => { const id = event.target.closest('tr[data-id]')?.dataset.id; if (!id) return; if (event.target.closest('.edit-row')) controller.beginEdit(id).then(changed => { if (changed) openEditor(); }); if (event.target.closest('.delete-row')) controller.deleteRule(id).catch(() => {}); });
    elements.rows.addEventListener('change', event => { const id = event.target.closest('tr[data-id]')?.dataset.id; if (id && event.target.matches('.enabled-switch')) controller.toggleRule(id, event.target.checked).catch(() => {}); });
    elements.category.addEventListener('input', event => controller.setFormField('categoryName', event.target.value)); elements.note.addEventListener('input', event => controller.setFormField('note', event.target.value)); elements.enabled.addEventListener('change', event => controller.setFormField('enabled', event.target.checked));
    const chipInputs = { prefixRefs: document.querySelector('#prefix-input'), seriesRefs: document.querySelector('#series-input'), priorityDetails: document.querySelector('#detail-input') };
    function addFromInput(field) { if (controller.addChip(field, chipInputs[field].value)) { chipInputs[field].value = ''; controller.setChipDraft(field, ''); } }
    document.querySelector('#add-prefix').addEventListener('click', () => addFromInput('prefixRefs')); document.querySelector('#add-series').addEventListener('click', () => addFromInput('seriesRefs')); document.querySelector('#add-detail').addEventListener('click', () => addFromInput('priorityDetails'));
    Object.entries(chipInputs).forEach(([field, input]) => { input.addEventListener('input', event => controller.setChipDraft(field, event.target.value)); input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addFromInput(field); } }); });
    elements.form.addEventListener('click', event => { const remove = event.target.closest('[data-remove]'); if (remove) controller.removeChip(remove.dataset.field, Number(remove.dataset.remove)); const move = event.target.closest('[data-move]'); if (move) controller.moveDetail(Number(move.dataset.index), Number(move.dataset.move)); });
    elements.form.addEventListener('submit', async event => { event.preventDefault(); try { await controller.save(); elements.editor.close(); } catch { /* Keep draft and inline errors. */ } });
    document.querySelector('#add-button').addEventListener('click', async () => { if (await controller.beginAdd()) openEditor(); }); document.querySelector('#cancel-rule').addEventListener('click', () => closeEditor().catch(() => {})); document.querySelector('#close-rule').addEventListener('click', () => closeEditor().catch(() => {})); elements.editor.addEventListener('cancel', event => { event.preventDefault(); closeEditor().catch(() => {}); });
    document.querySelector('#refresh-button').addEventListener('click', () => controller.refresh().catch(() => {})); document.querySelector('#rule-search').addEventListener('input', event => controller.setFilters({ search: event.target.value })); document.querySelector('#status-filter').addEventListener('change', event => controller.setFilters({ status: event.target.value })); document.querySelector('#reference-filter').addEventListener('change', event => controller.setFilters({ references: event.target.value }));
    document.querySelectorAll('[data-navigate]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.navigate))); window.addEventListener('beforeunload', event => { if (controller.shouldBlockUnload()) { event.preventDefault(); event.returnValue = ''; } }); controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
