const SECTION_ORDER = ['Source Fields','Source Priority','Terminology Rules','Synonyms','Prefix Rules','Restricted Terms','Category Rules','Title Structure','Flag Reasons','System Rules'];
const PATHS = {'Source Fields':'source-fields.html','Source Priority':'source-priority.html','Terminology Rules':'terminology-rules.html','Synonyms':'synonyms.html','Prefix Rules':'prefix-rules.html','Restricted Terms':'restricted-terms.html','Category Rules':'category-rules.html','Title Structure':'title-structure.html','Flag Reasons':'flag-reasons.html','System Rules':'system-rules.html'};
const arrays = value => ['mappings','rows','rules','terms','structures','reasons'].map(key => value?.[key]).find(Array.isArray) || (Array.isArray(value) ? value : []);
const messages = value => {
  const result=[];
  for(const key of ['issues','warnings']) for(const issue of Array.isArray(value?.[key]) ? value[key] : []) result.push(typeof issue==='string' ? issue : issue?.message || JSON.stringify(issue));
  if(value?.schemaError) result.push(typeof value.schemaError==='string' ? value.schemaError : value.schemaError.message || JSON.stringify(value.schemaError));
  return result.filter(Boolean);
};
function summarize(name, value) {
  const items=arrays(value);
  const active=items.filter(item => item && item.enabled !== false && !item.deletedAt);
  const seeded=items.filter(item => item?.origin==='client-v5' || item?.source==='client-v5');
  const custom=items.filter(item => item?.origin==='custom' || item?.source==='custom');
  const warnings=messages(value);
  return { name, path:PATHS[name], available:true, state:warnings.length?'Needs Correction':name==='System Rules'?'Locked':'Configured', activeCount:active.length, seededCount:seeded.length, customCount:custom.length, warningCount:warnings.length, warnings };
}
function createTitleOptimizationOverviewService(loaders={}) {
  async function load() {
    const sections=[];
    const warnings=[];
    let unavailable=false;
    const values={};
    for(const name of SECTION_ORDER) {
      try {
        if(typeof loaders[name]!=='function') throw Error('Service is unavailable.');
        const value=await loaders[name](); values[name]=value;
        const section=summarize(name,value); sections.push(section);
        section.warnings.forEach(message=>warnings.push({section:name,message}));
      } catch(error) {
        unavailable=true;
        const message=String(error?.message || error || 'Service is unavailable.');
        sections.push({name,path:PATHS[name],available:false,state:'Unavailable',activeCount:0,seededCount:0,customCount:0,warningCount:0,warnings:[],error:message});
      }
    }
    const systemRules=arrays(values['System Rules']);
    const highlightIds=new Set(['SR-01','SR-02','SR-03','SR-05','SR-07','SR-14','SR-15']);
    return { status:unavailable?'Unavailable':warnings.length?'Needs Attention':'Healthy', configuredTabs:sections.filter(section=>section.available).length, totalTabs:SECTION_ORDER.length, warningCount:warnings.length, systemRuleCount:systemRules.length, warnings, sections, safetyHighlights:systemRules.filter(rule=>highlightIds.has(rule.id)).map(rule=>({id:rule.id,title:rule.title})) };
  }
  return { load };
}
module.exports={ SECTION_ORDER, createTitleOptimizationOverviewService };
