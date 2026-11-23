import {createHash,randomBytes} from 'node:crypto';
import {GAMEPLAY_VITALS_ID,validateGameplayRules,gameplayRemainder,validateGameplayRemainder,advanceGameplayVitals,migrateGameplayV4Remainder} from './gameplay-vitals.js';
import {careMaximum,lowCare,proportionalCare} from './pet-care-bands.js';
export {careMaximum} from './pet-care-bands.js';

const MINUTE_MS=60000;
export const MAX_CLIENT_GROWTH=0x7fffffff;
export const growthStart=level=>100*(level+Math.floor(level*(level+1)*(2*level+1)/24));
const remainderKeys=['minuteMs','growth','hunger','cleanliness','mood','health'];
const isV3=policy=>['local-online-vitals-v3',GAMEPLAY_VITALS_ID].includes(policy.id);
const isV2=policy=>policy.id==='local-online-vitals-v2'||isV3(policy);

function uint(value,max) {return Number.isSafeInteger(value)&&value>=0&&value<=max;}
function exactKeys(value,keys) {
  return value && typeof value==='object' && !Array.isArray(value)
    && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}

// No historical rates or implicit defaults. This policy is an explicit C1 input.
export function validateOnlineVitalsPolicy(input) {
  if(input?.id===GAMEPLAY_VITALS_ID) {
    const {gameplay,...previous}=input;
    const base=validateV2Policy({...previous,id:'local-online-vitals-v3'});
    return Object.freeze({...base,id:GAMEPLAY_VITALS_ID,gameplay:validateGameplayRules(gameplay)});
  }
  if(input&&isV2(input))return validateV2Policy(input);
  const keys=['id','hungerLossPerHour','cleanlinessLossPerHour','moodLossPerHour',
    'healthLossPerRiskHour','healthFloor','riskBelowCarePercent','growthPerHourByMood'];
  if(!exactKeys(input,keys)||input.id!=='local-online-vitals-v1'
      || !uint(input.hungerLossPerHour,6000)||input.hungerLossPerHour===0
      || !uint(input.cleanlinessLossPerHour,6000)||input.cleanlinessLossPerHour===0
      || !uint(input.moodLossPerHour,1000)||input.moodLossPerHour===0
      || !uint(input.healthLossPerRiskHour,60)||input.healthLossPerRiskHour===0
      || !uint(input.healthFloor,4)||input.healthFloor<1
      || !uint(input.riskBelowCarePercent,100)||input.riskBelowCarePercent<1
      || !Array.isArray(input.growthPerHourByMood)||input.growthPerHourByMood.length!==5
      || input.growthPerHourByMood.some(v=>!uint(v,1000000))
      || input.growthPerHourByMood[0]!==0
      || input.growthPerHourByMood.some((v,i,a)=>i>0&&v<a[i-1])) {
    throw new TypeError('INVALID_ONLINE_VITALS_POLICY');
  }
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,Array.isArray(input[k])?Object.freeze([...input[k]]):input[k]])));
}

function validateV2Policy(p) {
  const keys=['id','lossPerMinute','lowMoodCareExtra','baseGrowthPerHour','moodPenalties',
    'healthPenalties','careRiskPercent','lowCareGrowthPenalty','healthRiskMinutes','healthFloor',
    ...(isV3(p)?['workLossPerMinuteTenths']:[]),...(Object.hasOwn(p,'moodLossDivisor')?['moodLossDivisor','autoCareMood']:[])];
  if(Object.hasOwn(p,'moodLossDivisor')&&(!isV3(p)||p.moodLossDivisor!==2||p.autoCareMood!==true))throw new TypeError('INVALID_ONLINE_VITALS_POLICY');
  const losses=['hunger','cleanliness','mood'],care=['hunger','cleanliness'];
  const descending=a=>Array.isArray(a)&&a.length===6&&a.every((v,i)=>uint(v,1000000)&&(i===0||v<=a[i-1]))&&a[5]===0;
  if(!exactKeys(p,keys)||!exactKeys(p.lossPerMinute,losses)||!exactKeys(p.careRiskPercent,care)
      ||losses.some(k=>!Array.isArray(p.lossPerMinute[k])||p.lossPerMinute[k].length!==2
        ||p.lossPerMinute[k].some(v=>!uint(v,1000)||v===0)||p.lossPerMinute[k][0]>p.lossPerMinute[k][1])
      ||care.some(k=>!uint(p.careRiskPercent[k],100)||p.careRiskPercent[k]===0)
      ||!uint(p.lowMoodCareExtra,100)||!uint(p.baseGrowthPerHour,1000000)||p.baseGrowthPerHour===0
      ||!descending(p.moodPenalties)||!descending(p.healthPenalties)||!uint(p.lowCareGrowthPenalty,1000000)
      ||!uint(p.healthRiskMinutes,1440)||p.healthRiskMinutes===0||!uint(p.healthFloor,4)||p.healthFloor===0)
    throw new TypeError('INVALID_ONLINE_VITALS_POLICY');
  if(isV3(p)&&(!Array.isArray(p.workLossPerMinuteTenths)||p.workLossPerMinuteTenths.length!==4
      ||p.workLossPerMinuteTenths.some((b,i)=>!exactKeys(b,['minLevel','hunger','cleanliness'])
        ||b.minLevel!==[0,6,12,18][i]||!uint(b.hunger,1000)||b.hunger<20
        ||!uint(b.cleanliness,1000)||b.cleanliness<20)
      ||p.lowMoodCareExtra!==0||care.some(k=>p.lossPerMinute[k].some(v=>v!==2))))
    throw new TypeError('INVALID_ONLINE_VITALS_POLICY');
  return Object.freeze({id:p.id,...(p.moodLossDivisor===2?{moodLossDivisor:2,autoCareMood:true}:{}),
    lossPerMinute:Object.freeze(Object.fromEntries(losses.map(k=>[k,Object.freeze([...p.lossPerMinute[k]])]))),
    lowMoodCareExtra:p.lowMoodCareExtra,baseGrowthPerHour:p.baseGrowthPerHour,
    moodPenalties:Object.freeze([...p.moodPenalties]),healthPenalties:Object.freeze([...p.healthPenalties]),
    careRiskPercent:Object.freeze(Object.fromEntries(care.map(k=>[k,p.careRiskPercent[k]]))),
    lowCareGrowthPenalty:p.lowCareGrowthPenalty,healthRiskMinutes:p.healthRiskMinutes,healthFloor:p.healthFloor,
    ...(isV3(p)?{workLossPerMinuteTenths:Object.freeze(p.workLossPerMinuteTenths.map(b=>
      Object.freeze({minLevel:b.minLevel,hunger:b.hunger,cleanliness:b.cleanliness})))}:{})});
}

function validateState(s) {
  if(!uint(s.level,1000)||!uint(s.growth,MAX_CLIENT_GROWTH)
      ||s.growth<growthStart(s.level)||s.growth>=growthStart(s.level+1)
      ||!uint(s.hunger,careMaximum(s.level))||!uint(s.cleanliness,careMaximum(s.level))
      ||!uint(s.health,5)||!uint(s.mood,1000))throw new Error('INVALID_ONLINE_VITALS_STATE');
}
function validateRemainder(r,policy) {
  if(policy.id===GAMEPLAY_VITALS_ID){
    validateGameplayRemainder(r);
    if(proportionalCare(policy.gameplay)&&((r.riskMs??0)>=10000||r.illnessMs>=300000))throw new Error('INVALID_ONLINE_VITALS_REMAINDER');
    return;
  }
  if(isV2(policy)) {
    if(!exactKeys(r,['minuteMs','growth','rngState','riskMinutes',...(isV3(policy)?['workHunger','workCleanliness']:[]),...(policy.moodLossDivisor===2?['moodHalf']:[])])||!uint(r.minuteMs,MINUTE_MS-1)
        ||(policy.moodLossDivisor===2&&!uint(r.moodHalf,1))
        ||(isV3(policy)&&(!uint(r.workHunger,599999)||!uint(r.workCleanliness,599999)))
        ||!uint(r.growth,59)||!uint(r.rngState,0xffffffff)||!uint(r.riskMinutes,policy.healthRiskMinutes-1))
      throw new Error('INVALID_ONLINE_VITALS_REMAINDER');
    return;
  }
  if(!exactKeys(r,remainderKeys)||!uint(r.minuteMs,MINUTE_MS-1)
      ||remainderKeys.slice(1).some(k=>!uint(r[k],59)))throw new Error('INVALID_ONLINE_VITALS_REMAINDER');
}
const emptyRemainder=()=>Object.fromEntries(remainderKeys.map(k=>[k,0]));
export function createOnlineVitalsRemainder(policy,seed=0) {
  if(policy.id===GAMEPLAY_VITALS_ID){const r=gameplayRemainder(seed);validateGameplayRemainder(r);return r;}
  const r=isV2(policy)?{minuteMs:0,growth:0,rngState:seed,riskMinutes:0,
    ...(isV3(policy)?{workHunger:0,workCleanliness:0}:{}),...(policy.moodLossDivisor===2?{moodHalf:0}:{})}:emptyRemainder();
  validateRemainder(r,policy);return r;
}

function v2CareRisk(s,p) {
  if(proportionalCare(p.gameplay)){const low=lowCare(s,p.gameplay);return low.hunger||low.cleanliness;}
  const maximum=careMaximum(s.level);
  return s.hunger*100<maximum*p.careRiskPercent.hunger||s.cleanliness*100<maximum*p.careRiskPercent.cleanliness;
}

export function onlineGrowthSpeed(s,policy) {
  if(isV2(policy)) {
    if(s.health===0||s.growth===MAX_CLIENT_GROWTH)return 0;
    const band=s.mood<100?0:s.mood<300?1:s.mood<500?2:s.mood<700?3:s.mood<900?4:5;
    const speed=Math.max(0,policy.baseGrowthPerHour-policy.moodPenalties[band]-policy.healthPenalties[s.health]
      -(v2CareRisk(s,policy)?policy.lowCareGrowthPenalty:0));
    return policy.gameplay?.feedbackRules&&s.mood>=900?Math.floor(speed*130/100):speed;
  }
  const risk=careMaximum(s.level)*policy.riskBelowCarePercent/100;
  if(s.health<5||s.hunger<risk||s.cleanliness<risk||s.growth===MAX_CLIENT_GROWTH)return 0;
  const band=s.mood<100?0:s.mood<300?1:s.mood<600?2:s.mood<900?3:4;
  return policy.growthPerHourByMood[band];
}

// Fixed, cumulative online-minute boundaries: checkpoint cadence cannot alter outcomes.
export function advanceOnlineVitals(state,remainder,elapsedMs,policy,autoCare,activityLoss,boostMs=0,embrace) {
  validateState(state);validateRemainder(remainder,policy);
  if(!uint(elapsedMs,0xffffffff*1000))throw new TypeError('INVALID_ONLINE_ELAPSED');
  if(autoCare&&(!isV2(policy)||!exactKeys(autoCare,['enabled','belowPercent','targetPercent'])
      ||typeof autoCare.enabled!=='boolean'||autoCare.belowPercent!==30||autoCare.targetPercent!==60))
    throw new TypeError('INVALID_AUTO_CARE_POLICY');
  if(activityLoss&&(!isV2(policy)||!exactKeys(activityLoss,['elapsedMs','durationMs','rates',...(isV3(policy)?['kind']:[])])
    ||(isV3(policy)&&(!(policy.id===GAMEPLAY_VITALS_ID?['study','work','travel','toy']:['study','work']).includes(activityLoss.kind)||activityLoss.rates?.hunger!==0||activityLoss.rates?.cleanliness!==0))
    ||!uint(activityLoss.elapsedMs,0xffffffff*1000)||!uint(activityLoss.durationMs,policy.id===GAMEPLAY_VITALS_ID?0xffffffff*1000:86400000)
    ||activityLoss.durationMs===0||!exactKeys(activityLoss.rates,['hunger','cleanliness','mood'])
    ||Object.values(activityLoss.rates).some(n=>!uint(n,100))))throw new TypeError('INVALID_ACTIVITY_LOSS');
  if(embrace&&(!exactKeys(embrace,['elapsedMs','active'])||!uint(embrace.elapsedMs,elapsedMs)||typeof embrace.active!=='boolean'))throw new TypeError('INVALID_EMBRACE_INTERVAL');
  if(policy.id===GAMEPLAY_VITALS_ID)return advanceGameplayVitals(state,remainder,elapsedMs,policy,activityLoss,boostMs,embrace?.elapsedMs??0,embrace?.active??false);
  if(isV2(policy))return advanceV2(state,remainder,elapsedMs,policy,autoCare,activityLoss);
  const s={...state},r={...remainder};
  let minutes=Math.floor((r.minuteMs+elapsedMs)/MINUTE_MS);
  r.minuteMs=(r.minuteMs+elapsedMs)%MINUTE_MS;
  const loss=(key,rate,floor=0)=>{
    if(s[key]<=floor){r[key]=0;return;}
    const total=r[key]+rate;
    s[key]=Math.max(floor,s[key]-Math.floor(total/60));
    r[key]=s[key]===floor?0:total%60;
  };
  while(minutes-->0) {
    // Once all decreasing values reach their floors, remaining minutes have no effect.
    if(s.hunger===0&&s.cleanliness===0&&s.mood===0&&s.health<=policy.healthFloor)break;
    const speed=onlineGrowthSpeed(s,policy),total=r.growth+speed;
    s.growth=Math.min(MAX_CLIENT_GROWTH,s.growth+Math.floor(total/60));
    r.growth=s.growth===MAX_CLIENT_GROWTH?0:total%60;
    const risk=careMaximum(s.level)*policy.riskBelowCarePercent/100;
    if(s.hunger<risk||s.cleanliness<risk)loss('health',policy.healthLossPerRiskHour,policy.healthFloor);
    loss('hunger',policy.hungerLossPerHour);
    loss('cleanliness',policy.cleanlinessLossPerHour);
    loss('mood',policy.moodLossPerHour);
    while(s.growth>=growthStart(s.level+1))s.level++;
  }
  validateState(s);validateRemainder(r,policy);
  return {state:s,remainder:r,growthSpeed:onlineGrowthSpeed(s,policy)};
}

// Non-security PRNG: independent of identity and committed with the state it changes.
// Equal-sized buckets plus rejection avoid the reference's rounded-endpoint bias.
function drawLoss(r,[minimum,maximum]) {
  const width=maximum-minimum+1,bucket=Math.floor(0x100000000/width);
  do {r.rngState=(Math.imul(r.rngState,1664525)+1013904223)>>>0;}
  while(r.rngState>=bucket*width);
  return minimum+Math.floor(r.rngState/bucket);
}

function advanceV2(state,remainder,elapsedMs,p,autoCare,activityLoss) {
  const s={...state},r={...remainder};
  let boundary=MINUTE_MS-r.minuteMs,chargedOffset=0;
  const chargeActivity=offset=>{
    if(activityLoss&&s.health!==0) {
      const {rates,durationMs}=activityLoss,start=activityLoss.elapsedMs;
      if(isV3(p)&&activityLoss.kind==='work') {
        const worked=Math.min(durationMs,start+offset)-Math.min(durationMs,start+chargedOffset);
        const band=p.workLossPerMinuteTenths.findLast(b=>s.level>=b.minLevel);
        for(const [key,fraction] of [['hunger','workHunger'],['cleanliness','workCleanliness']]) {
          // Base care loss is already 2/min. Retain subpoints across queries and restarts.
          const total=r[fraction]+worked*(band[key]-20);
          s[key]=Math.max(0,s[key]-Math.floor(total/600000));r[fraction]=total%600000;
        }
      }
      for(const key of ['hunger','cleanliness','mood']) {
        const divisor=key==='mood'?(p.moodLossDivisor??1):1;
        const total=t=>Math.floor(Math.min(durationMs,start+t)*rates[key]/(MINUTE_MS*divisor));
        s[key]=Math.max(0,s[key]-(total(offset)-total(chargedOffset)));
      }
    }
    chargedOffset=offset;
  };
  let minutes=Math.floor((r.minuteMs+elapsedMs)/MINUTE_MS);
  r.minuteMs=(r.minuteMs+elapsedMs)%MINUTE_MS;
  const grow=(speed,count=1)=>{
    const total=r.growth+speed*count;
    s.growth=Math.min(MAX_CLIENT_GROWTH,s.growth+Math.floor(total/60));
    r.growth=s.growth===MAX_CLIENT_GROWTH?0:total%60;
    while(s.growth>=growthStart(s.level+1))s.level++;
  };
  while(minutes>0) {
    // Charge at the same absolute minute boundaries as growth and auto-care,
    // including fractional activity time before/after a boundary.
    chargeActivity(boundary);boundary+=MINUTE_MS;
    // Dead pets pause all vitals. Online time still advances, without deferred debt.
    if(s.health===0){r.riskMinutes=0;break;}
    const speed=onlineGrowthSpeed(s,p);
    // Exhausted pets make no random draws; this also bounds large clock advances.
    if(!autoCare?.enabled&&s.hunger===0&&s.cleanliness===0&&s.mood===0&&s.health<=p.healthFloor
        &&!(isV3(p)&&activityLoss&&activityLoss.elapsedMs+chargedOffset<activityLoss.durationMs)) {
      r.riskMinutes=0;grow(speed,minutes);break;
    }
    const risk=v2CareRisk(s,p),extra=s.mood<600?p.lowMoodCareExtra:0;
    grow(speed);
    // Consecutive risk minutes, counted once even when both care values are low.
    if(risk&&s.health>p.healthFloor) {
      if(++r.riskMinutes===p.healthRiskMinutes){s.health--;r.riskMinutes=0;}
    }else r.riskMinutes=0;
    s.hunger=Math.max(0,s.hunger-drawLoss(r,p.lossPerMinute.hunger)-extra);
    s.cleanliness=Math.max(0,s.cleanliness-drawLoss(r,p.lossPerMinute.cleanliness)-extra);
    const moodDraw=drawLoss(r,p.lossPerMinute.mood);
    if(p.moodLossDivisor===2){const half=r.moodHalf+moodDraw;s.mood=Math.max(0,s.mood-Math.floor(half/2));r.moodHalf=half%2;}
    else s.mood=Math.max(0,s.mood-moodDraw);
    if(autoCare?.enabled) {
      const maximum=careMaximum(s.level);
      for(const key of ['hunger','cleanliness']) {
        if(s[key]*100<maximum*autoCare.belowPercent)s[key]=Math.floor(maximum*autoCare.targetPercent/100);
      }
      if(p.autoCareMood&&s.mood<10*autoCare.belowPercent)s.mood=10*autoCare.targetPercent;
    }
    minutes--;
  }
  chargeActivity(elapsedMs);
  validateState(s);validateRemainder(r,p);
  return {state:s,remainder:r,growthSpeed:onlineGrowthSpeed(s,p)};
}

export class OnlinePetState {
  #statements=new Map();
  prepare(sql) {
    if(!this.#statements.has(sql))this.#statements.set(sql,this.database.prepare(sql));
    return this.#statements.get(sql);
  }
  constructor({database,policy,seedFactory=()=>randomBytes(4).readUInt32LE(),membership}) {
    this.database=database;this.policy=validateOnlineVitalsPolicy(policy);
    if(membership&&(membership.database!==database||!isV2(this.policy)))throw new TypeError('MEMBERSHIP_REQUIRES_SHARED_V2_VITALS');
    this.membership=membership;
    if(typeof seedFactory!=='function')throw new TypeError('INVALID_VITALS_SEED_FACTORY');
    this.seedFactory=seedFactory;
    this.policyDigest=createHash('sha256').update(JSON.stringify(this.policy)).digest('hex');
    database.exec(`CREATE TABLE IF NOT EXISTS online_pet_vitals_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      remainder_json TEXT NOT NULL CHECK(json_valid(remainder_json))) STRICT;`);
    this.select=database.prepare(`SELECT q.pet_id,q.level_value AS level,q.unknown_0x61 AS growth,
      q.unknown_0x47 AS hunger,q.unknown_0x49 AS cleanliness,q.unknown_0x4b AS health,q.unknown_0x4e AS mood
      FROM qqpenguin_login_profile q JOIN pet p ON p.pet_id=q.pet_id WHERE p.uin=? AND q.pet_id_bytes=?`);
  }
  initialize(uin,petId) {
    const row=this.select.get(uin,petId);
    if(!row)throw new Error('ONLINE_VITALS_PROFILE_MISSING');
    validateState(row);
    const existing=this.prepare('SELECT policy_digest,remainder_json FROM online_pet_vitals_v1 WHERE pet_id=?').get(row.pet_id);
    if(existing) {
      if(existing.policy_digest!==this.policyDigest) {
        if(this.policy.id===GAMEPLAY_VITALS_ID&&this.policy.gameplay.feedbackRules?.revision===2
          &&[this.policy.gameplay.feedbackRules.previousDigest,this.policy.gameplay.feedbackRules.previousRuntimeDigest].includes(existing.policy_digest)){
          const old=JSON.parse(existing.remainder_json);validateGameplayRemainder(old);
          const next={...old,riskMs:0,illnessMs:Math.floor(old.illnessMs/3)};
          this.prepare('UPDATE online_pet_vitals_v1 SET policy_digest=?,remainder_json=? WHERE pet_id=? AND policy_digest=?')
            .run(this.policyDigest,JSON.stringify(next),row.pet_id,existing.policy_digest);
          existing.remainder_json=JSON.stringify(next);
        } else if(this.policy.id===GAMEPLAY_VITALS_ID&&(existing.policy_digest===this.policy.gameplay.previousBalanceDigest||existing.policy_digest===this.policy.gameplay.feedbackRules?.previousDigest)) {
          const old=JSON.parse(existing.remainder_json);validateGameplayRemainder(old);
          const next={riskMs:0,...old,...(proportionalCare(this.policy.gameplay)?{riskMs:0,illnessMs:Math.floor(old.illnessMs/3)}:{})};
          this.prepare('UPDATE online_pet_vitals_v1 SET policy_digest=?,remainder_json=? WHERE pet_id=? AND policy_digest=?')
            .run(this.policyDigest,JSON.stringify(next),row.pet_id,existing.policy_digest);
          existing.remainder_json=JSON.stringify(next);
        } else if(this.policy.id===GAMEPLAY_VITALS_ID&&existing.policy_digest===this.policy.gameplay.previousGameplayDigest) {
          const next=migrateGameplayV4Remainder(JSON.parse(existing.remainder_json));
          this.prepare('UPDATE online_pet_vitals_v1 SET policy_digest=?,remainder_json=? WHERE pet_id=? AND policy_digest=?')
            .run(this.policyDigest,JSON.stringify(next),row.pet_id,existing.policy_digest);
          existing.remainder_json=JSON.stringify(next);
        } else if(this.policy.id===GAMEPLAY_VITALS_ID&&existing.policy_digest===this.policy.gameplay.previousDigest) {
          const prior={...this.policy,id:'local-online-vitals-v3'};delete prior.gameplay;
          const old=JSON.parse(existing.remainder_json);validateRemainder(old,validateOnlineVitalsPolicy(prior));
          const next=gameplayRemainder(old.rngState);
          next.growth=(old.growth??0)*60000;next.disease=row.health<5&&row.health>0?'cold':null;
          validateGameplayRemainder(next);
          this.prepare('UPDATE online_pet_vitals_v1 SET policy_digest=?,remainder_json=? WHERE pet_id=? AND policy_digest=?')
            .run(this.policyDigest,JSON.stringify(next),row.pet_id,existing.policy_digest);
          existing.policy_digest=this.policyDigest;existing.remainder_json=JSON.stringify(next);
        } else {
        // Explicit, one-way user-approved mood tuning. Only the exact policy with
        // these two fields removed is eligible; never accept arbitrary drift.
        const previous={...this.policy};delete previous.moodLossDivisor;delete previous.autoCareMood;
        const prior=validateOnlineVitalsPolicy(previous);
        const priorDigest=createHash('sha256').update(JSON.stringify(prior)).digest('hex');
        if(this.policy.moodLossDivisor!==2||existing.policy_digest!==priorDigest)throw new Error('ONLINE_VITALS_POLICY_CHANGED');
        const old=JSON.parse(existing.remainder_json);validateRemainder(old,prior);
        const next={...old,moodHalf:0};validateRemainder(next,this.policy);
        // One atomic statement; the caller's online-clock transaction can roll it back.
        const updated=this.prepare('UPDATE online_pet_vitals_v1 SET policy_digest=?,remainder_json=? WHERE pet_id=? AND policy_digest=?')
          .run(this.policyDigest,JSON.stringify(next),row.pet_id,priorDigest);
        if(updated.changes!==1)throw new Error('ONLINE_VITALS_POLICY_CHANGED');
        existing.remainder_json=JSON.stringify(next);
        }
      }
      validateRemainder(JSON.parse(existing.remainder_json),this.policy);
    } else {
      const remainder=createOnlineVitalsRemainder(this.policy,isV2(this.policy)?this.seedFactory():0);
      this.prepare('INSERT INTO online_pet_vitals_v1 VALUES(?,?,?)').run(row.pet_id,this.policyDigest,JSON.stringify(remainder));
    }
  }
  // Caller owns the same transaction that advances original_online_time_v1.
  nextGameplaySpan(petId,remaining){
    const saved=this.prepare('SELECT remainder_json FROM online_pet_vitals_v1 WHERE pet_id=?').get(petId.readBigUInt64LE().toString());
    if(!saved)throw new Error('ONLINE_VITALS_STATE_MISSING');
    const r=JSON.parse(saved.remainder_json);validateGameplayRemainder(r);
    return Math.min(remaining,3000-r.tickMs);
  }
  advance(uin,petId,elapsedMs,activityLoss,embrace) {
    const row=this.select.get(uin,petId);
    if(!row)throw new Error('ONLINE_VITALS_PROFILE_MISSING');
    const saved=this.prepare('SELECT policy_digest,remainder_json FROM online_pet_vitals_v1 WHERE pet_id=?').get(row.pet_id);
    if(saved?.policy_digest!==this.policyDigest)throw new Error('ONLINE_VITALS_POLICY_CHANGED');
    const boostMs=row.health>0?(this.membership?.takeBoostMs?.(uin,petId,elapsedMs)??0):0;
    const next=advanceOnlineVitals(row,JSON.parse(saved.remainder_json),elapsedMs,this.policy,this.membership?.care(uin,petId),activityLoss,boostMs,embrace);
    const s=next.state;
    this.prepare(`UPDATE qqpenguin_login_profile SET level_value=?,unknown_0x61=?,unknown_0x47=?,
      unknown_0x49=?,unknown_0x4b=?,unknown_0x4e=? WHERE pet_id=?`).run(s.level,s.growth,s.hunger,s.cleanliness,s.health,s.mood,row.pet_id);
    this.prepare('UPDATE pet SET level=?,growth=? WHERE pet_id=?').run(s.level,s.growth,row.pet_id);
    this.prepare('UPDATE online_pet_vitals_v1 SET remainder_json=? WHERE pet_id=?').run(JSON.stringify(next.remainder),row.pet_id);
    return {levelValue:s.level,unknown_0x61:s.growth,unknown_0x47:s.hunger,unknown_0x49:s.cleanliness,
      unknown_0x4b:s.health,unknown_0x4e:s.mood,growthSpeed:next.growthSpeed,...(next.events?{events:next.events}:{})};
  }
}
