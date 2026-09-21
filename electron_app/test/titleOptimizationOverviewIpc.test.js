const test=require('node:test');
const assert=require('node:assert/strict');
const { registerTitleOptimizationOverviewIpc }=require('../src/main/titleOptimizationOverviewIpc');
test('Overview IPC is read-only and serializes load errors',async()=>{const handlers=new Map();registerTitleOptimizationOverviewIpc({handle:(c,h)=>handlers.set(c,h)},{load:async()=>({status:'Healthy'})});assert.deepEqual([...handlers.keys()],['title-optimization-overview:load']);assert.deepEqual(await handlers.get('title-optimization-overview:load')({}),{success:true,data:{status:'Healthy'}});});
