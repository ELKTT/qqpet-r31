import {createHash} from 'node:crypto';
import {encodeAutoFeedSuccess} from '../protocol/auto-feed.js';

const DAY=86400000,MAX=0x7fffffff;
export const VIP_THRESHOLDS=Object.freeze([0,300,900,2400,4500,7200,14400]);
export const VIP_PLANS=Object.freeze({trial:{price:200,days:7,rate:15},month:{price:800,months:1,rate:30},year:{price:8000,months:12,rate:90}});
const day=t=>Math.floor((t+8*3600000)/DAY);
const uint=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const defaults=()=>({feedPercent:36,cleanPercent:72,targetPercent:60,continuousStudy:false,continuousWork:false,notify:true,
  autoHeal:false,preferFreeFeed:true,preferFreeClean:true,preferFreeMedicine:true,inventoryPolicy:'all',feedBuyMode:'small',cleanBuyMode:'small'});
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validateTimedMembershipPolicy(p) {
  if(!p||Object.keys(p).sort().join('|')!=='careBelowPercent|careTargetPercent|defaultAutoCare|id|initialVipLevel|permanentVip'
    ||p.id!=='local-timed-vip-care-v2'||p.permanentVip!==false||p.initialVipLevel!==0||p.defaultAutoCare!==false
    ||p.careBelowPercent!==30||p.careTargetPercent!==60)throw new TypeError('INVALID_MEMBERSHIP_POLICY');
  return Object.freeze({...p});
}
function addTerm(start,plan) {
  if(plan.days)return start+plan.days*DAY;
  const offset=8*3600000,d=new Date(start+offset),date=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+plan.months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(date,last));return d.getTime()-offset;
}
export class TimedPetMembership {
  #statements=new Map();
  prepare(sql) {
    if(!this.#statements.has(sql))this.#statements.set(sql,this.database.prepare(sql));
    return this.#statements.get(sql);
  }
  constructor({database,policy,clock=Date.now}) {
    this.database=database;this.policy=validateTimedMembershipPolicy(policy);this.clock=clock;
    database.exec(`CREATE TABLE IF NOT EXISTS pet_membership_v2 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      state_json TEXT NOT NULL CHECK(json_valid(state_json))) STRICT;
      CREATE TABLE IF NOT EXISTS pet_care_log_v1 (
      id INTEGER PRIMARY KEY,pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      time INTEGER NOT NULL,event TEXT NOT NULL,message TEXT NOT NULL) STRICT;`);
    database.exec('CREATE INDEX IF NOT EXISTS pet_care_log_time_v1 ON pet_care_log_v1(time)');
    this.prepare('DELETE FROM pet_care_log_v1 WHERE time<=?').run(this.now()-DAY);
  }
  attachOperations(operations) {
    if(operations?.database!==this.database||!operations.value?.vipPrices)throw new TypeError('VIP_PRICES_REQUIRE_SHARED_OPERATIONS');
    this.operations=operations;
  }
  plans(){return Object.fromEntries(Object.entries(VIP_PLANS).map(([name,plan])=>[name,{...plan,price:this.operations?.value.vipPrices[name]??plan.price}]));}
  identity(uin,petId) {
    const r=this.prepare(`SELECT q.*,p.vip_year_flag FROM qqpenguin_login_profile q JOIN pet p USING(pet_id)
      WHERE p.uin=? AND q.pet_id_bytes=?`).get(uin,petId);
    if(!r)throw new Error('MEMBERSHIP_PROFILE_MISSING');return r;
  }
  now(){const n=this.clock();if(!uint(n,0xffffffff*1000))throw new Error('INVALID_MEMBERSHIP_CLOCK');return n;}
  initialize(uin,petId) {
    const q=this.identity(uin,petId),now=this.now();
    if(!this.prepare('SELECT 1 FROM pet_membership_v2 WHERE pet_id=?').get(q.pet_id)) {
      const oldTable=this.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pet_membership_v1'").get();
      const old=oldTable?this.prepare('SELECT * FROM pet_membership_v1 WHERE pet_id=?').get(q.pet_id):null;
      const legacy=old&&q.vip_flag===1;
      const s={plan:legacy?'legacy':'none',expiresAt:legacy?null:0,growth:legacy?VIP_THRESHOLDS[old.vip_level-1]:0,
        legacyAnnual:Boolean(legacy&&(q.unknown_0x66!==0||q.vip_year_flag!==0)),
        growthRemainder:0,lastGrowthAt:now,autoCare:Boolean(legacy&&old.auto_care),settings:defaults(),
        boostDay:day(now),boostUsedMs:0,boostActive:false,workDay:day(now),workUsed:0,
        doctorDay:day(now),doctorUsed:0,autoExit:false,receipts:[]};
      this.prepare('INSERT INTO pet_membership_v2 VALUES(?,?)').run(q.pet_id,JSON.stringify(s));
    }
    const initialized=this.load(q.pet_id);if(initialized.autoExit){initialized.autoExit=false;this.save(q.pet_id,initialized);}
    this.project(uin,petId);
  }
  load(id) {
    const row=this.prepare('SELECT state_json FROM pet_membership_v2 WHERE pet_id=?').get(id);
    if(!row)throw new Error('INVALID_MEMBERSHIP_STATE');
    const s=JSON.parse(row.state_json);
    // Only missing fields from the previous schema receive defaults.
    if(s.feedUsed===undefined)s.feedUsed=0;if(s.cleanUsed===undefined)s.cleanUsed=0;
    if(s.settings&&typeof s.settings==='object'&&!Array.isArray(s.settings))s.settings={...defaults(),...s.settings};
    if(s.settings){
      if(s.settings.feedPercent===30)s.settings.feedPercent=36;else if(s.settings.feedPercent===20)s.settings.feedPercent=24;
      if(s.settings.cleanPercent===30)s.settings.cleanPercent=72;else if(s.settings.cleanPercent===20)s.settings.cleanPercent=48;
    }
    if(!['none','legacy','trial','month','year'].includes(s.plan)||!(s.expiresAt===null||uint(s.expiresAt,0xffffffff*1000))
      ||!uint(s.growth,MAX)||!uint(s.growthRemainder,DAY-1)||!uint(s.lastGrowthAt,0xffffffff*1000)
      ||!uint(s.boostUsedMs,7200000)||!uint(s.workUsed,5)||!uint(s.doctorUsed,1)||!uint(s.feedUsed,1)||!uint(s.cleanUsed,1)
      ||!['boostDay','workDay','doctorDay'].every(k=>uint(s[k],50000))
      ||['autoCare','boostActive','autoExit'].some(k=>typeof s[k]!=='boolean')||!Array.isArray(s.receipts)||s.receipts.length>64
      ||(s.legacyAnnual!==undefined&&typeof s.legacyAnnual!=='boolean')
      ||s.receipts.some(r=>typeof r?.nonce!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(r.nonce)||! /^[a-f0-9]{64}$/.test(r.hash)
        ||r.result?.result!==0||!uint(r.result.yuanbao,MAX))||new Set(s.receipts.map(r=>r.nonce)).size!==s.receipts.length
      ||!s.settings||!['feedPercent','cleanPercent'].every(k=>Number.isInteger(s.settings[k])&&s.settings[k]>=15&&s.settings[k]<=(k==='cleanPercent'?90:60))
      ||!Number.isInteger(s.settings.targetPercent)||s.settings.targetPercent<60||s.settings.targetPercent>90
      ||Object.keys(s.settings).some(k=>!Object.hasOwn(defaults(),k))
      ||['continuousStudy','continuousWork','notify','autoHeal','preferFreeFeed','preferFreeClean','preferFreeMedicine'].some(k=>typeof s.settings[k]!=='boolean')
      ||!['ordinary','all','buy'].includes(s.settings.inventoryPolicy)||!['small','fill'].includes(s.settings.feedBuyMode)
      ||!['small','fill'].includes(s.settings.cleanBuyMode))throw new Error('INVALID_MEMBERSHIP_STATE');
    if(JSON.stringify(s)!==row.state_json)this.save(id,s);
    return s;
  }
  save(id,s){this.prepare('UPDATE pet_membership_v2 SET state_json=? WHERE pet_id=?').run(JSON.stringify(s),id);}
  active(s,now=this.now()){return s.plan!=='none'&&(s.expiresAt===null||s.expiresAt>now);}
  level(s,now=this.now()){return !this.active(s,now)?0:s.plan==='year'||s.plan==='legacy'&&s.legacyAnnual?7:1+VIP_THRESHOLDS.slice(1).filter(n=>s.growth>=n).length;}
  settle(id,s,now=this.now()) {
    if(now<s.lastGrowthAt)return s;
    const before=JSON.stringify(s);
    const end=s.expiresAt===null?now:Math.min(now,s.expiresAt),rate=VIP_PLANS[s.plan]?.rate??0;
    const value=s.growthRemainder+Math.max(0,end-s.lastGrowthAt)*rate;
    s.growth=Math.min(MAX,s.growth+Math.floor(value/DAY));s.growthRemainder=value%DAY;s.lastGrowthAt=now;
    const today=day(now);
    if(today>s.boostDay){s.boostDay=today;s.boostUsedMs=0;s.boostActive=false;}
    if(today>s.workDay){s.workDay=today;s.workUsed=0;}
    if(today>s.doctorDay){s.doctorDay=today;s.doctorUsed=0;s.feedUsed=0;s.cleanUsed=0;}
    if(!this.active(s,now)){s.autoCare=false;s.boostActive=false;}
    if(JSON.stringify(s)!==before)this.save(id,s);return s;
  }
  get(uin,petId) {
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    return {...s,pet_id:q.pet_id,vip_level:this.level(s),auto_care:Number(s.autoCare),annual:(s.plan==='year'||s.plan==='legacy'&&Boolean(s.legacyAnnual))&&this.active(s)};
  }
  project(uin,petId) {
    const s=this.get(uin,petId),active=s.vip_level>0;
    this.prepare('UPDATE qqpenguin_login_profile SET vip_flag=?,unknown_0x65=?,unknown_0x66=?,auto_feed_flag=? WHERE pet_id=? AND (vip_flag IS NOT ? OR unknown_0x65 IS NOT ? OR unknown_0x66 IS NOT ? OR auto_feed_flag IS NOT ?)')
      .run(Number(active),s.vip_level,Number(s.annual),Number(active&&s.autoCare),s.pet_id,Number(active),s.vip_level,Number(s.annual),Number(active&&s.autoCare));
    this.prepare('UPDATE pet SET vip_level=?,vip_year_flag=? WHERE pet_id=? AND (vip_level IS NOT ? OR vip_year_flag IS NOT ?)').run(s.vip_level,Number(s.annual),s.pet_id,s.vip_level,Number(s.annual));
    return {vipFlag:Number(active),unknown_0x65:s.vip_level,unknown_0x66:Number(s.annual),autoFeedFlag:Number(active&&s.autoCare)};
  }
  purchase(uin,petId,plan,nonce) {
    if(!Object.hasOwn(VIP_PLANS,plan)||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(nonce))throw new TypeError('INVALID_VIP_PURCHASE');
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id)),fingerprint=hash({plan});
    const previous=s.receipts.find(r=>r.nonce===nonce);
    if(previous)return previous.hash===fingerprint?previous.result:{result:1,msg:'请求标识冲突'};
    const offer=this.plans()[plan];
    if(q.unknown_0x67<offer.price)return {result:1,msg:'元宝不足'};
    const now=this.now(),start=this.active(s)&&s.expiresAt!==null?s.expiresAt:now;
    s.plan=plan;s.expiresAt=addTerm(Math.max(now,start),offer);s.lastGrowthAt=now;
    const result={result:0,msg:'粉钻已开通，欢迎来到温暖的小家！',yuanbao:q.unknown_0x67-offer.price};
    s.receipts.push({nonce,hash:fingerprint,result});s.receipts=s.receipts.slice(-64);
    this.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(result.yuanbao,q.pet_id);
    this.save(q.pet_id,s);this.project(uin,petId);return result;
  }
  addGrowth(uin,petId,amount) {
    if(!uint(amount,200))throw new TypeError('INVALID_VIP_GROWTH');
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    if(!this.active(s))return 0;s.growth=Math.min(MAX,s.growth+amount);this.save(q.pet_id,s);return amount;
  }
  enableBoost(uin,petId) {
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    if(!this.active(s)||s.boostUsedMs>=7200000)return {result:1,msg:'粉钻未开通或今日双倍成长时间已用完'};
    s.boostActive=true;this.save(q.pet_id,s);return {result:0,msg:'双倍成长已开启，今天最多陪伴两小时！'};
  }
  takeBoostMs(uin,petId,elapsedMs) {
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    const used=this.active(s)&&s.boostActive?Math.min(elapsedMs,7200000-s.boostUsedMs):0;
    if(used){s.boostUsedMs+=used;if(s.boostUsedMs>=7200000)s.boostActive=false;this.save(q.pet_id,s);}return used;
  }
  workMultiplier(uin,petId) {
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    if(!this.active(s)||s.workUsed>=5)return 1;s.workUsed++;this.save(q.pet_id,s);return 2;
  }
  takeFreeCare(uin,petId,kind) {
    const field={feed:'feedUsed',clean:'cleanUsed',medicine:'doctorUsed'}[kind];
    if(!field)throw new TypeError('INVALID_FREE_CARE_KIND');
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    if(!this.active(s)||s[field])return false;s[field]=1;this.save(q.pet_id,s);return true;
  }
  nativeCareInfo(uin,petId) {
    const s=this.get(uin,petId),max=s.vip_level>0?1:0;
    return {result:0,vip_lvl:s.vip_level,feed:s.feedUsed,feed_max:max,wash:s.cleanUsed,wash_max:max,
      medicine:s.doctorUsed,medicine_max:max,resurrection:0,resurrection_max:0};
  }
  setAutoCare(uin,petId,{enabled}) {
    if(typeof enabled!=='boolean')throw new TypeError('INVALID_AUTO_FEED_STATE');
    const q=this.identity(uin,petId),s=this.settle(q.pet_id,this.load(q.pet_id));
    if(enabled&&(!this.active(s)||q.unknown_0x4b!==5))return encodeAutoFeedSuccess(false);
    s.autoCare=enabled;s.autoExit=false;this.save(q.pet_id,s);this.project(uin,petId);return encodeAutoFeedSuccess(enabled);
  }
  care(uin,petId) {
    // The v4 caretaker uses real backpack items; it never creates free food.
    return {enabled:false,belowPercent:this.policy.careBelowPercent,targetPercent:this.policy.careTargetPercent};
  }
  configure(uin,petId,settings) {
    const q=this.identity(uin,petId),s=this.load(q.pet_id),base=defaults();
    if(!settings||Object.keys(settings).some(k=>!Object.hasOwn(base,k)))throw new TypeError('INVALID_CARE_SETTINGS');
    const next={...s,settings:{...s.settings,...settings}};this.save(q.pet_id,next);
    try{this.load(q.pet_id);}catch(e){this.save(q.pet_id,s);throw new TypeError('INVALID_CARE_SETTINGS');}
    return {result:0,msg:'贴心宝贝设置已保存'};
  }
  log(uin,petId,event,message) {
    const q=this.identity(uin,petId);
    if(!/^[a-z-]{1,32}$/.test(event)||typeof message!=='string'||message.length>200)throw new TypeError('INVALID_CARE_LOG');
    const now=this.now();
    this.prepare('DELETE FROM pet_care_log_v1 WHERE pet_id=? AND time<=?').run(q.pet_id,now-DAY);
    this.prepare('INSERT INTO pet_care_log_v1(pet_id,time,event,message) VALUES(?,?,?,?)').run(q.pet_id,now,event,message);
    this.prepare('DELETE FROM pet_care_log_v1 WHERE pet_id=? AND id NOT IN (SELECT id FROM pet_care_log_v1 WHERE pet_id=? ORDER BY id DESC LIMIT 200)').run(q.pet_id,q.pet_id);
  }
  requestExit(uin,petId,message) {
    const q=this.identity(uin,petId),s=this.load(q.pet_id);s.autoCare=false;s.autoExit=true;this.save(q.pet_id,s);
    this.log(uin,petId,'auto-exit',message);
  }
  logs(uin,petId){const q=this.identity(uin,petId);
    this.prepare('DELETE FROM pet_care_log_v1 WHERE pet_id=? AND time<=?').run(q.pet_id,this.now()-DAY);
    return this.prepare('SELECT time,event,message FROM pet_care_log_v1 WHERE pet_id=? ORDER BY id DESC LIMIT 100').all(q.pet_id);}
  view(uin,petId) {
    const s=this.get(uin,petId);return {active:s.vip_level>0,level:s.vip_level,annual:s.annual,plan:s.plan,expiresAt:s.expiresAt,
      growth:s.growth,nextGrowth:VIP_THRESHOLDS[s.vip_level]??null,autoCare:s.autoCare,settings:s.settings,
      boostRemainingMs:7200000-s.boostUsedMs,boostActive:s.boostActive,workRemaining:5-s.workUsed,
      freeFeedRemaining:1-s.feedUsed,freeCleanRemaining:1-s.cleanUsed,freeDoctorRemaining:1-s.doctorUsed,plans:this.plans(),logs:this.logs(uin,petId)};
  }
}
