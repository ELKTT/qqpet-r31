import {createHash} from 'node:crypto';
import {encodeSpecialInteractFailure,encodeSpecialInteractSuccess} from '../protocol/special-interact.js';
import {encodeCommInteractFailure,encodeCommInteractSuccess} from '../protocol/comm-interact.js';

const actions=[50,51,52,53,54,56];
export function validatePlayRewardsPolicy(p){
  if(!p||Object.keys(p).sort().join('|')!=='cooldownMs|dailyLimit|id|mood|timezone|yuanbao'
    ||!['local-play-mood-v1','local-play-mood-unlimited-v2'].includes(p.id)||p.mood!==10||p.yuanbao!==0||p.cooldownMs!==30000
    ||p.dailyLimit!==(p.id==='local-play-mood-v1'?20:0)||p.timezone!=='Asia/Shanghai')throw new TypeError('INVALID_PLAY_REWARDS_POLICY');
  return Object.freeze({...p});
}

// Explicit approved local mood rules on the original 053B path. The low-byte
// counter is not a full score or an anti-cheat proof. State shares the online
// checkpoint transaction and the existing desktop-interaction cooldown.
export class PetPlayRewards {
  constructor({database,petBusiness,policy,beforeCommit=()=>{}}){
    this.policy=validatePlayRewardsPolicy(policy);
    if(petBusiness?.database!==database||typeof petBusiness.grantInteractionMood!=='function'
      ||petBusiness.policy.interactionMood!==this.policy.mood
      ||petBusiness.policy.interactionCooldownMs!==this.policy.cooldownMs)throw new TypeError('PLAY_REQUIRES_SHARED_BUSINESS');
    this.database=database;this.petBusiness=petBusiness;this.beforeCommit=beforeCommit;
    this.digest=createHash('sha256').update(JSON.stringify(this.policy)).digest('hex');
    database.exec(`CREATE TABLE IF NOT EXISTS pet_play_rewards_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      day INTEGER NOT NULL CHECK(day>=0),awards INTEGER NOT NULL CHECK(awards BETWEEN 0 AND 20),
      counters_json TEXT NOT NULL CHECK(json_valid(counters_json))) STRICT;`);
  }
  day(now){
    if(!Number.isSafeInteger(now)||now<0||now>0xffffffff*1000)throw new TypeError('INVALID_PLAY_CLOCK');
    return Math.floor((now+8*3600000)/86400000);
  }
  initialize(uin,petId,now){
    const id=this.petBusiness.profile(uin,petId).pet_id;
    this.database.prepare('INSERT OR IGNORE INTO pet_play_rewards_v1 VALUES(?,?,?,?,?)')
      .run(id,this.digest,this.day(now),0,'{}');this.load(id);
  }
  load(id){
    const row=this.database.prepare('SELECT * FROM pet_play_rewards_v1 WHERE pet_id=?').get(id);
    if(row&&this.policy.id==='local-play-mood-unlimited-v2') {
      const old=createHash('sha256').update(JSON.stringify({...this.policy,id:'local-play-mood-v1',dailyLimit:20})).digest('hex');
      if(row.policy_digest===old){this.database.prepare('UPDATE pet_play_rewards_v1 SET policy_digest=? WHERE pet_id=?').run(this.digest,id);row.policy_digest=this.digest;}
    }
    if(!row||row.policy_digest!==this.digest||!Number.isSafeInteger(row.day)||row.day<0
      ||!Number.isInteger(row.awards)||row.awards<0||row.awards>20)throw Error('PLAY_SAVED_STATE_INVALID');
    const counters=JSON.parse(row.counters_json);
    if(!counters||typeof counters!=='object'||Array.isArray(counters)||Object.keys(counters).some(k=>
      ![...actions,105].some(a=>String(a)===k)||!Number.isInteger(counters[k])||counters[k]<0
      ||counters[k]>(k==='105'?0xffffffff:255)))throw Error('PLAY_SAVED_STATE_INVALID');
    return {...row,counters};
  }
  request(uin,petId,onlineMs,now,q){
    if(q?.count!==1||!actions.includes(q.actionType)||!Number.isInteger(q.countByte)||q.countByte<0||q.countByte>255)
      return encodeSpecialInteractFailure(1);
    if(this.activityRules){const reward=this.activityRules.nativeGame(uin,petId,now,'special-'+q.actionType+'-'+q.countByte);
      return reward?encodeSpecialInteractSuccess(reward.mood,0):encodeSpecialInteractFailure(1);}
    const delta=this.grant(uin,petId,onlineMs,now,q.actionType,q.countByte);
    return delta?encodeSpecialInteractSuccess(delta,0):encodeSpecialInteractFailure(1);
  }
  // Diudiule 2CF0/2D00 constructs count=1,type=105,times=1 for the
  // original ICommInteractProtocol. Its 30B0 consumer reads key1 mood.
  commonRequest(uin,petId,onlineMs,now,q){
    if(!Number.isInteger(q?.sequence)||q.sequence<0||q.sequence>0xffffffff
      ||!Array.isArray(q.items)||q.items.length!==1||q.items[0]?.type!==105||q.items[0].times!==1)
      return encodeCommInteractFailure(1);
    if(this.activityRules){const reward=this.activityRules.nativeGame(uin,petId,now,'diudiule-'+q.sequence,{coins:true});
      return reward?encodeCommInteractSuccess(q.sequence,reward.mood,reward.coins):encodeCommInteractSuccess(q.sequence,0,0);}
    const delta=this.grant(uin,petId,onlineMs,now,105,q.sequence);
    return delta?encodeCommInteractSuccess(q.sequence,delta,0):encodeCommInteractFailure(1);
  }
  grant(uin,petId,onlineMs,now,action,count){
    const r=this.petBusiness.profile(uin,petId),s=this.load(r.pet_id),day=this.day(now);
    if(day<s.day)return 0;
    if(day>s.day){s.day=day;s.awards=0;s.counters={};}
    if((this.policy.dailyLimit>0&&s.awards>=this.policy.dailyLimit)||s.counters[action]===count)return 0;
    const delta=this.petBusiness.grantInteractionMood(uin,petId,onlineMs);
    if(!delta)return 0;
    s.counters[action]=count;s.awards=Math.min(20,s.awards+1);
    this.database.prepare('UPDATE pet_play_rewards_v1 SET day=?,awards=?,counters_json=? WHERE pet_id=?')
      .run(s.day,s.awards,JSON.stringify(s.counters),r.pet_id);
    this.beforeCommit();return delta;
  }
}
