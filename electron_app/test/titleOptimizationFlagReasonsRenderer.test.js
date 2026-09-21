const test = require('node:test');
const assert = require('node:assert/strict');
const { createFlagReasonsController } = require('../src/renderer/pages/title-optimization/flag-reasons');
const seeded = { id:'client-v5-01', reason:'Missing verified year', note:null, enabled:true, required:true, origin:'client-v5', seedOrder:1 };
const custom = { id:'custom-1', reason:'Manual check', note:null, enabled:true, required:false, origin:'custom', seedOrder:null };

test('seeded editor locks identity and custom table toggle rolls back on failure', async () => {
  const controller = createFlagReasonsController({ api: { load:async()=>({success:true,data:{reasons:[seeded,custom],issues:[]}}), setEnabled:async()=>({success:false,error:{message:'Disk failed'}}) } });
  await controller.load(); await controller.beginEdit(seeded.id); assert.equal(controller.state.reasonReadOnly, true); assert.equal(controller.setField('reason','Changed'), false);
  await assert.rejects(controller.toggle(custom.id, false), /Disk failed/); assert.equal(controller.state.reasons.find(x=>x.id===custom.id).enabled, true);
});

test('search status and friendly origin filters combine without changing relative order', async () => {
  const controller = createFlagReasonsController({ api: { load:async()=>({success:true,data:{reasons:[seeded,custom],issues:[]}}) } }); await controller.load();
  controller.setFilters({ search:'missing', status:'enabled', origin:'required' }); assert.deepEqual(controller.filtered().map(x=>x.id), [seeded.id]);
  controller.setFilters({ search:'manual', origin:'custom' }); assert.deepEqual(controller.filtered().map(x=>x.id), [custom.id]);
});
