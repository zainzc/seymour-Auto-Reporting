(function initSourceFieldsModule(globalScope) {

  function suggestLogicalKey(value) {
    const words = String(value || '').trim().match(/[A-Za-z0-9]+/g) || [];
    if (!words.length) return '';
    return words.map((word, index) => {
      const normalized = word.toLowerCase();
      return index === 0 ? normalized : normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }).join('');
  }

  function localStatus(mapping, fields) {
    if (!mapping.enabled) return 'Disabled';
    if (!mapping.sourceFieldId && !mapping.sourceFieldName) return 'Unmapped';
    return fields.some((field) => field.id === mapping.sourceFieldId) ? 'Mapped' : 'Source Missing';
  }

  function createSourceFieldsController(options = {}) {
    const api = options.api || {};
    const confirmDelete = options.confirmDelete || (() => true);
    const confirmDiscard = options.confirmDiscard || (() => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      mappings: [], fields: [], table: null, updatedAt: null, quarantined: [],
      dirty: false, loading: false, saving: false, refreshing: false,
      error: '', success: '', errors: {}
    };

    function notify() { onChange(state); }
    function setBusy(key, value) { state[key] = value; notify(); }
    function replaceData(data = {}, preserveDirty = false) {
      state.mappings = structuredClone(data.mappings || []);
      state.fields = structuredClone(data.fields || []);
      state.table = data.table || null;
      state.updatedAt = data.updatedAt || null;
      state.quarantined = data.quarantined || [];
      state.error = data.schemaError || '';
      state.success = '';
      state.errors = {};
      if (!preserveDirty) state.dirty = false;
      notify();
    }

    async function load() {
      setBusy('loading', true);
      try {
        const result = await api.load();
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Source Fields.');
        replaceData(result.data);
        return result.data;
      } catch (error) {
        state.error = error.message;
        throw error;
      } finally {
        setBusy('loading', false);
      }
    }

    function updateLocal(id, changes) {
      state.mappings = state.mappings.map((mapping) => mapping.id === id
        ? { ...mapping, ...changes, status: localStatus({ ...mapping, ...changes }, state.fields) }
        : mapping);
      state.dirty = true;
      state.success = '';
      delete state.errors[state.mappings.find((mapping) => mapping.id === id)?.logicalKey];
      notify();
    }

    function changeSourceField(id, fieldId) {
      const field = state.fields.find((entry) => entry.id === fieldId);
      updateLocal(id, {
        sourceFieldId: field?.id || null,
        sourceFieldName: field?.name || '',
        sourceFieldType: field?.type || ''
      });
    }

    function setRequired(id, required) {
      updateLocal(id, { required: Boolean(required) });
    }

    function setEnabled(id, enabled) { updateLocal(id, { enabled: Boolean(enabled) }); }

    function upsertCustom(input = {}) {
      const displayName = String(input.displayName || '').trim();
      const logicalKey = String(input.logicalKey || '').trim();
      if (!displayName) throw new Error('Display Name is required.');
      if (!/^[a-z][A-Za-z0-9]*$/.test(logicalKey)) throw new Error('Logical Key must be a camelCase identifier without spaces.');
      if (state.mappings.some((mapping) => mapping.logicalKey === logicalKey && mapping.id !== input.id)) {
        throw new Error(`Logical Key '${logicalKey}' already exists.`);
      }
      const field = state.fields.find((entry) => entry.id === input.sourceFieldId);
      if (input.id) {
        const existing = state.mappings.find((mapping) => mapping.id === input.id);
        if (!existing?.isCustom) throw new Error('Only custom mappings can be edited with this form.');
        updateLocal(input.id, {
          displayName, logicalKey, description: String(input.description || '').trim(),
          sourceFieldId: field?.id || null, sourceFieldName: field?.name || '', sourceFieldType: field?.type || '',
          required: Boolean(input.required), enabled: input.enabled !== false
        });
        return;
      }
      const id = `source-custom-${globalScope.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
      const mapping = {
        id, logicalKey, displayName, description: String(input.description || '').trim(),
        sourceProvider: 'airtable', sourceFieldId: field?.id || null, sourceFieldName: field?.name || '',
        sourceFieldType: field?.type || '', required: Boolean(input.required), enabled: input.enabled !== false,
        protected: false, isCustom: true,
        sortOrder: state.mappings.reduce((max, item) => Math.max(max, Number(item.sortOrder) || 0), 0) + 1,
        updatedAt: null, updatedBy: null, deletedAt: null, deletedBy: null
      };
      mapping.status = localStatus(mapping, state.fields);
      state.mappings = [...state.mappings, mapping];
      state.dirty = true;
      state.success = '';
      notify();
    }

    async function save() {
      setBusy('saving', true);
      state.error = '';
      state.errors = {};
      try {
        const result = await api.save(state.mappings.map(({ status, ...mapping }) => mapping));
        if (!result?.success) {
          (result?.error?.details || []).forEach((detail) => { if (detail.logicalKey) state.errors[detail.logicalKey] = detail.message; });
          throw new Error(result?.error?.message || 'Unable to save Source Fields.');
        }
        replaceData(result.data);
        state.success = 'Source Fields saved successfully.';
        notify();
        return result.data;
      } catch (error) {
        state.error = error.message;
        notify();
        throw error;
      } finally {
        setBusy('saving', false);
      }
    }

    async function refresh() {
      setBusy('refreshing', true);
      state.error = '';
      try {
        const result = await api.refreshFields();
        if (!result?.success) {
          if (result?.current && !state.dirty) replaceData(result.current);
          throw new Error(result?.error?.message || 'Unable to refresh Airtable fields.');
        }
        replaceData(result.data);
        state.success = 'Airtable fields refreshed.';
        notify();
        return result.data;
      } catch (error) {
        state.error = error.message;
        notify();
        throw error;
      } finally {
        setBusy('refreshing', false);
      }
    }

    async function deleteMapping(id) {
      const mapping = state.mappings.find((entry) => entry.id === id);
      if (!mapping) throw new Error('Source mapping was not found.');
      if (mapping.protected) throw new Error('Core protected mappings cannot be deleted.');
      if (!confirmDelete(mapping)) return false;
      if (!mapping.updatedAt) {
        state.mappings = state.mappings.filter((entry) => entry.id !== id);
        state.dirty = true;
        state.success = '';
        notify();
        return true;
      }
      const result = await api.deleteCustomMapping(id);
      if (!result?.success) throw new Error(result?.error?.message || 'Unable to delete source mapping.');
      replaceData(result.data);
      state.success = 'Custom source mapping removed.';
      notify();
      return true;
    }

    function canNavigateAway() {
      if (!state.dirty) return true;
      if (!confirmDiscard()) return false;
      allowNextUnload = true;
      return true;
    }

    function shouldBlockUnload() {
      if (allowNextUnload) {
        allowNextUnload = false;
        return false;
      }
      return state.dirty;
    }

    function authorizeNextUnload() { allowNextUnload = true; }

    return {
      state, load, replaceData, changeSourceField, setRequired, setEnabled,
      upsertCustom, save, refresh, deleteMapping, canNavigateAway, shouldBlockUnload, authorizeNextUnload
    };
  }

  const exported = { suggestLogicalKey, createSourceFieldsController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationSourceFields = exported;

  if (typeof document === 'undefined') return;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  const elements = {};
  let controller;
  let editingId = null;

  function fieldName(fieldId) { return controller.state.fields.find((field) => field.id === fieldId)?.name || ''; }
  function formatDate(value) {
    if (!value) return 'Not saved yet';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function render() {
    const state = controller.state;
    elements.loading.hidden = !state.loading;
    elements.error.hidden = !state.error;
    elements.error.textContent = state.error;
    elements.success.hidden = !state.success;
    elements.success.textContent = state.success;
    elements.dirty.hidden = !state.dirty;
    elements.save.disabled = !state.dirty || state.saving;
    elements.save.textContent = state.saving ? 'Saving…' : 'Save Changes';
    elements.refresh.disabled = state.refreshing || state.loading;
    elements.refresh.textContent = state.refreshing ? 'Refreshing…' : 'Refresh Fields';
    elements.updated.textContent = formatDate(state.updatedAt);
    elements.mappedCount.textContent = `${state.mappings.filter((mapping) => mapping.status === 'Mapped').length} of ${state.mappings.length} mapped`;
    elements.quarantine.hidden = !state.quarantined.length;
    elements.quarantine.textContent = state.quarantined.length
      ? `${state.quarantined.length} malformed mapping${state.quarantined.length === 1 ? '' : 's'} require correction and were not loaded.`
      : '';

    elements.rows.innerHTML = state.mappings.map((mapping) => {
      const sourceMissingOption = mapping.sourceFieldId && !state.fields.some((field) => field.id === mapping.sourceFieldId)
        ? `<option value="${escapeHtml(mapping.sourceFieldId)}" selected>Missing: ${escapeHtml(mapping.sourceFieldName || mapping.sourceFieldId)}</option>`
        : '';
      const options = [
        `<option value="">Unmapped</option>`,
        sourceMissingOption,
        ...state.fields.map((field) => `<option value="${escapeHtml(field.id)}" ${field.id === mapping.sourceFieldId ? 'selected' : ''}>${escapeHtml(field.name)} — ${escapeHtml(field.type)}</option>`)
      ].join('');
      return `<tr data-id="${escapeHtml(mapping.id)}">
        <td><strong>${escapeHtml(mapping.displayName)}</strong><span class="logical-key">${escapeHtml(mapping.logicalKey)}</span></td>
        <td class="description-cell">${escapeHtml(mapping.description)}</td>
        <td><select class="field-select" aria-label="Airtable field for ${escapeHtml(mapping.displayName)}">${options}</select></td>
        <td>${escapeHtml(mapping.sourceFieldType || '—')}</td>
        <td><label class="switch-label"><input class="required-toggle" type="checkbox" ${mapping.required ? 'checked' : ''}><span>${mapping.required ? 'Yes' : 'No'}</span></label></td>
        <td><span class="status-badge status-${mapping.status.toLowerCase().replace(' ', '-')}">${escapeHtml(mapping.status)}</span>${state.errors[mapping.logicalKey] ? `<span class="row-error">${escapeHtml(state.errors[mapping.logicalKey])}</span>` : ''}</td>
        <td class="actions-cell">
          ${mapping.isCustom ? `<button class="icon-btn edit-row" type="button" aria-label="Edit ${escapeHtml(mapping.displayName)}">Edit</button><button class="icon-btn delete-row" type="button" aria-label="Delete ${escapeHtml(mapping.displayName)}">Delete</button>` : '<span class="protected-label" title="Core mapping">Protected</span>'}
        </td>
      </tr>`;
    }).join('');
  }

  function openDialog(mapping = null) {
    editingId = mapping?.id || null;
    elements.dialogTitle.textContent = mapping ? 'Edit Source Field' : 'Add Source Field';
    elements.form.reset();
    elements.formError.hidden = true;
    elements.displayName.value = mapping?.displayName || '';
    elements.logicalKey.value = mapping?.logicalKey || '';
    elements.logicalKey.disabled = Boolean(mapping?.protected);
    elements.airtableField.innerHTML = `<option value="">Select an Airtable field</option>${controller.state.fields.map((field) =>
      `<option value="${escapeHtml(field.id)}">${escapeHtml(field.name)} — ${escapeHtml(field.type)}</option>`).join('')}`;
    elements.airtableField.value = mapping?.sourceFieldId || '';
    elements.description.value = mapping?.description || '';
    elements.required.checked = Boolean(mapping?.required);
    elements.enabled.checked = mapping ? mapping.enabled !== false : true;
    elements.dialog.showModal();
    requestAnimationFrame(() => elements.displayName.focus());
  }

  function confirmDiscardChanges() {
    return new Promise((resolve) => {
      elements.discardDialog.returnValue = 'cancel';
      elements.discardDialog.addEventListener('close', () => {
        resolve(elements.discardDialog.returnValue === 'discard');
      }, { once: true });
      elements.discardDialog.showModal();
    });
  }

  async function navigate(target) {
    if (controller.state.dirty && !await confirmDiscardChanges()) return;
    if (controller.state.dirty) controller.authorizeNextUnload();
    requestAnimationFrame(() => { window.location.href = target; });
  }

  document.addEventListener('DOMContentLoaded', () => {
    Object.assign(elements, {
      rows: document.querySelector('#mapping-rows'), loading: document.querySelector('#loading-state'),
      error: document.querySelector('#error-message'), success: document.querySelector('#success-message'),
      dirty: document.querySelector('#dirty-state'), save: document.querySelector('#save-button'),
      refresh: document.querySelector('#refresh-button'), updated: document.querySelector('#last-updated'),
      mappedCount: document.querySelector('#mapped-count'), quarantine: document.querySelector('#quarantine-message'),
      dialog: document.querySelector('#source-field-dialog'), dialogTitle: document.querySelector('#dialog-title'),
      form: document.querySelector('#source-field-form'), formError: document.querySelector('#form-error'),
      displayName: document.querySelector('#display-name'), logicalKey: document.querySelector('#logical-key'),
      airtableField: document.querySelector('#airtable-field'), description: document.querySelector('#description'),
      required: document.querySelector('#required'), enabled: document.querySelector('#enabled'),
      discardDialog: document.querySelector('#discard-changes-dialog')
    });
    controller = createSourceFieldsController({
      api: window.titleOptimizationSourceFieldsAPI,
      confirmDelete: (mapping) => window.confirm(`Delete “${mapping.displayName}”? It will be archived for audit and excluded from normal use.`),
      onChange: render
    });

    elements.rows.addEventListener('change', (event) => {
      const id = event.target.closest('tr')?.dataset.id;
      if (event.target.matches('.field-select')) controller.changeSourceField(id, event.target.value);
      if (event.target.matches('.required-toggle')) controller.setRequired(id, event.target.checked);
    });
    elements.rows.addEventListener('click', (event) => {
      const mapping = controller.state.mappings.find((item) => item.id === event.target.closest('tr')?.dataset.id);
      if (event.target.closest('.edit-row')) openDialog(mapping);
      if (event.target.closest('.delete-row')) controller.deleteMapping(mapping.id).catch(() => {});
    });
    elements.displayName.addEventListener('input', () => {
      if (!editingId && !elements.logicalKey.dataset.edited) elements.logicalKey.value = suggestLogicalKey(elements.displayName.value);
    });
    elements.logicalKey.addEventListener('input', () => { elements.logicalKey.dataset.edited = 'true'; });
    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        controller.upsertCustom({
          id: editingId, displayName: elements.displayName.value, logicalKey: elements.logicalKey.value,
          sourceFieldId: elements.airtableField.value, description: elements.description.value,
          required: elements.required.checked, enabled: elements.enabled.checked
        });
        elements.dialog.close();
      } catch (error) {
        elements.formError.textContent = error.message;
        elements.formError.hidden = false;
      }
    });
    document.querySelector('#add-button').addEventListener('click', () => openDialog());
    document.querySelector('#dialog-cancel').addEventListener('click', () => elements.dialog.close());
    elements.save.addEventListener('click', () => controller.save().catch(() => {}));
    elements.refresh.addEventListener('click', () => {
      if (controller.state.dirty && !window.confirm('Refresh will reload the last saved mappings and discard unsaved changes. Continue?')) return;
      controller.refresh().catch(() => {});
    });
    document.querySelectorAll('[data-navigate]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', (event) => {
      if (!controller.shouldBlockUnload()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
