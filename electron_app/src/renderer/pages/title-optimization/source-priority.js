(function initSourcePriorityModule(globalScope) {
  const DEFAULT_ORDER = Object.freeze([
    'manualOverride', 'lockedFixedIpn', 'itemSpecifics', 'categoryConditions',
    'manufacturerPartNumber', 'brandMake', 'otherStructuredFields', 'currentEbay', 'rawHollander'
  ]);

  function createSourcePriorityController(options = {}) {
    const api = options.api || {};
    const confirmReset = options.confirmReset || (async () => true);
    const confirmDiscard = options.confirmDiscard || (async () => true);
    const onChange = options.onChange || (() => {});
    let allowNextUnload = false;
    const state = {
      order: [], rows: [], updatedAt: null, updatedBy: null, issues: [], requiresCorrection: false,
      dirty: false, loading: false, saving: false, error: '', success: ''
    };

    function notify() { onChange(state); }

    function orderedRows(order, currentRows = state.rows) {
      const byKey = new Map(currentRows.map((row) => [row.key, row]));
      return order.map((key, index) => ({ ...byKey.get(key), key, priority: index + 1 }));
    }

    function replaceData(data = {}) {
      state.order = [...(data.order || [])];
      state.rows = orderedRows(state.order, data.rows || []);
      state.updatedAt = data.updatedAt || null;
      state.updatedBy = data.updatedBy || null;
      state.issues = structuredClone(data.issues || []);
      state.requiresCorrection = Boolean(data.requiresCorrection);
      state.dirty = false;
      state.error = '';
      state.success = '';
      notify();
    }

    async function load() {
      state.loading = true;
      notify();
      try {
        const result = await api.load();
        if (!result?.success) throw new Error(result?.error?.message || 'Unable to load Source Priority.');
        replaceData(result.data);
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

    function applyOrder(nextOrder) {
      if (nextOrder.length !== state.order.length || nextOrder.every((key, index) => key === state.order[index])) return false;
      state.order = [...nextOrder];
      state.rows = orderedRows(state.order);
      state.dirty = true;
      state.success = '';
      state.error = '';
      state.requiresCorrection = false;
      state.issues = [];
      notify();
      return true;
    }

    function move(key, direction) {
      const index = state.order.indexOf(key);
      if (key === 'manualOverride' || index < 1) return false;
      const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : index;
      if (target < 1 || target >= state.order.length) return false;
      const next = [...state.order];
      [next[index], next[target]] = [next[target], next[index]];
      return applyOrder(next);
    }

    function drop(draggedKey, targetKey) {
      if (draggedKey === 'manualOverride' || draggedKey === targetKey || !state.order.includes(draggedKey) || !state.order.includes(targetKey)) return false;
      const next = state.order.filter((key) => key !== draggedKey);
      let targetIndex = targetKey === 'manualOverride' ? 1 : next.indexOf(targetKey);
      if (targetIndex < 1) targetIndex = 1;
      next.splice(targetIndex, 0, draggedKey);
      return applyOrder(next);
    }

    async function reset() {
      if (!await confirmReset()) return false;
      const changed = applyOrder([...DEFAULT_ORDER]);
      if (changed) return true;
      state.dirty = true;
      state.success = '';
      state.error = '';
      state.requiresCorrection = false;
      state.issues = [];
      notify();
      return true;
    }

    async function save() {
      state.saving = true;
      state.error = '';
      state.success = '';
      notify();
      try {
        const result = await api.save([...state.order]);
        if (!result?.success) {
          state.issues = structuredClone(result?.error?.details || []);
          throw new Error(result?.error?.message || 'Unable to save Source Priority.');
        }
        replaceData(result.data);
        state.success = 'Source Priority saved successfully.';
        notify();
        return result.data;
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

    async function canNavigateAway() {
      if (!state.dirty) return true;
      if (!await confirmDiscard()) return false;
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
      state, load, replaceData, move, drop, reset, save,
      canNavigateAway, shouldBlockUnload, authorizeNextUnload
    };
  }

  const exported = { DEFAULT_ORDER, createSourcePriorityController };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.TitleOptimizationSourcePriority = exported;

  if (typeof document === 'undefined') return;

  const elements = {};
  let controller;
  let draggedKey = null;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function formatDate(value) {
    if (!value) return 'Not saved yet';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }

  function lockIcon() {
    return '<span class="lock-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 8h-1V6a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Zm-7-2a2 2 0 1 1 4 0v2h-4V6Z"/></svg>Locked</span>';
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
    elements.reset.disabled = state.loading || state.saving;
    elements.updated.textContent = formatDate(state.updatedAt);
    elements.correction.hidden = !state.requiresCorrection && !state.issues.length;
    elements.correction.textContent = state.requiresCorrection || state.issues.length
      ? `Source Priority requires correction: ${state.issues.map((issue) => issue.message).join(' ')}`
      : '';

    elements.rows.innerHTML = state.rows.map((row, index) => {
      const locked = row.key === 'manualOverride';
      const statusClass = String(row.status || 'Reorderable').toLowerCase().replace(/\s+/g, '-');
      const dragControl = locked
        ? '<span class="drag-placeholder">Fixed</span>'
        : `<button class="drag-handle" type="button" draggable="true" aria-label="Drag ${escapeHtml(row.label)} to reorder" title="Drag to reorder">⠿</button>`;
      const moveControls = locked
        ? '<span class="drag-placeholder">Cannot move</span>'
        : `<span class="move-controls"><button class="move-button move-up" type="button" aria-label="Move ${escapeHtml(row.label)} up" ${index === 1 ? 'disabled' : ''}>↑</button><button class="move-button move-down" type="button" aria-label="Move ${escapeHtml(row.label)} down" ${index === state.rows.length - 1 ? 'disabled' : ''}>↓</button></span>`;
      return `<tr data-key="${escapeHtml(row.key)}">
        <td>${dragControl}</td>
        <td><span class="priority-number">${index + 1}</span></td>
        <td><span class="priority-source">${escapeHtml(row.label)}</span></td>
        <td class="description-cell">${escapeHtml(row.description)}</td>
        <td><span class="status-badge status-${statusClass}">${locked ? lockIcon() : escapeHtml(row.status || 'Reorderable')}</span></td>
        <td>${moveControls}</td>
      </tr>`;
    }).join('');
  }

  function confirmWithDialog(dialog, acceptedValue) {
    return new Promise((resolve) => {
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
      rows: document.querySelector('#priority-rows'),
      loading: document.querySelector('#loading-state'),
      error: document.querySelector('#error-message'),
      success: document.querySelector('#success-message'),
      correction: document.querySelector('#correction-message'),
      dirty: document.querySelector('#dirty-state'),
      save: document.querySelector('#save-button'),
      reset: document.querySelector('#reset-button'),
      updated: document.querySelector('#last-updated'),
      resetDialog: document.querySelector('#reset-priority-dialog'),
      discardDialog: document.querySelector('#discard-changes-dialog')
    });

    controller = createSourcePriorityController({
      api: window.titleOptimizationSourcePriorityAPI,
      confirmReset: () => confirmWithDialog(elements.resetDialog, 'reset'),
      confirmDiscard: () => confirmWithDialog(elements.discardDialog, 'discard'),
      onChange: render
    });

    elements.rows.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-key]');
      if (!row) return;
      if (event.target.closest('.move-up')) controller.move(row.dataset.key, 'up');
      if (event.target.closest('.move-down')) controller.move(row.dataset.key, 'down');
    });

    elements.rows.addEventListener('dragstart', (event) => {
      const handle = event.target.closest('.drag-handle');
      const row = handle?.closest('tr[data-key]');
      if (!row || row.dataset.key === 'manualOverride') {
        event.preventDefault();
        return;
      }
      draggedKey = row.dataset.key;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedKey);
    });
    elements.rows.addEventListener('dragover', (event) => {
      const row = event.target.closest('tr[data-key]');
      if (!draggedKey || !row) return;
      event.preventDefault();
      elements.rows.querySelectorAll('.drag-over').forEach((entry) => entry.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    elements.rows.addEventListener('drop', (event) => {
      const row = event.target.closest('tr[data-key]');
      if (!draggedKey || !row) return;
      event.preventDefault();
      controller.drop(draggedKey, row.dataset.key);
      draggedKey = null;
    });
    elements.rows.addEventListener('dragend', () => {
      draggedKey = null;
      elements.rows.querySelectorAll('.drag-over').forEach((entry) => entry.classList.remove('drag-over'));
    });

    elements.reset.addEventListener('click', () => controller.reset().catch(() => {}));
    elements.save.addEventListener('click', () => controller.save().catch(() => {}));
    document.querySelectorAll('[data-navigate]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.navigate)));
    window.addEventListener('beforeunload', (event) => {
      if (!controller.shouldBlockUnload()) return;
      event.preventDefault();
      event.returnValue = '';
    });

    controller.load().catch(() => {});
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
