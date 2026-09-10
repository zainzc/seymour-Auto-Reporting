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
      return applyOrder([...DEFAULT_ORDER]);
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
})(typeof globalThis !== 'undefined' ? globalThis : window);
