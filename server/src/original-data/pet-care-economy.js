import {createHash} from 'node:crypto';
import {careMaximum} from './online-pet-state.js';
import {validCareNonce} from '../protocol/care-http.js';
import {friendXmlAttributes} from '../protocol/friend-http.js';
import {isToy} from './pet-activity-rules.js';

const MAX=0x7fffffff;
const uint=(v,max=MAX)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const text=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[<>\x00-\x1f]/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
// The digest a save and an upgrade transition are pinned to, derived exactly the way the
// constructor derives its own, so a staged catalogue move can record the transition the
// runtime will actually look for.
export const policyDigest=v=>hash(v);
// The declared multi-hop path between two catalogue digests: from → … → to through consecutive
// recorded transitions, or a refusal. Single-hop equality needs no hop at all; an unknown
// digest, a dead end, a cycle or a path that outruns the declared chain is CARE_POLICY_CHANGED,
// exactly as an unmatched single hop always was. Both the per-pet upgrade and the staged
// catalogue activation answer reachability with this one walk, so they cannot drift apart.
export function declaredPath(fromDigest,toDigest,transitions) {
  if(fromDigest===toDigest)return [];
  let current=fromDigest;
  const walked=[current],seen=new Set(walked);
  for(let hop=0;hop<=transitions.length;hop++) {
    const step=transitions.find(t=>t.from===current);
    if(!step)break;
    current=step.to;
    if(seen.has(current))break;
    seen.add(current);walked.push(current);
    if(current===toDigest)return walked.slice(1);
  }
  throw new Error('CARE_POLICY_CHANGED');
}
const ok=(extra={})=>({result:0,ret:0,...extra});
const fail=msg=>({result:1,ret:1,msg});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const itemKeys=['cid','name','desc','subkind','class','mood','hunger','cleanliness','charm','intelligence','strength','minLevel','maxLevel','price','pic'];
// An unresolved item is a shop row whose reference record carries competing effect values: it
// keeps its own identity and any stock already held, but one extra field marks the effect as
// undecided. The field is written only on those rows, so every settled entry keeps the exact
// field set it had before.
const unresolvedKeys=[...itemKeys,'effectUnresolved'];
const courseKeys=['id','name','descriptionHex','level','period','seconds','attribute','reward','icon'];
const jobKeys=['id','name','descriptionHex','level','salary','course','icon'];
function validDescription(i) {
  return typeof i.descriptionHex==='string'&&/^(?:[a-f0-9]{2}){1,16}$/.test(i.descriptionHex)
    &&new TextDecoder('gbk').decode(Buffer.from(i.descriptionHex,'hex'))===i.name;
}

// The catalogue is four explicit classes, and the class decides the whole effect shape.
// A class whose original effect is not established stays inert on purpose: `medicine`
// carries no effect, no price, and the use path refuses it, so a catalogue entry can never
// turn an unknown original behaviour into a claimed one.
//   food       subkind 0  hunger + only
//   clean      subkind 1  cleanliness + only
//   functional subkind 2  the local mood rule only, at exactly the declared value. Its price
//                         may be 0, which is the catalogue's "recorded, no known price" state:
//                         the buy and cart paths refuse it by price, the use path does not.
//   medicine   subkind 2  catalogue-only, not sellable and not usable
export const MOOD_ITEM_GAIN=100;
export const UNRESOLVED_ITEM=i=>i?.effectUnresolved===1;
export function itemClass(i) {
  if(i.effectsVersion===2) {
    if(i.class==='medicine')return i.subkind===2&&typeof i.medicineFor==='string'&&i.price>0;
    return (i.class==='food'&&i.subkind===0&&i.hunger>=0&&i.cleanliness===0)
      ||(i.class==='clean'&&i.subkind===1&&i.cleanliness>=0&&i.hunger===0)
      ||(i.class==='functional'&&i.subkind===2);
  }
  // An unresolved row states its class and subkind but no effect value: the numbers are 0
  // because nothing has been established, and the entry stays unsellable and unusable.
  if(UNRESOLVED_ITEM(i))return ((i.class==='food'&&i.subkind===0)||(i.class==='clean'&&i.subkind===1))
    &&i.hunger===0&&i.cleanliness===0&&i.mood===0&&i.price===0;
  // Food and cleaning items may also be recorded with price 0, the catalogue's explicit
  // "recorded, no known price" state the functional class already has: the buy and cart paths
  // refuse a zero-priced item by price, so an entry whose reference record carries an effect
  // but no price is registered, visible and not sellable instead of being left out.
  if(i.subkind===0)return i.class==='food'&&i.hunger>0&&i.cleanliness===0&&i.mood===0&&i.price>=0;
  if(i.subkind===1)return i.class==='clean'&&i.cleanliness>0&&i.hunger===0&&i.mood===0&&i.price>=0;
  if(i.subkind!==2)return false;
  if(i.hunger!==0||i.cleanliness!==0)return false;
  if(i.class==='functional')return i.mood===MOOD_ITEM_GAIN;
  if(i.class==='medicine')return i.mood===0&&i.price===0;
  return false;
}
export const usableItem=i=>!UNRESOLVED_ITEM(i)&&(i.effectsVersion===2
  ? i.class==='medicine'||['mood','hunger','cleanliness','charm','intelligence','strength'].some(k=>i[k]!==0)
  :i.class!=='medicine');
export const isRenameCard=i=>i?.class==='functional'&&i.name==='改名卡';
const renameCardDescription='用于宠物改名。请在宠物资料里确认改名，成功后消耗一张改名卡。';

// Declared catalogue transitions. Each entry names the digest a save may hold and the digest
// it is moved to; the pair is what makes an upgrade auditable, and an entry that names an
// unknown or not-yet-current digest is inert rather than permissive.
export function normalizeUpgrades(value) {
  if(value===undefined||value===null)return Object.freeze([]);
  if(!Array.isArray(value)||value.length>64)throw new TypeError('INVALID_CATALOGUE_UPGRADES');
  const seen=new Set();
  return Object.freeze(value.map((entry)=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)
        ||typeof entry.from!=='string'||!/^[a-f0-9]{64}$/.test(entry.from)
        ||typeof entry.to!=='string'||!/^[a-f0-9]{64}$/.test(entry.to))throw new TypeError('INVALID_CATALOGUE_UPGRADES');
    if(entry.from===entry.to||seen.has(`${entry.from}\0${entry.to}`))throw new TypeError('INVALID_CATALOGUE_UPGRADES');
    seen.add(`${entry.from}\0${entry.to}`);
    return Object.freeze({from:entry.from,to:entry.to,
      reason:typeof entry.reason==='string'&&entry.reason.length<=200?entry.reason:''});
  }));
}

export function validateCareEconomyPolicy(p) {
  const staged=['local-care-economy-v2','local-care-economy-v3','local-care-economy-v4'].includes(p?.id);
  if(!exact(p,['id','notifyUnknownByte','items','courses','jobs',...(staged?['activityLossPerMinute']:[])])||!['local-care-economy-v1','local-care-economy-v2','local-care-economy-v3','local-care-economy-v4'].includes(p.id)
      ||!uint(p.notifyUnknownByte,255))throw new TypeError('INVALID_CARE_POLICY');
  // `class` and `mood` were added for the functional/medicine classes. Every food and
  // cleaning entry that predates them is read with the class its subkind already implies,
  // so a stored v1/v2/v3 policy stays loadable and no entry changes meaning.
  const items=p.items.map((i)=>i&&typeof i==='object'&&!Array.isArray(i)
    ? {...i,class:i.class??(i.subkind===0?'food':i.subkind===1?'clean':undefined),mood:i.mood??0} : i);
  p={...p,items};
  if(staged&&(!exact(p.activityLossPerMinute,['study','work'])||['study','work'].some(kind=>
    !exact(p.activityLossPerMinute[kind],['hunger','cleanliness','mood'])
    ||Object.values(p.activityLossPerMinute[kind]).some(n=>!uint(n,100)))))throw new TypeError('INVALID_ACTIVITY_LOSS');
  if(['local-care-economy-v3','local-care-economy-v4'].includes(p.id)&&['study','work'].some(kind=>
    p.activityLossPerMinute[kind].hunger!==0||p.activityLossPerMinute[kind].cleanliness!==0))throw new TypeError('INVALID_ACTIVITY_LOSS');
  for(const [key,limit] of [['items',4096],['courses',100],['jobs',100]]) {
    if(!Array.isArray(p[key])||p[key].length===0||p[key].length>limit)throw new TypeError('INVALID_CARE_CATALOG');
    const ids=p[key].map(i=>i?.[key==='items'?'cid':'id']);
    if(ids.some(id=>!uint(id)||id===0)||new Set(ids).size!==ids.length)throw new TypeError('INVALID_CARE_CATALOG_IDS');
  }
  for(const i of p.items) {
    const keys=[...(i?.effectUnresolved===undefined?itemKeys:unresolvedKeys),
      ...(i.effectsVersion===2?['effectsVersion']:[]),...(i.medicineFor===undefined?[]:['medicineFor'])];
    if(i.effectUnresolved!==undefined&&i.effectUnresolved!==1)throw new TypeError('INVALID_CARE_ITEM');
    if(!exact(i,keys)||!text(i.name)||typeof i.desc!=='string'||i.desc.length>4096||/[<>\x00-\x1f]/.test(i.desc)
      ||![0,1,2].includes(i.subkind)||! /^[a-f0-9]{64}$/.test(i.pic)
      ||['hunger','cleanliness','charm','intelligence','strength','minLevel','maxLevel'].some(k=>
        i.effectsVersion===2&&['hunger','cleanliness'].includes(k)?!Number.isInteger(i[k])||Math.abs(i[k])>65535:!uint(i[k],65535))
      ||(i.medicineFor!==undefined&&!/^(?:cold:[1-4]|cough:[1-4]|stomach:[1-4]|revive|unmatched)$/.test(i.medicineFor))
      ||!uint(i.mood,1000)||!uint(i.price,1000000)||(i.maxLevel!==0&&i.maxLevel<i.minLevel)
      ||!itemClass(i))throw new TypeError('INVALID_CARE_ITEM');
  }
  for(const c of p.courses) {
    if(!exact(c,staged?[...courseKeys,'prerequisite']:courseKeys)||!text(c.name)||!validDescription(c)||!uint(c.level,65535)
      ||!uint(c.period,1000)||c.period===0||!uint(c.seconds,86400)||c.seconds<60
      ||!['charm','intelligence','strength'].includes(c.attribute)||!uint(c.reward,65535)||!text(c.icon))throw new TypeError('INVALID_CARE_COURSE');
    if(staged&&(!uint(c.prerequisite)||c.prerequisite===c.id
      ||(c.prerequisite!==0&&!p.courses.some(other=>other.id===c.prerequisite))))throw new TypeError('INVALID_CARE_PREREQUISITE');
  }
  if(staged)for(const c of p.courses) {
    const seen=new Set([c.id]);let next=c.prerequisite;
    while(next!==0) {
      if(seen.has(next))throw new TypeError('CYCLIC_CARE_PREREQUISITE');
      seen.add(next);next=p.courses.find(other=>other.id===next).prerequisite;
    }
  }
  for(const j of p.jobs) {
    if(!exact(j,staged?jobKeys.map(k=>k==='course'?'courses':k):jobKeys)||!text(j.name)||!validDescription(j)||!uint(j.level,65535)
      ||!uint(j.salary,1000000)||!text(j.icon))throw new TypeError('INVALID_CARE_JOB');
    if(staged) {
      // V2 salary is yuanbao/hour; even rates make each 30-minute settlement exact.
      if(j.salary===0||j.salary%2!==0||!Array.isArray(j.courses)||j.courses.length>p.courses.length
        ||new Set(j.courses).size!==j.courses.length||j.courses.some(id=>!uint(id)||!p.courses.some(c=>c.id===id)))
        throw new TypeError('INVALID_CARE_JOB');
    }else if(!uint(j.course)||(j.course!==0&&!p.courses.some(c=>c.id===j.course)))throw new TypeError('INVALID_CARE_JOB');
  }
  // Detach caller-owned configuration, including nested arrays.
  return JSON.parse(JSON.stringify(p));
}

export class PetCareEconomy {
  #statements=new Map();
  prepare(sql) {
    if(!this.#statements.has(sql))this.#statements.set(sql,this.database.prepare(sql));
    return this.#statements.get(sql);
  }
  constructor({database,policy,desktopTasks,catalogueUpgrades,priceOverrides,functionalPrice,membership,health}) {
    this.membership=membership;this.health=health;
    this.database=database;this.policy=validateCareEconomyPolicy(policy);this.digest=hash(this.policy);
    // A digest difference alone cannot prove what changed: the saved state carries cid, gid
    // and quantity, never the old item definition, so "the state still validates" would also
    // accept a silent price or effect change on an item the save happens not to hold. An
    // upgrade is therefore only taken from an explicitly recorded transition, and any other
    // digest is refused with the state and the recorded digest left untouched.
    this.catalogueUpgrades=normalizeUpgrades(catalogueUpgrades);
    this.staged=['local-care-economy-v2','local-care-economy-v3','local-care-economy-v4'].includes(this.policy.id);
    // Daily-task completion is recorded when a food or cleaning item is used. The toolbar
    // module is built after this one in the assembly order, so the link can also be attached
    // later; either side may be absent.
    if(desktopTasks)this.attachDesktopTasks(desktopTasks);
    // A local price decision lives beside the catalogue, not in it: the catalogue's digest pins a
    // save, so changing a price inside it would invalidate every save rather than only the pricing.
    if(priceOverrides!==undefined&&typeof priceOverrides?.price!=='function')
      throw new TypeError('INVALID_PRICE_OVERRIDES');
    if(functionalPrice!==undefined&&functionalPrice!==10)throw new TypeError('INVALID_FUNCTIONAL_PRICE');
    this.functionalPrice=functionalPrice;
    this.priceOverrides=priceOverrides??null;
    this.items=new Map(this.policy.items.map(i=>[i.cid,i]));
    this.courses=new Map(this.policy.courses.map(c=>[c.id,c]));this.jobs=new Map(this.policy.jobs.map(j=>[j.id,j]));
    database.exec(`CREATE TABLE IF NOT EXISTS pet_care_economy_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      state_json TEXT NOT NULL CHECK(json_valid(state_json))) STRICT;`);
    this.select=database.prepare(`SELECT q.pet_id,q.level_value AS level,q.unknown_0x47 AS hunger,
      q.unknown_0x49 AS cleanliness,q.unknown_0x4b AS health,q.unknown_0x4e AS mood,q.unknown_0x67 AS yuanbao,
      CASE WHEN q.vip_flag=1 THEN q.unknown_0x65 ELSE 0 END AS vipLevel,p.sex AS sex,
      q.status_id AS nativeStatus,q.status_description_bytes AS nativeDescription,q.status_time AS nativeStatusTime
      FROM qqpenguin_login_profile q JOIN pet p ON p.pet_id=q.pet_id WHERE p.uin=? AND q.pet_id_bytes=?`);
  }
  attachDesktopTasks(tasks) {
    if(!tasks||tasks.database!==this.database)throw new TypeError('TOOLBAR_DATABASE_MISMATCH');
    this.desktopTasks=tasks;
  }
  profile(uin,petId) {    const r=this.select.get(uin,petId);
    if(r&&this.policy.id==='local-care-economy-v4'&&this.membership)r.vipLevel=this.membership.get(uin,petId).vip_level;
    if(!r||!uint(r.level,65535)||!uint(r.hunger,65535)||!uint(r.cleanliness,65535)||!uint(r.health,5)
        ||!uint(r.mood,1000)||!uint(r.yuanbao))
      throw new Error('INVALID_CARE_PROFILE');
    const attributes=this.prepare("SELECT attribute_code,value FROM pet_attribute WHERE pet_id=? AND attribute_code IN ('strength','intelligence','charm')").all(r.pet_id);
    for(const key of ['strength','intelligence','charm'])r[key]=attributes.find(a=>a.attribute_code===key)?.value??0;
    return r;
  }
  initialize(uin,petId) {
    const r=this.profile(uin,petId);
    this.prepare('INSERT OR IGNORE INTO pet_care_economy_v1 VALUES(?,?,?)').run(r.pet_id,this.digest,
      JSON.stringify({inventory:[],nextGid:1,courses:{},activity:null,lastNonce:null,lastHash:null,lastReply:null}));
    this.upgradeCatalogue(r.pet_id);
    this.load(r.pet_id);
  }
  // The only accepted way for a stored digest to differ from this catalogue's: a recorded
  // transition that names both digests. Everything else is refused before any write, so a
  // rejected upgrade leaves both the recorded digest and the business state exactly as they
  // were. The state is still validated afterwards, so a transition whose new catalogue cannot
  // describe the save fails too.
  //
  // A save may also be several declared generations behind: a pet that never came online while
  // the catalogue moved A→B→C still holds A. The walk follows declared hops only — an unknown
  // digest or a dead end is the same refusal as before — and the business state is validated
  // once against this catalogue before the digest is moved.
  upgradeCatalogue(petId) {
    const row=this.prepare('SELECT * FROM pet_care_economy_v1 WHERE pet_id=?').get(petId);
    if(!row||row.policy_digest===this.digest)return false;
    declaredPath(row.policy_digest,this.digest,this.catalogueUpgrades);
    const s=JSON.parse(row.state_json);this.validate(s);
    this.prepare('UPDATE pet_care_economy_v1 SET policy_digest=? WHERE pet_id=?').run(this.digest,petId);
    return true;
  }
  load(petId) {
    const row=this.prepare('SELECT * FROM pet_care_economy_v1 WHERE pet_id=?').get(petId);
    if(row?.policy_digest!==this.digest)throw new Error('CARE_POLICY_CHANGED');
    const s=JSON.parse(row.state_json);this.validate(s);
    // Add a bounded receipt history without resetting existing inventory/activity.
    if(!Object.hasOwn(s,'receipts'))s.receipts=s.lastNonce===null?[]:[{nonce:s.lastNonce,hash:s.lastHash,reply:s.lastReply}];
    return s;
  }
  validate(s) {
    const bad=()=>{throw new Error('INVALID_CARE_SAVED_STATE');};
    if(!exact(s,['inventory','nextGid','courses','activity','lastNonce','lastHash','lastReply',...(Object.hasOwn(s??{},'receipts')?['receipts']:[])])
      ||!uint(s.nextGid)||s.nextGid===0||!Array.isArray(s.inventory)||s.inventory.length>this.items.size
      ||!s.courses||typeof s.courses!=='object'||Array.isArray(s.courses))bad();
    if(new Set(s.inventory.map(i=>i?.cid)).size!==s.inventory.length||new Set(s.inventory.map(i=>i?.gid)).size!==s.inventory.length)bad();
    for(const i of s.inventory)if(!exact(i,['cid','gid','quantity',...(Object.hasOwn(i,'usesLeft')?['usesLeft']:[])])||!this.items.has(i.cid)||!uint(i.gid)
        ||(i.usesLeft!==undefined&&(!isToy(this.items.get(i.cid))||!uint(i.usesLeft,5)||!i.usesLeft))
        ||i.gid===0||i.gid>=s.nextGid||!uint(i.quantity,9999)||i.quantity===0)bad();
    for(const [id,n] of Object.entries(s.courses))if(!this.courses.has(Number(id))||String(Number(id))!==id||!uint(n,this.courses.get(Number(id)).period))bad();
    if(this.staged)for(const [id,n] of Object.entries(s.courses)) {
      const c=this.courses.get(Number(id));
      if(n>0&&c.prerequisite&&!this.graduated(s,c.prerequisite))bad();
    }
    if(s.activity!==null) {
      const a=s.activity,catalog=a?.kind==='study'?this.courses:this.jobs;
      if(!exact(a,['kind','id','born','count','settled'])||!['study','work'].includes(a.kind)||!catalog.has(a.id)
        ||!uint(a.born,4294967295000)||!uint(a.count,2)||a.count===0||!uint(a.settled,a.count)
        ||(a.kind==='study'&&a.count!==1))bad();
      if(this.staged&&(a.kind==='study'?!this.canStudy(s,catalog.get(a.id)):!this.jobQualified(s,catalog.get(a.id))))bad();
    }
    if(s.lastNonce===null) {if(s.lastHash!==null||s.lastReply!==null)bad();}
    else if(!validCareNonce(s.lastNonce)||! /^[a-f0-9]{64}$/.test(s.lastHash)||!s.lastReply
      ||typeof s.lastReply!=='object'||![0,1].includes(s.lastReply.result)||s.lastReply.ret!==s.lastReply.result)bad();
    if(Object.hasOwn(s,'receipts')) {
      if(!Array.isArray(s.receipts)||s.receipts.length>64||new Set(s.receipts.map(r=>r?.nonce)).size!==s.receipts.length)bad();
      for(const r of s.receipts)if(!exact(r,['nonce','hash','reply'])||!validCareNonce(r.nonce)
        ||! /^[a-f0-9]{64}$/.test(r.hash)||!r.reply||typeof r.reply!=='object'
        ||![0,1].includes(r.reply.result)||r.reply.ret!==r.reply.result)bad();
    }
  }
  save(petId,s) {
    this.validate(s);
    this.prepare('UPDATE pet_care_economy_v1 SET state_json=? WHERE pet_id=?').run(JSON.stringify(s),petId);
  }
  // Reserve durable identities for another inventory in the same checkpoint.
  // Gaps are valid care state; no foreign item enters its catalogue or digest.
  reserveInventoryIds(uin,petId,count) {
    if(!uint(count,32))throw new TypeError('INVALID_INVENTORY_RESERVATION');
    const r=this.profile(uin,petId),s=this.load(r.pet_id);
    if(s.nextGid+count>MAX)throw new Error('CARE_INVENTORY_ID_EXHAUSTED');
    const ids=Array.from({length:count},()=>s.nextGid++);
    if(count)this.save(r.pet_id,s);return ids;
  }
  graduated(s,id) {
    const c=this.courses.get(id);
    return (s.courses[id]??0)===c.period;
  }
  canStudy(s,c) {
    return (s.courses[c.id]??0)<c.period&&(!this.staged||c.prerequisite===0||this.graduated(s,c.prerequisite));
  }
  jobCourses(j) {return this.staged?j.courses:(j.course?[j.course]:[]);}
  jobQualified(s,j) {return this.jobCourses(j).every(id=>this.graduated(s,id));}
  activityLoss(uin,petId,onlineMs) {
    if(!this.staged)return undefined;
    const r=this.profile(uin,petId),s=this.load(r.pet_id),a=s.activity;
    const playing=this.activityRules?.toyRemaining(uin,petId,onlineMs)??0;
    if(!a&&playing&&r.health===5)return {kind:'toy',elapsedMs:0,durationMs:playing,rates:{hunger:0,cleanliness:0,mood:0}};
    // Preserved original travel states. This changes their online mood rate;
    // starting a new journey remains owned by the original travel feature.
    if(!a)return this.policy.id==='local-care-economy-v4'&&[3,5].includes(r.nativeStatus)
      ?{kind:'travel',elapsedMs:0,durationMs:4294967295000,rates:{hunger:0,cleanliness:0,mood:0}}:undefined;
    let durationMs=a.kind==='study'?this.courses.get(a.id).seconds*1000:a.count*1800000;
    const member=this.policy.id==='local-care-economy-v4'?this.membership?.get(uin,petId):null;
    if(member?.autoCare&&member.settings[a.kind==='study'?'continuousStudy':'continuousWork']) {
      if(a.kind==='work')durationMs=4294967295000;
      else {
        let course=this.courses.get(a.id);durationMs=0;const seen=new Set();
        while(course&&!seen.has(course.id)) {seen.add(course.id);durationMs+=(course.period-(s.courses[course.id]??0))*course.seconds*1000;
          course=[...this.courses.values()].find(c=>c.prerequisite===course.id&&r.level>=c.level);}
      }
    }
    return {elapsedMs:Math.max(0,onlineMs-a.born),durationMs,
      rates:this.policy.activityLossPerMinute[a.kind],...(['local-care-economy-v3','local-care-economy-v4'].includes(this.policy.id)?{kind:a.kind}:{})};
  }
  addAttribute(petId,attribute,amount) {
    // Generic attributes are durable; Login/Hello do not contain these fields.
    const row=this.prepare('SELECT value FROM pet_attribute WHERE pet_id=? AND attribute_code=?').get(petId,attribute);
    if(row&&!uint(row.value))throw new Error('INVALID_CARE_ATTRIBUTE');
    const value=Math.min(MAX,(row?.value??0)+amount);
    this.prepare(`INSERT INTO pet_attribute(pet_id,attribute_code,value) VALUES(?,?,?)
      ON CONFLICT(pet_id,attribute_code) DO UPDATE SET value=excluded.value`).run(petId,attribute,value);
  }
  // Called in the same transaction as online time and vitals. No offline accrual.
  automaticCare(uin,petId,onlineMs) {
    const events=[];
    if(this.policy.id!=='local-care-economy-v4'||typeof this.membership?.view!=='function')return events;
    const member=this.membership.get(uin,petId);if(!member.autoCare)return events;
    let r=this.profile(uin,petId);
    const record=(event,message)=>{this.membership.log(uin,petId,event,message);
      // Each invocation is one care trigger, even when it needs several items.
      if(!events.some(e=>e.kind===event))events.push({kind:event,...(member.settings.notify?{message}:{})});};
    const useOrBuy=(kind,key,target)=>{
      const ordinary=item=>!item.charm&&!item.intelligence&&!item.strength;
      const eligible=item=>item.class===kind&&item[key]>0&&!item.effectUnresolved&&r.level>=item.minLevel&&(!item.maxLevel||r.level<=item.maxLevel);
      const stock=this.load(r.pet_id).inventory.map(owned=>({owned,item:this.items.get(owned.cid)}))
        .filter(({item})=>eligible(item)&&(member.settings.inventoryPolicy==='all'||member.settings.inventoryPolicy==='ordinary'&&ordinary(item)))
        .sort((a,b)=>Math.abs(target-r[key]-a.item[key])-Math.abs(target-r[key]-b.item[key])||a.item.cid-b.item.cid);
      let chosen=stock[0];
      if(!chosen) {
        const mode=member.settings[kind==='food'?'feedBuyMode':'cleanBuyMode'];
        // The reference's small meal/bath restores at least 180/360. Avoid
        // repeatedly buying novelty items that restore only one point.
        const offers=[...this.items.values()].filter(i=>eligible(i)&&ordinary(i)&&i.price>0&&i[key]>=(kind==='food'?180:360))
          .sort((a,b)=>mode==='small'?a[key]-b[key]||a.price-b.price:Math.abs(target-r[key]-a[key])-Math.abs(target-r[key]-b[key])||a.price-b.price);
        const item=offers.find(i=>this.priceOf(i,r.vipLevel)<=r.yuanbao);if(!item)return false;
        const bought=this.request(uin,petId,onlineMs,{operation:'buy',cid:item.cid,type:item.subkind+1,count:1,pay:'yb'});
        if(bought.data.result!==0)return false;
        chosen={item,owned:this.load(r.pet_id).inventory.find(o=>o.cid===item.cid)};
      }
      const used=this.request(uin,petId,onlineMs,{operation:'use',gid:chosen.owned.gid,type:chosen.item.subkind+1});
      if(used.data.result!==0)return false;
      record(kind==='food'?'auto-feed':'auto-clean','贴心宝贝使用了'+chosen.item.name+'。');r=this.profile(uin,petId);return true;
    };
    if(r.health>0&&r.health<5&&member.settings.autoHeal) {
      let cured=member.settings.preferFreeMedicine&&this.health.freeCare(uin,petId,'medicine').result===0;
      if(!cured) {
        const info=this.health.view(uin,petId),item=[...this.items.values()].find(i=>i.medicineFor===info.medicineFor);
        let owned=item&&this.load(r.pet_id).inventory.find(o=>o.cid===item.cid);
        if(item&&!owned&&this.request(uin,petId,onlineMs,{operation:'buy',cid:item.cid,type:3,count:1,pay:'yb'}).data.result===0)
          owned=this.load(r.pet_id).inventory.find(o=>o.cid===item.cid);
        cured=Boolean(owned&&this.request(uin,petId,onlineMs,{operation:'use',gid:owned.gid,type:3}).data.result===0);
      }
      if(cured)record('auto-heal','贴心宝贝已为宝贝治好疾病。');r=this.profile(uin,petId);
    }
    if(r.health!==5){this.membership.requestExit(uin,petId,'宝贝需要主人照顾，贴心宝贝已暂停照料并安全退出。');return events;}
    const maximum=careMaximum(r.level);
    const scaled=Boolean(this.activityRules),configured=(key,normal,urgent)=>member.settings[key]===30?normal:member.settings[key]===20?urgent:member.settings[key];
    const feedThreshold=maximum*configured('feedPercent',36,24)/100,cleanThreshold=maximum*configured('cleanPercent',72,48)/100;
    for(const [kind,key,percent,low] of [['food','hunger',configured('feedPercent',36,24),720],['clean','cleanliness',configured('cleanPercent',72,48),1080]]) {
      const threshold=scaled?maximum*percent/100:Math.max(low+1,maximum*percent/100);
      if(r[key]>=threshold)continue;
      if(member.settings[kind==='food'?'preferFreeFeed':'preferFreeClean']&&this.health.freeCare(uin,petId,kind==='food'?'feed':'clean').result===0) {
        record(kind==='food'?'auto-feed':'auto-clean','贴心宝贝优先使用了今日粉钻免费服务。');r=this.profile(uin,petId);
      }
      const fill=member.settings[kind==='food'?'feedBuyMode':'cleanBuyMode']==='fill',target=fill?maximum:Math.floor(maximum*(scaled?(kind==='food'?60:90):member.settings.targetPercent)/100);
      for(let attempts=0;r[key]<(scaled?target:fill?target:threshold)&&attempts<64;attempts++)if(!useOrBuy(kind,key,target))break;
    }
    if(scaled?r.hunger<feedThreshold&&r.hunger*100<=maximum*24||r.cleanliness<cleanThreshold&&r.cleanliness*100<=maximum*48:r.hunger<720||r.cleanliness<1080)this.membership.requestExit(uin,petId,'照料用品与元宝不足，宝贝先安全退出，等待主人回来。');
    return events;
  }
  advance(uin,petId,onlineMs,emit=()=>{}) {
    const r=this.profile(uin,petId),s=this.load(r.pet_id);let a=s.activity;
    if(r.health!==5&&this.activityRules)this.activityRules.stopToy(uin,petId);
    if(!a)return false;
    if(this.policy.id==='local-care-economy-v4'&&r.health!==5){s.activity=null;this.save(r.pet_id,s);return true;}
    let cycles=0;
    while(a&&cycles++<1440) {
    const item=(a.kind==='study'?this.courses:this.jobs).get(a.id),period=(a.kind==='study'?item.seconds:1800)*1000;
    const complete=Math.min(a.count,Math.floor(Math.max(0,onlineMs-a.born)/period));
    if(complete>a.settled) {
      if(a.kind==='study') {
        s.courses[a.id]=(s.courses[a.id]??0)+1;
        this.addAttribute(r.pet_id,item.attribute,item.reward);
      }else {
        let salary=0;for(let n=a.settled;n<complete;n++)salary+=item.salary/(this.staged?2:1)*(this.membership?.workMultiplier?.(uin,petId)??1);
        r.yuanbao=Math.min(MAX,r.yuanbao+salary);
        this.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(r.yuanbao,r.pet_id);
      }
      this.desktopTasks?.record(uin,petId,a.kind);
      a.settled=complete;
    }
    if(complete===a.count) {
      const member=this.membership?.get(uin,petId),continuous=member?.autoCare&&member.vip_level>0
        &&member.settings?.[a.kind==='study'?'continuousStudy':'continuousWork'];
      const next=a.kind==='study'?(this.canStudy(s,item)?item:[...this.courses.values()].find(c=>c.prerequisite===item.id&&this.canStudy(s,c)&&r.level>=c.level)):item;
      if(continuous&&next&&r.hunger>=720&&r.cleanliness>=1080) {
        s.activity={kind:a.kind,id:next.id,born:a.born+a.count*period,count:a.kind==='study'?1:a.count,settled:0};
        const message='贴心宝贝继续'+(a.kind==='study'?'学习':'打工')+'：'+next.name;
        this.membership.log(uin,petId,'continue-'+a.kind,message);if(member.settings.notify)emit({kind:'care-notice',message});
      }else s.activity=null;
    }
    if(s.activity===a||s.activity===null)break;a=s.activity;
    }
    this.save(r.pet_id,s);return s.activity===null;
  }
  project(uin,petId,onlineMs) {
    const r=this.profile(uin,petId),a=this.load(r.pet_id).activity;
    const desc=Buffer.alloc(16);
    if(a)Buffer.from((a.kind==='study'?this.courses:this.jobs).get(a.id).descriptionHex,'hex').copy(desc);
    const playing=!a&&r.health===5&&(this.activityRules?.toyRemaining(uin,petId,onlineMs)??0)>0;
    if(playing)Buffer.from('cde6cba3','hex').copy(desc); // 玩耍, GBK
    const travel=!a&&!playing&&this.policy.id==='local-care-economy-v4'&&[3,5].includes(r.nativeStatus)&&r.health===5;
    return {unknown_0x67:r.yuanbao,statusId:a?(a.kind==='study'?2:1):playing?23:travel?r.nativeStatus:0,
      statusDescription:travel?Buffer.from(r.nativeDescription):desc,statusTime:a?Math.floor(Math.max(0,onlineMs-a.born)/1000):playing?Math.floor((300000-this.activityRules.toyRemaining(uin,petId,onlineMs))/1000):travel?r.nativeStatusTime:0};
  }
  // The price a sale and a listing both use.
  priceOf(i,vipLevel=0) {
    if(this.activityRules&&isToy(i))return 800;
    const price=i.class==='functional'&&this.functionalPrice!==undefined&&i.effectsVersion!==2?this.functionalPrice
      :this.priceOverrides?this.priceOverrides.price(i.cid,i.price):i.price;
    return this.policy.id==='local-care-economy-v4'&&vipLevel>0?Math.max(1,Math.floor(price*(vipLevel>=7?70:80)/100)):price;
  }
  // GoodsList ImmediateBuyPane reads itemlist.@sex, then item attributes.
  // This public catalogue contains no account or inventory data. Effective
  // prices are the same ones the atomic market purchase will debit.
  saleCatalogueXml() {
    const category=kind=>'<'+kind+'>'+['gg','mm'].map(sex=>'<itemlist'+friendXmlAttributes({sex})+'>'+
      this.policy.items.filter(i=>i.class===({food:'food',clean:'clean',medic:'medicine'})[kind]
        &&usableItem(i)&&!UNRESOLVED_ITEM(i)&&this.priceOf(i)>0)
        .map(i=>'<item'+friendXmlAttributes({id:i.cid,name:i.name,price:this.priceOf(i),vip_price:this.priceOf(i,1),
          pic:'http://img.pet.qq.com/wp/'+i.pic+'.gif',clean:i.cleanliness,stave:i.hunger})+'/>').join('')+
      '</itemlist>').join('')+'</'+kind+'>';
    return '<?xml version="1.0" encoding="UTF-8"?><data>'+['food','clean','medic'].map(category).join('')+'</data>';
  }
  itemView(i,owned,vipLevel=1) {
    // The PetInfo confirmation establishes this specific card's use. Project
    // that rule without changing the catalogue digest held by existing saves.
    const toy=this.activityRules&&isToy(i);
    const description=isRenameCard(i)?renameCardDescription:toy?'玩具：800元宝，每件可使用5次；每次玩耍5分钟，心情每分钟增加100。'+(owned?'本件剩余'+(owned.usesLeft??5)+'次。':''):i.desc;
    return {cid:i.cid,gid:String(owned?.gid??0),name:i.name,desc:description,info:description,
      level_min:i.minLevel,level_max:i.maxLevel,charm:i.charm,intel:i.intelligence,strong:i.strength,
      clean:i.cleanliness,starve:i.hunger,mood:isRenameCard(i)||toy?0:i.mood,class:i.class,
      pic:i.pic,num:String(owned?.quantity??0),
      price:this.priceOf(i),price_vip:this.priceOf(i,Math.max(1,vipLevel)),sell_pay:'yb',sell_vip:0,
      usable:(usableItem(i)||toy)&&!isRenameCard(i)};
  }
  // Reward delivery into the same inventory the shop and the backpack read. Runs inside
  // the caller's transaction: a rejected grant throws and the whole claim rolls back
  // instead of leaving a half-delivered pack. No price, nonce or receipt is involved -
  // this is the "issue" side of the inventory, never the purchase side, so it can never
  // deduct a balance.
  grant(uin,petId,grants) {
    if(!Array.isArray(grants)||grants.length===0||grants.length>32)throw new TypeError('INVALID_GRANT');
    const r=this.profile(uin,petId),s=this.load(r.pet_id),merged=new Map();
    for(const grant of grants) {
      const i=this.items.get(grant?.cid);
      if(!i||!uint(grant.count,9999)||grant.count===0)throw new TypeError('INVALID_GRANT');
      merged.set(i.cid,(merged.get(i.cid)??0)+grant.count);
    }
    for(const [cid,count] of merged) {
      const owned=s.inventory.find(o=>o.cid===cid);
      if((owned?.quantity??0)+count>9999)throw new TypeError('CARE_INVENTORY_FULL');
      if(s.nextGid===MAX&&!owned)throw new Error('CARE_INVENTORY_ID_EXHAUSTED');
      if(owned)owned.quantity+=count;else s.inventory.push({cid,gid:s.nextGid++,quantity:count});
    }
    this.save(r.pet_id,s);
    return merged;
  }
  // The removal side of the inventory, for an explicit local adjustment. It is deliberately not
  // reachable from the market: a purchase or a use has its own path and its own checks, and this
  // one only ever runs because an operator asked for it inside the caller's transaction.
  revoke(uin,petId,{cid,count}) {
    if(!this.items.has(cid)||!uint(count,9999)||count===0)throw new TypeError('INVALID_REVOKE');
    const r=this.profile(uin,petId),s=this.load(r.pet_id),owned=s.inventory.find(o=>o.cid===cid);
    if(!owned||owned.quantity<count)throw new TypeError('CARE_INVENTORY_INSUFFICIENT');
    owned.quantity-=count;
    if(owned.quantity===0)s.inventory=s.inventory.filter(o=>o!==owned);
    this.save(r.pet_id,s);
    return owned.quantity;
  }
  // The catalogue view an operator reads: what the item is, what it does, and what it costs now.
  itemSummary(cid) {
    const i=this.items.get(cid);
    if(!i)return null;
    const price=this.priceOf(i);
    return Object.freeze({cid:i.cid,name:i.name,class:i.class,subkind:i.subkind,hunger:i.hunger,
      cleanliness:i.cleanliness,mood:isRenameCard(i)||this.activityRules&&isToy(i)?0:i.mood,charm:i.charm,intelligence:i.intelligence,strength:i.strength,
      minLevel:i.minLevel,maxLevel:i.maxLevel,pic:i.pic,cataloguePrice:i.price,price,
      // An unresolved row is reported as unresolved regardless of any local price: the list and
      // the administrator panel read this instead of inferring sellability from the price.
      effectUnresolved:UNRESOLVED_ITEM(i)&&!(this.activityRules&&isToy(i)),sellable:price>0&&(!UNRESOLVED_ITEM(i)||this.activityRules&&isToy(i)),
      priceSource:price===i.price?'catalogue':'local-override'});
  }
  // The catalogue search the administrator panel reads: an exact cid or a name fragment,
  // bounded. Category and effect values are read-only here by design - they belong to the
  // locked catalogue the saves are pinned to, and a change goes through a policy version, not
  // through this panel.
  searchItems({query='',limit=50}={}) {
    const text=String(query??'').trim(),bounded=Math.min(Math.max(Number(limit)||50,1),200);
    const matches=text.length===0?this.policy.items
      :this.policy.items.filter(i=>String(i.cid)===text||i.name.includes(text));
    return matches.slice(0,bounded).map(i=>this.itemSummary(i.cid));
  }
  // What the account's pet actually holds right now, in the same view the backpack serves.
  inventorySummary(uin,petId) {
    const r=this.profile(uin,petId),s=this.load(r.pet_id);
    return s.inventory.map(i=>this.itemView(this.items.get(i.cid),i));
  }
  searchItems({query='',limit=50}={}) {
    const text=String(query??'').trim();
    const bounded=Math.min(Math.max(Number(limit)||50,1),200);
    const matches=this.policy.items.filter((i)=>text.length===0||i.name.includes(text)||String(i.cid)===text);
    return Object.freeze(matches.slice(0,bounded).map((i)=>this.itemSummary(i.cid)));
  }
  medicineBox(uin,petId) {
    const health=this.health?.view(uin,petId),r=this.profile(uin,petId);
    const medicine=[...this.items.values()].find(i=>i.medicineFor===health?.medicineFor);
    const price=medicine?this.priceOf(medicine,r.vipLevel):0;
    const eligible=!!health?.disease&&!health.dead&&!r.vipLevel&&price>0&&r.yuanbao<price&&r.yuanbao<health.fee;
    return {eligible,medicinePrice:price,doctorFee:health?.fee??0};
  }
  request(uin,petId,onlineMs,q,now) {
    const r=this.profile(uin,petId),s=this.load(r.pet_id);
    if(['shop','store'].includes(q.operation)) {
      // A UI projection, not a persisted catalogue migration: medicine and
      // functional items retain subkind=2 and the existing policy digest.
      const inCategory=i=>q.categoryView==='native-four-tabs'
        ? q.subkind===3 ? i.class==='functional'
          : i.subkind===q.subkind && i.class!=='functional'
        : i.subkind===q.subkind;
      return {data:ok({...(q.operation==='store'&&q.subkind===2?{reliveGame:this.medicineBox(uin,petId).eligible}:{}),data:{yb:r.yuanbao,items:q.operation==='shop'
        ?this.policy.items.filter(inCategory).map(i=>this.itemView(i,undefined,r.vipLevel))
        :s.inventory.filter(i=>inCategory(this.items.get(i.cid))).map(i=>this.itemView(this.items.get(i.cid),i,r.vipLevel))}})};
    }
    if(q.operation==='courses')return {data:ok({list:this.policy.courses.filter(c=>c.level<=r.level&&this.canStudy(s,c))
      .map(c=>({id:c.id,name:c.name,level:c.level,period:c.period,remain:c.period-(s.courses[c.id]??0),
        charm:0,strong:0,intelligence:0,[c.attribute==='strength'?'strong':c.attribute]:c.reward}))})};
    if(q.operation==='jobs')return {data:ok({list:this.policy.jobs.filter(j=>j.level<=r.level).sort((a,b)=>Number(a.name==='宠物王')-Number(b.name==='宠物王')).map(j=>({job_id:j.id,job_name:j.name,
      salary:j.salary,level_need:j.level,course_list:this.jobCourses(j).map(id=>({course_name:this.courses.get(id).name}))}))})};
    // The Flash contract always carries a cache-buster nonce and gets the
    // receipt guarantee. The HTML pages carry no transaction identity at all, so
    // their requests are executed as they arrive and are never deduplicated by
    // content: a later legitimate purchase of the same item must still work.
    let fingerprint=null;
    if(q.nonce!==undefined) {
      if(!validCareNonce(q.nonce))throw new TypeError('CARE_NONCE_INVALID');
      fingerprint=hash(Object.fromEntries(Object.entries(q).filter(([k])=>!['sign','uin','petId'].includes(k))));
      const receipt=s.receipts.find(r=>r.nonce===q.nonce);
      if(receipt)return {data:receipt.hash===fingerprint?receipt.reply:fail('请求标识重复，请重新操作')};
    }
    let data,notify,careAction;
    if(q.operation==='buy') {
      const i=this.items.get(q.cid),owned=s.inventory.find(o=>o.cid===q.cid);
      if(!i||!uint(q.count,9999)||q.count===0||!(q.type===i.subkind+1||(q.type===4&&i.class==='functional')))data=fail('物品或数量不正确');
      // An unresolved entry is refused before any price is consulted: setting a positive local
      // price must not turn a row whose effect is still undecided into a sellable one.
      else if(UNRESOLVED_ITEM(i)&&!(this.activityRules&&isToy(i)))data=fail('此物品的效果尚未确认，暂不可售');
      else if(r.level<i.minLevel||(i.maxLevel!==0&&r.level>i.maxLevel))data=fail('宠物等级不符合要求');
      else if(this.priceOf(i)===0)data=fail('此物品尚未配置本地价格，暂不可售');
      else if(q.pay!=='yb')data=fail('本地商城仅支持元宝购买');
      else if((owned?.quantity??0)+q.count>9999)data=fail('背包数量达到上限');
      else if(r.yuanbao<this.priceOf(i,r.vipLevel)*q.count)data=fail('元宝不足');
      else {
        if(owned)owned.quantity+=q.count;
        else {if(s.nextGid===MAX)throw new Error('CARE_INVENTORY_ID_EXHAUSTED');s.inventory.push({cid:i.cid,gid:s.nextGid++,quantity:q.count});}
        r.yuanbao-=this.priceOf(i,r.vipLevel)*q.count;
        this.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(r.yuanbao,r.pet_id);
        data=ok({yb:r.yuanbao,msg:'购买成功'});notify='attributes';
      }
    }else if(q.operation==='use'||q.operation==='friend-use') {
      const friend=q.operation==='friend-use',recipient=friend?this.profile(q.targetUin,Buffer.from(q.targetPetIdHex,'hex')):r;
      const owned=s.inventory.find(o=>o.gid===q.gid),i=owned&&this.items.get(owned.cid);
      if(!i||!(q.type===i.subkind+1||(q.type===4&&i.class==='functional')))data=fail('背包中没有此物品');
      else if(!usableItem(i)&&!(this.activityRules&&isToy(i)))data=fail('此物品的原版功能未接通，暂不可使用');
      else if(isRenameCard(i))data=fail('请在宠物资料里改名，确认成功后才会消耗改名卡');
      else if(!friend&&this.activityRules&&isToy(i)){
        if(r.health!==5||s.activity||this.activityRules.toyRemaining(uin,petId,onlineMs)>0||this.embrace?.view(uin,petId).active)data=fail('请在宝贝健康、空闲时使用玩具');
        else {const left=(owned.usesLeft??5)-1;if(left)owned.usesLeft=left;
          else {delete owned.usesLeft;if(--owned.quantity===0)s.inventory=s.inventory.filter(o=>o!==owned);}
          this.activityRules.toy(uin,petId,onlineMs);data=ok({msg:'开始玩耍，每分钟心情增加100，持续5分钟'});notify='status';}
      }
      else if(!friend&&i.class==='medicine'&&this.health) {
        const treatment=this.health.treat(uin,petId,i.medicineFor);
        if(!treatment.ok)data=fail(treatment.msg);
        else {if(--owned.quantity===0)s.inventory=s.inventory.filter(o=>o!==owned);
          data=ok({msg:treatment.msg});notify='attributes';careAction=treatment.action;}
      }
      else if(i.class==='medicine'&&!this.health)data=fail('诊疗状态不可用');
      else if(friend&&!['food','clean'].includes(i.class))data=fail('此物品不能用于好友');
      else if(recipient.health===0)data=fail('宠物需要先复活');
      else if(recipient.level<i.minLevel||(i.maxLevel!==0&&recipient.level>i.maxLevel))data=fail('宠物等级不符合要求');
      // A pure mood item at the ceiling is "nothing to do" and costs nothing; when the
      // item also carries the recovery effects of a food or a cleaning item, the total
      // effect decides, so a full mood never blocks a legitimate hunger or cleanliness use.
      else if(i.mood&&!i.hunger&&!i.cleanliness&&recipient.mood>=1000)data=fail('心情已满，无需使用');
      else if(!i.mood&&(i.effectsVersion!==2||!['charm','intelligence','strength'].some(k=>i[k]>0))
        &&(i.hunger?recipient.hunger:recipient.cleanliness)>=careMaximum(recipient.level))data=fail('当前数值已满，无需使用');
      else {
        recipient.hunger=Math.max(0,Math.min(careMaximum(recipient.level),recipient.hunger+i.hunger));
        recipient.cleanliness=Math.max(0,Math.min(careMaximum(recipient.level),recipient.cleanliness+i.cleanliness));
        recipient.mood=Math.min(1000,recipient.mood+(this.activityRules&&['food','clean'].includes(i.class)?20:i.mood));
        this.prepare('UPDATE qqpenguin_login_profile SET unknown_0x47=?,unknown_0x49=?,unknown_0x4e=? WHERE pet_id=?')
          .run(recipient.hunger,recipient.cleanliness,recipient.mood,recipient.pet_id);
        for(const k of ['charm','intelligence','strength'])if(i[k])this.addAttribute(recipient.pet_id,k,i[k]);
        if(--owned.quantity===0)s.inventory=s.inventory.filter(o=>o!==owned);
        // Daily tasks only know the feed and clean events; a functional or medicine item
        // has no task of its own.
        if(!friend&&(i.class==='food'||i.class==='clean'))this.desktopTasks?.record(uin,petId,i.class==='food'?'feed':'clean');
        const loveadd=friend&&this.friends?this.friends.award(uin,petId,q.targetUin,Buffer.from(q.targetPetIdHex,'hex')):0;
        if(friend&&this.friends)this.friends.inbox.record(r.pet_id,recipient.pet_id,1,i.class==='food'?5:4,
          (i.class==='food'?'给你的宠物喂食':'帮你的宠物清洁')+'，爱心指数 +'+loveadd,now);
        data=ok({msg:'使用成功',...(friend?{loveadd}:{})});notify=friend?undefined:'attributes';
        // An event of this successful use, chosen from the resolved catalogue item.
        // Keep it outside the stored HTTP receipt so retries cannot replay an animation.
        if(!friend&&i.class==='food')careAction='feed';
        else if(!friend&&i.class==='clean')careAction='clean';
      }
    }else if(q.operation==='cart') {
      // One settlement for the whole shopping cart. Every line is validated
      // against the catalogue, the merged inventory cap, the integer total and
      // the balance before anything is written; one bad line rejects the order
      // without deducting or delivering anything. Display price, type and name in
      // the client string are not trusted; the catalogue decides identity, price
      // and payment eligibility.
      const merged=new Map();
      let problem=q.pay!==undefined&&q.pay!=='yb'?'本地商城仅支持元宝购买'
        :Array.isArray(q.lines)&&q.lines.length>0&&q.lines.length<=32?null:'购物车最多 32 种物品';
      for(const line of problem?[]:q.lines) {
        const i=this.items.get(line?.cid);
        if(!i||!uint(line.count,99)||line.count===0){problem='物品或数量不正确';break;}
        if(UNRESOLVED_ITEM(i)&&!(this.activityRules&&isToy(i))){problem='此物品的效果尚未确认，暂不可售';break;}
        if(r.level<i.minLevel||(i.maxLevel!==0&&r.level>i.maxLevel)){problem='宠物等级不符合要求';break;}
        if(this.priceOf(i)===0){problem='此物品尚未配置本地价格，暂不可售';break;}
        merged.set(i.cid,(merged.get(i.cid)??0)+line.count);
      }
      let total=0;
      if(!problem&&merged.size>32)problem='购物车最多 32 种物品';
      // cart.js caps a merged line at limit_num too, so the merged count is judged
      // per kind before the wallet or the inventory ceiling is consulted.
      if(!problem)for(const count of merged.values())if(count>99){problem='单项数量超过上限';break;}
      if(!problem)for(const [cid,count] of merged) {
        const i=this.items.get(cid),owned=s.inventory.find(o=>o.cid===cid);
        if((owned?.quantity??0)+count>9999){problem='背包数量达到上限';break;}
        total+=this.priceOf(i,r.vipLevel)*count;
      }
      if(!problem&&!Number.isSafeInteger(total))problem='金额超出范围';
      if(!problem&&r.yuanbao<total)problem='元宝不足';
      if(problem)data=fail(problem);
      else {
        if(s.nextGid+merged.size>MAX)throw new Error('CARE_INVENTORY_ID_EXHAUSTED');
        for(const [cid,count] of merged) {
          const owned=s.inventory.find(o=>o.cid===cid);
          if(owned)owned.quantity+=count;
          else s.inventory.push({cid,gid:s.nextGid++,quantity:count});
        }
        r.yuanbao-=total;
        this.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(r.yuanbao,r.pet_id);
        data=ok({yb:r.yuanbao,msg:'购买成功',total:String(total)});notify='attributes';
      }
    }else if(['study','work'].includes(q.operation)) {
      const c=(q.operation==='study'?this.courses:this.jobs).get(q.id);
      if(!c)data=fail('课程或工作不存在');
      else if((this.activityRules?.toyRemaining(uin,petId,onlineMs)??0)>0)data=fail('请先结束当前玩耍');
      else if(this.embrace?.active(uin,petId))data=fail('请先结束爱的怀抱');
      else if(s.activity)data=fail('请先结束当前学习或打工');
      else if(r.health<5)data=fail('宠物健康后才能学习或打工');
      else if(r.level<c.level)data=fail('宠物等级不足');
      else if(r.hunger*100<careMaximum(r.level)*30||r.cleanliness*100<careMaximum(r.level)*30)data=fail('请先喂食和清洁');
      else if(q.operation==='study'&&(s.courses[c.id]??0)>=c.period)data=fail('此课程已经学完');
      else if(q.operation==='study'&&!this.canStudy(s,c))data=fail('请先完成上一阶段课程');
      else if(q.operation==='work'&&!this.jobQualified(s,c))data=fail('尚未完成所需课程');
      else if(q.operation==='work'&&![1,2].includes(q.count))data=fail('工时不正确');
      else {s.activity={kind:q.operation,id:c.id,born:onlineMs,count:q.operation==='study'?1:q.count,settled:0};data=ok({msg:q.operation==='study'?'开始学习':'开始打工'});notify='status';}
    }else throw new TypeError('CARE_OPERATION_INVALID');
    if(fingerprint!==null) {
      s.lastNonce=q.nonce;s.lastHash=fingerprint;s.lastReply=data;
      s.receipts.push({nonce:q.nonce,hash:fingerprint,reply:data});s.receipts=s.receipts.slice(-64);
    }
    this.save(r.pet_id,s);return {data,notify,...(careAction?{careAction}:{})};
  }
  stop(uin,petId,status) {
    const r=this.profile(uin,petId),s=this.load(r.pet_id);
    // Only the implemented work/study states can be cancelled. An idle reset
    // is idempotent and cannot cancel an activity started after that request.
    if(status===23&&this.activityRules){this.activityRules.stopToy(uin,petId);return true;}
    if(![0,1,2].includes(status))return false;
    if(status===0&&s.activity)return false;
    if(s.activity&&(s.activity.kind==='study'?2:1)!==status)return false;
    s.activity=null;this.save(r.pet_id,s);return true;
  }
}
