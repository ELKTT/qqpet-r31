import {growthStart,onlineGrowthSpeed,MAX_CLIENT_GROWTH} from './online-pet-state.js';
import {lowCare,proportionalCare} from './pet-care-bands.js';

export const GAMEPLAY_VITALS_ID='local-online-vitals-v5';
export const DISEASES=Object.freeze({
  cold:['肺炎','重感冒','发烧','感冒'],cough:['肺结核','哮喘','支气管炎','咳嗽'],stomach:['胃癌','胃溃疡','胃炎','肚子胀'],
});
const uint=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
export function validateGameplayRules(g) {
  if(proportionalCare(g)){
    const keys=['checkMs','carePercent','playLossPerMinute','oneRiskBasisPoints','bothRiskBasisPoints','progressionCheckMs','progressionRiskBasisPoints','previousDigest','previousGameplayDigest','riskGraceMs','previousBalanceDigest','feedbackRules'];
    const f=g.feedbackRules,digest=s=>/^[a-f0-9]{64}$/.test(s);
    if(Object.keys(g).sort().join('|')!==keys.sort().join('|')||g.checkMs!==10000||g.carePercent?.hunger!==24||g.carePercent?.cleanliness!==48||Object.keys(g.carePercent).length!==2
      ||g.playLossPerMinute?.hunger!==4||g.playLossPerMinute?.cleanliness!==4||Object.keys(g.playLossPerMinute).length!==2
      ||g.oneRiskBasisPoints!==50||g.bothRiskBasisPoints!==150||g.progressionCheckMs!==300000||g.progressionRiskBasisPoints!==200||g.riskGraceMs!==0
      ||Object.keys(f).sort().join('|')!=='previousDigest|previousRuntimeDigest|revision'
      ||![g.previousDigest,g.previousGameplayDigest,g.previousBalanceDigest,f.previousDigest,f.previousRuntimeDigest].every(digest))throw new TypeError('INVALID_GAMEPLAY_VITALS_POLICY');
    return Object.freeze({...g});
  }
  const keys=['checkMs','lowHunger','lowCleanliness','oneRiskBasisPoints','bothRiskBasisPoints','progressionCheckMs','progressionRiskBasisPoints','previousDigest','previousGameplayDigest',...(Object.hasOwn(g??{},'riskGraceMs')?['riskGraceMs','previousBalanceDigest']:[]),...(Object.hasOwn(g??{},'feedbackRules')?['feedbackRules']:[])];
  if(!g||Object.keys(g).length!==keys.length||keys.some(k=>!Object.hasOwn(g,k))
    ||g.checkMs!==3000||g.lowHunger!==720||g.lowCleanliness!==1080||(g.riskGraceMs===undefined?(g.oneRiskBasisPoints!==50||g.bothRiskBasisPoints!==150):(g.riskGraceMs!==600000||g.oneRiskBasisPoints!==5||g.bothRiskBasisPoints!==15||!/^[a-f0-9]{64}$/.test(g.previousBalanceDigest)))
    ||g.progressionCheckMs!==900000||g.progressionRiskBasisPoints!==200
    ||![g.previousDigest,g.previousGameplayDigest].every(d=>/^[a-f0-9]{64}$/.test(d)))throw new TypeError('INVALID_GAMEPLAY_VITALS_POLICY');
  if(g.feedbackRules&&(Object.keys(g.feedbackRules).sort().join('|')!=='previousDigest|revision'||g.feedbackRules.revision!==1||!/^[a-f0-9]{64}$/.test(g.feedbackRules.previousDigest)))throw new TypeError('INVALID_GAMEPLAY_VITALS_POLICY');
  return Object.freeze({...g});
}
export function gameplayRemainder(seed=0) {
  return {tickMs:0,growth:0,rngState:seed,hungerUnits:0,cleanUnits:0,moodUnits:0,disease:null,illnessMs:0,noticeMs:0,boostMs:0,embraceMs:0,riskMs:0};
}
export function validateGameplayRemainder(r) {
  const keys=Object.keys(gameplayRemainder()).filter(k=>!['embraceMs','riskMs'].includes(k)||Object.hasOwn(r??{},k));
  if(!r||Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k))
    ||!uint(r.tickMs,2999)||!uint(r.growth,3599999)||!uint(r.rngState,0xffffffff)
    ||!uint(r.hungerUnits,1200000)||!uint(r.cleanUnits,1200000)||!Number.isSafeInteger(r.moodUnits)||Math.abs(r.moodUnits)>720000
    ||!(r.disease===null||Object.hasOwn(DISEASES,r.disease))||!uint(r.illnessMs,899999)||!uint(r.noticeMs,60000)||!uint(r.boostMs,3000)
    ||!uint(r.embraceMs??0,3000)||!uint(r.riskMs??0,600000))
    throw new Error('INVALID_ONLINE_VITALS_REMAINDER');
}
export function migrateGameplayV4Remainder(old) {
  if(!old||!Object.hasOwn(old,'overfedMs')||Object.hasOwn(old,'illnessMs')||!uint(old.overfedMs))throw new Error('INVALID_ONLINE_VITALS_REMAINDER');
  const {overfedMs,...rest}=old,next={...rest,illnessMs:0};validateGameplayRemainder(next);return next;
}
function draw(r,n) {
  const boundary=Math.floor(0x100000000/n)*n;
  do{r.rngState=(Math.imul(r.rngState,1664525)+1013904223)>>>0;}while(r.rngState>=boundary);
  return r.rngState%n;
}
export const chooseDisease=r=>Object.keys(DISEASES)[draw(r,3)];
// ActionPlayer FeelingSystem uses 900..1000 for excited and 600..899 for
// happy. This approved rule changes the durable mood, not the animation table.
export function applyAdultLowCareMood(state,gameplay) {
  const low=lowCare(state,gameplay);
  if(state.level>=10&&state.health>0&&state.mood>=900
    &&(low.hunger||low.cleanliness))state.mood=899;
  return state;
}
// Care/growth retains the persisted 3-second clock. Revision 2 uses independent
// 10-second risk and 5-minute progression clocks; checkpoints cannot add rolls.
export function advanceGameplayVitals(state,remainder,elapsedMs,p,activity,boostMs=0,embraceMs=0,embraceActive=false) {
  validateGameplayRemainder(remainder);
  const s={...state},r={embraceMs:0,riskMs:0,...remainder},events=[];let offset=0;
  applyAdultLowCareMood(s,p.gameplay);
  const emit=event=>{if(events.length<100)events.push(event);};
  const alive=()=>s.health>0&&s.hunger>0&&s.cleanliness>0&&s.mood>0;
  const die=()=>{if(s.health!==0)emit({kind:'death'});s.health=0;r.noticeMs=0;r.boostMs=0;r.embraceMs=0;r.riskMs=0;};
  if(!alive())die();
  while(offset<elapsedMs) {
    if(!alive()){r.tickMs=(r.tickMs+elapsedMs-offset)%3000;break;}
    const sick=s.health<5,g=p.gameplay;
    if(!sick){r.illnessMs=0;r.disease=null;}
    const scaled=proportionalCare(g),lowBefore=lowCare(s,g),riskBefore=Number(lowBefore.hunger)+Number(lowBefore.cleanliness);
    if(scaled&&(!riskBefore||sick))r.riskMs=0;
    const span=Math.min(elapsedMs-offset,3000-r.tickMs,sick?g.progressionCheckMs-r.illnessMs:Infinity,
      scaled&&!sick&&riskBefore?g.checkMs-r.riskMs:Infinity);
    const active=activity?Math.max(0,Math.min(activity.durationMs,activity.elapsedMs+offset+span)-Math.min(activity.durationMs,activity.elapsedMs+offset)):0;
    const work=activity?.kind==='work'?active:0;
    const playing=scaled&&activity?.kind==='toy'?active:0;
    const embraced=sick?0:Math.max(0,Math.min(embraceMs,offset+span)-Math.min(embraceMs,offset));
    const band=p.workLossPerMinuteTenths.findLast(b=>s.level>=b.minLevel);
    r.hungerUnits+=20*span+work*(band.hunger-20)+playing*((g.playLossPerMinute?.hunger??2)*10-20)+60*embraced;
    r.cleanUnits+=20*span+work*(band.cleanliness-20)+playing*((g.playLossPerMinute?.cleanliness??2)*10-20)+60*embraced;
    const uncomfortable=lowBefore.hunger||lowBefore.cleanliness;
    const rate=activity?.kind==='toy'?-200:activity?.kind==='work'?6:activity?.kind==='study'?2:activity?.kind==='travel'?-4:1;
    // Latest user rule: discomfort replaces the normal/activity mood rate.
    // Hungry and dirty are one condition, never two deductions.
    r.moodUnits+=uncomfortable?span*(p.gameplay.feedbackRules?30:6)+(activity?.kind==='toy'?active*rate:0):span-active+active*rate;
    r.boostMs+=Math.max(0,Math.min(boostMs,offset+span)-Math.min(boostMs,offset));
    r.embraceMs+=embraced;
    r.tickMs+=span;offset+=span;
    if(scaled&&!sick&&riskBefore){
      r.riskMs+=span;
      if(r.riskMs===g.checkMs){
        r.riskMs=0;
        if(draw(r,10000)<(riskBefore===2?g.bothRiskBasisPoints:g.oneRiskBasisPoints)){
          r.disease=chooseDisease(r);r.illnessMs=0;s.health--;emit({kind:'illness',disease:r.disease,health:s.health});
        }
      }
    }
    if(sick) {
      r.illnessMs+=span;
      if(r.illnessMs===g.progressionCheckMs) {
        r.illnessMs=0;
        if(draw(r,10000)<g.progressionRiskBasisPoints) {
          r.disease??=chooseDisease(r);s.health--;
          emit({kind:s.health===0?'death':'illness',disease:r.disease,health:s.health});
        }
      }
    }
    if(r.tickMs!==3000)continue;
    r.tickMs=0;
    const speed=onlineGrowthSpeed(s,p),growth=r.growth+speed*(3000+r.boostMs)+4*r.embraceMs;
    s.growth=Math.min(MAX_CLIENT_GROWTH,s.growth+Math.floor(growth/3600000));r.growth=s.growth===MAX_CLIENT_GROWTH?0:growth%3600000;r.boostMs=0;r.embraceMs=0;
    while(s.growth>=growthStart(s.level+1))s.level++;
    s.hunger=Math.max(0,s.hunger-Math.floor(r.hungerUnits/600000));r.hungerUnits%=600000;
    s.cleanliness=Math.max(0,s.cleanliness-Math.floor(r.cleanUnits/600000));r.cleanUnits%=600000;
    const mood=Math.trunc(r.moodUnits/120000);s.mood=Math.max(0,Math.min(1000,s.mood-mood));r.moodUnits-=mood*120000;
    applyAdultLowCareMood(s,p.gameplay);
    if(!alive()){die();continue;}
    const low=lowCare(s,g),lowHunger=low.hunger,lowClean=low.cleanliness;
    const conditions=Number(lowHunger)+Number(lowClean);
    const graceComplete=r.riskMs>=(g.riskGraceMs??0);
    if(!scaled)r.riskMs=conditions&&s.health===5?Math.min(g.riskGraceMs??0,r.riskMs+3000):0;
    const probability=scaled||s.health<5||!graceComplete?0:conditions===2?g.bothRiskBasisPoints:conditions===1?g.oneRiskBasisPoints:0;
    if(probability&&draw(r,10000)<probability) {
      r.disease=chooseDisease(r);r.illnessMs=0;r.riskMs=0;
      s.health--;emit({kind:s.health===0?'death':'illness',disease:r.disease,health:s.health});
      if(!alive()){die();continue;}
    }
    r.noticeMs=Math.max(0,r.noticeMs-3000);
    if(r.noticeMs===0&&(lowHunger||lowClean)) {
      if(lowHunger)emit({kind:'hungry'});if(lowClean)emit({kind:'itchy'});r.noticeMs=60000;
    }
  }
  if(!alive())die();
  validateGameplayRemainder(r);
  return {state:s,remainder:r,growthSpeed:alive()?onlineGrowthSpeed(s,p)+(s.health===5&&embraceActive?4:0):0,events};
}
