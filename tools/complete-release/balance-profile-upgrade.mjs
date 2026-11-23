import {readFileSync,existsSync} from 'node:fs';
import {safe,sha,atomic,json,need} from './common.mjs';
import {validateOnlineVitalsPolicy} from '../../server/src/original-data/online-pet-state.js';
import {validatePetBusinessPolicy} from '../../server/src/original-data/pet-business-state.js';
import {validateCareEconomyPolicy,normalizeUpgrades} from '../../server/src/original-data/pet-care-economy.js';

// Only explicitly pinned released/working policies are eligible. Operator policies and switches
// remain intact. Startup owns the service lock; no session can see a partial move.
const policies=[
  ['online-vitals',validateOnlineVitalsPolicy,'9fae233bf04d62d827a96d42b89037f0e5636b6aac30c3b23a0954763a5ddd3c'],
  ['pet-business',validatePetBusinessPolicy,'f2e4da2606277169c62b05e4700866a0245eb1af3f2e42078d8be203427499a4'],
  ['care-economy',validateCareEconomyPolicy,'5167da228e97761082b0f6ab5b0797dd2620eb5640455fb21f347eb04dd73a22'],
];
const digest=p=>sha(Buffer.from(JSON.stringify(p)));
export function upgradeBalanceProfiles(root) {
  const plans=[];
  for(const [name,validate,previous] of policies) {
    const filename='data/'+name+'.json',raw=readFileSync(safe(root,filename)),current=JSON.parse(raw);
    const shipped=JSON.parse(readFileSync(safe(root,'server/config/'+name+'.json')));
    // Minimal historical startup fixtures have no gameplay policy at all.
    if(!shipped.policy)continue;
    const nextPolicy=validate(shipped.policy),oldPolicy=validate(current.policy);
    const feedback=name==='online-vitals'&&nextPolicy.gameplay?.feedbackRules?.revision===2;
    const eligible=feedback?[previous,nextPolicy.gameplay.feedbackRules.previousDigest,nextPolicy.gameplay.feedbackRules.previousRuntimeDigest]:[previous];
    if(!eligible.includes(digest(oldPolicy))||digest(nextPolicy)===digest(oldPolicy))continue;
    if(name!=='care-economy')need((name==='online-vitals'?nextPolicy.gameplay.previousBalanceDigest:nextPolicy.previousBalanceDigest)===previous,'BALANCE_UPGRADE_TARGET');
    plans.push({filename,raw,next:json({...current,policy:shipped.policy}),...(feedback?{backup:'data/config-backups/feedback-20261022/'+digest(oldPolicy)+'/'+name+'.json'}:{})});
  }
  const upgradeFile='server/config/care-economy-upgrades.json';
  if(existsSync(safe(root,upgradeFile,{missing:true}))) {
    const shipped=JSON.parse(readFileSync(safe(root,upgradeFile)));
    normalizeUpgrades(shipped.transitions);
    const filename='data/care-economy-upgrades.json',present=existsSync(safe(root,filename,{missing:true}));
    const raw=present?readFileSync(safe(root,filename)):null;
    const current=present?JSON.parse(raw):{schemaVersion:1,transitions:[]};
    need(current.schemaVersion===1,'CARE_UPGRADE_CONFIGURATION');normalizeUpgrades(current.transitions);
    const merged=new Map(current.transitions.map(t=>[t.from,t]));
    for(const step of shipped.transitions){const old=merged.get(step.from);need(!old||old.to===step.to,'CARE_UPGRADE_CONFLICT');if(!old)merged.set(step.from,step);}
    const next={...current,transitions:[...merged.values()]};normalizeUpgrades(next.transitions);
    if(!present||JSON.stringify(current)!==JSON.stringify(next))plans.push({filename,raw,next:json(next)});
  }
  // Validate all inputs and backups before replacing any profile. An interrupted
  // write is safely resumed: known old policies move once, current ones are kept.
  for(const plan of plans)if(plan.raw){
    plan.backup??='data/config-backups/r26/'+plan.filename.slice(5);
    if(existsSync(safe(root,plan.backup,{missing:true})))need(sha(readFileSync(safe(root,plan.backup)))===sha(plan.raw),'BALANCE_BACKUP_CONFLICT');
  }
  for(const plan of plans)if(plan.backup&&!existsSync(safe(root,plan.backup,{missing:true})))atomic(root,plan.backup,plan.raw);
  for(const plan of plans)atomic(root,plan.filename,plan.next);
}
