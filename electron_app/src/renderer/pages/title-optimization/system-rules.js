const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
function createSystemRulesController(options={}) {
  const api = options.api || {};
  const onChange = options.onChange || (() => {});
  const state = { rules:[], search:'', category:'all', loading:false, error:'' };
  const notify = () => onChange(state);
  async function load() { state.loading=true; notify(); try { const result=await api.load(); if(!result?.success) throw Error(result?.error?.message || 'Unable to load System Rules.'); state.rules=[...(result.data || [])]; state.error=''; return state.rules; } catch(error) { state.error=error.message; throw error; } finally { state.loading=false; notify(); } }
  function setFilters(values={}) { if('search' in values) state.search=String(values.search || ''); if('category' in values) state.category=values.category; notify(); }
  function filtered() { const query=normalize(state.search); return state.rules.filter(rule => (state.category==='all' || rule.category===state.category) && (!query || normalize(`${rule.id} ${rule.title} ${rule.category} ${rule.behavior}`).includes(query))); }
  return { state, load, setFilters, filtered };
}
if(typeof module!=='undefined') module.exports={ createSystemRulesController };
if(typeof window!=='undefined' && typeof document!=='undefined') document.addEventListener('DOMContentLoaded', () => {
  const controller=createSystemRulesController({ api:window.titleOptimizationSystemRulesAPI, onChange:render });
  const rows=document.getElementById('rule-rows'), message=document.getElementById('message'), count=document.getElementById('rule-count');
  const escape=value=>String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
  function render(){ const rules=controller.filtered(); count.textContent=`${rules.length} of ${controller.state.rules.length} locked rules`; message.hidden=!controller.state.error; message.textContent=controller.state.error; rows.innerHTML=rules.map(rule=>`<tr><td><strong>${escape(rule.id)}</strong><span>${escape(rule.title)}</span></td><td><span class="category-badge">${escape(rule.category)}</span></td><td class="behavior-cell">${escape(rule.behavior).replace(/\n/g,'<br>')}</td><td><span class="locked-badge">Locked</span></td></tr>`).join(''); }
  document.getElementById('search').addEventListener('input',event=>controller.setFilters({search:event.target.value}));
  document.getElementById('category').addEventListener('change',event=>controller.setFilters({category:event.target.value}));
  document.querySelectorAll('[data-navigate]').forEach(button=>button.addEventListener('click',()=>{ window.location.href=button.dataset.navigate; }));
  controller.load().catch(()=>{});
});
