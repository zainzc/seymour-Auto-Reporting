const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = '../src/renderer/pages/title-optimization/source-fields.js';

function payload() {
  return {
    mappings: [
      { id: 'core', logicalKey: 'sku', displayName: 'SKU', protected: false, required: true, enabled: true, sourceFieldId: 'fld-sku', status: 'Mapped', updatedAt: '2026-09-09T10:00:00.000Z' },
      { id: 'custom', logicalKey: 'paintCode', displayName: 'Paint Code', protected: false, isCustom: true, required: false, enabled: true, sourceFieldId: null, status: 'Unmapped', updatedAt: '2026-09-09T10:00:00.000Z' }
    ],
    fields: [
      { id: 'fld-sku', name: 'SKU', type: 'singleLineText' },
      { id: 'fld-paint', name: 'C:Paint Code', type: 'singleLineText' }
    ],
    table: { id: 'tbl', name: 'eBay Listings (API)' },
    updatedAt: '2026-09-09T10:00:00.000Z',
    quarantined: []
  };
}

test('display name suggests an editable camelCase logical key', () => {
  const { suggestLogicalKey } = require(MODULE_PATH);
  assert.equal(suggestLogicalKey('Paint Code'), 'paintCode');
  assert.equal(suggestLogicalKey('VIN / Identifier'), 'vinIdentifier');
});

test('controller loads rows and available fields without becoming dirty', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: { load: async () => ({ success: true, data: payload() }) } });
  await controller.load();

  assert.equal(controller.state.mappings.length, 2);
  assert.equal(controller.state.fields.length, 2);
  assert.equal(controller.state.dirty, false);
  assert.equal(controller.state.mappings[0].status, 'Mapped');
});

test('changing a field updates metadata and marks state dirty until save succeeds', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  let saved;
  const controller = createSourceFieldsController({ api: {
    load: async () => ({ success: true, data: payload() }),
    save: async (mappings) => { saved = mappings; return { success: true, data: { ...payload(), mappings } }; }
  } });
  await controller.load();
  controller.changeSourceField('custom', 'fld-paint');

  assert.equal(controller.state.dirty, true);
  assert.deepEqual(controller.state.mappings.find((m) => m.id === 'custom'), {
    ...payload().mappings[1], sourceFieldId: 'fld-paint', sourceFieldName: 'C:Paint Code',
    sourceFieldType: 'singleLineText', status: 'Mapped'
  });
  await controller.save();
  assert.equal(saved.length, 2);
  assert.equal(controller.state.dirty, false);
});

test('failed save preserves edits and surfaces field-level validation details', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: {
    load: async () => ({ success: true, data: payload() }),
    save: async () => ({ success: false, error: { message: 'Required mappings are missing.', details: [{ logicalKey: 'sku', message: 'SKU is required.' }] } })
  } });
  await controller.load();
  controller.changeSourceField('core', '');
  await assert.rejects(controller.save(), /Required mappings/);

  assert.equal(controller.state.dirty, true);
  assert.equal(controller.state.errors.sku, 'SKU is required.');
});

test('failed refresh retains current mappings and last-known fields', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: {
    load: async () => ({ success: true, data: payload() }),
    refreshFields: async () => ({ success: false, error: { message: 'Rate limited.' }, current: payload() })
  } });
  await controller.load();
  await assert.rejects(controller.refresh(), /Rate limited/);

  assert.equal(controller.state.mappings.length, 2);
  assert.equal(controller.state.fields[1].name, 'C:Paint Code');
  assert.equal(controller.state.error, 'Rate limited.');
});

test('custom rows can be added and edited locally while duplicate keys are rejected', () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: {} });
  controller.replaceData(payload());
  controller.upsertCustom({ displayName: 'Transmission Code', logicalKey: 'transmissionCode', sourceFieldId: 'fld-paint', required: false, enabled: true });
  assert.equal(controller.state.mappings.at(-1).sourceFieldName, 'C:Paint Code');
  assert.equal(controller.state.dirty, true);
  assert.throws(() => controller.upsertCustom({ displayName: 'Duplicate', logicalKey: 'paintCode' }), /already exists/);

  const id = controller.state.mappings.at(-1).id;
  controller.upsertCustom({ id, displayName: 'Transmission Identifier', logicalKey: 'transmissionCode', sourceFieldId: '', enabled: false });
  assert.equal(controller.state.mappings.at(-1).displayName, 'Transmission Identifier');
  assert.equal(controller.state.mappings.at(-1).status, 'Disabled');
});

test('seeded and custom rows can both be edited and soft-deleted', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  let deletedId;
  const controller = createSourceFieldsController({
    api: { deleteCustomMapping: async (id) => { deletedId = id; return { success: true, data: { ...payload(), mappings: payload().mappings.slice(0, 1) } }; } },
    confirmDelete: () => true
  });
  controller.replaceData(payload());
  controller.upsertCustom({ id: 'core', displayName: 'Stock Number', logicalKey: 'stockNumber', sourceFieldId: 'fld-sku', enabled: true });
  assert.equal(controller.state.mappings[0].logicalKey, 'stockNumber');
  await controller.deleteMapping('core');
  assert.equal(deletedId, 'core');
  controller.replaceData(payload());
  await controller.deleteMapping('custom');
  assert.equal(deletedId, 'custom');
  assert.equal(controller.state.mappings.length, 1);
});

test('deleting an unsaved custom row removes it locally without calling the persistence API', async () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  let apiCalls = 0;
  const controller = createSourceFieldsController({
    api: { deleteCustomMapping: async () => { apiCalls += 1; } },
    confirmDelete: () => true
  });
  controller.replaceData(payload());
  controller.upsertCustom({ displayName: 'New Field', logicalKey: 'newField', sourceFieldId: 'fld-paint', enabled: true });
  const newId = controller.state.mappings.at(-1).id;
  await controller.deleteMapping(newId);

  assert.equal(apiCalls, 0);
  assert.equal(controller.state.mappings.some((mapping) => mapping.id === newId), false);
  assert.equal(controller.state.dirty, true);
});

test('navigation guard confirms only when changes are unsaved', () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  let confirmations = 0;
  const controller = createSourceFieldsController({ api: {}, confirmDiscard: () => { confirmations += 1; return false; } });
  controller.replaceData(payload());
  assert.equal(controller.canNavigateAway(), true);
  controller.setRequired('custom', true);
  assert.equal(controller.canNavigateAway(), false);
  assert.equal(confirmations, 1);
});

test('approved workspace navigation suppresses exactly one beforeunload prompt', () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: {}, confirmDiscard: () => true });
  controller.replaceData(payload());
  controller.setRequired('custom', true);

  assert.equal(controller.canNavigateAway(), true);
  assert.equal(controller.shouldBlockUnload(), false);
  assert.equal(controller.shouldBlockUnload(), true);
});

test('users can toggle Required off for seeded mappings', () => {
  const { createSourceFieldsController } = require(MODULE_PATH);
  const controller = createSourceFieldsController({ api: {} });
  controller.replaceData(payload());

  controller.setRequired('core', false);

  assert.equal(controller.state.mappings[0].required, false);
  assert.equal(controller.state.dirty, true);
});

test('workspace navigation uses an in-app discard dialog and Source Field dialog restores text focus', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.js'), 'utf8');

  assert.match(html, /id="discard-changes-dialog"/);
  assert.match(script, /confirmDiscardChanges/);
  assert.doesNotMatch(script, /window\.confirm\('You have unsaved Source Fields changes/);
  assert.match(script, /elements\.displayName\.focus\(\)/);
  assert.doesNotMatch(script, /mapping\.isCustom\s*\?/);
});

test('Source Field dialog uses an encoding-safe accessible close icon', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.html'), 'utf8');

  assert.match(html, /id="dialog-cancel"[^>]*aria-label="Close dialog"[^>]*>&times;<\/button>/);
  assert.doesNotMatch(html, /id="dialog-cancel"[^>]*>[^<]*Ã[^<]*<\/button>/);
});

test('required markers stay inline with Source Field labels', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.css'), 'utf8');

  for (const label of ['Display Name', 'Logical Key', 'Airtable Field']) {
    assert.match(html, new RegExp(`<span class="field-label">${label} <span aria-hidden="true">\\*</span></span>`));
  }
  assert.match(css, /\.field-label\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*baseline;/s);
});

test('workspace navigation does not change color on hover', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.css'), 'utf8');

  assert.doesNotMatch(css, /\.workspace-links\s+button:hover\s*\{/);
});

test('Source Fields header actions stay in one desktop row and stack on mobile', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.css'), 'utf8');

  assert.match(css, /\.card-actions\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*flex-shrink:\s*0;/s);
  assert.match(css, /@media\s*\(max-width:\s*680px\)[\s\S]*?\.card-actions\s*\{[^}]*flex-direction:\s*column;/s);
});
