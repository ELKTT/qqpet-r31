import {careMaximum} from './online-pet-state.js';
import {DISEASES,validateGameplayRemainder,chooseDisease} from './gameplay-vitals.js';

export class PetHealth {
  constructor({database,onlineVitals,membership}) {
    this.database=database;this.onlineVitals=onlineVitals;this.membership=membership;
    database.exec(`CREATE TABLE IF NOT EXISTS pet_hospital_visit_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      nonce TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)),PRIMARY KEY(pet_id,nonce)) STRICT;`);
  }
  state(uin,petId) {
    const q=this.onlineVitals.select.get(uin,petId);
    if(!q)throw new Error('HEALTH_PROFILE_MISSING');
    const stored=this.database.prepare('SELECT remainder_json FROM online_pet_vitals_v1 WHERE pet_id=?').get(q.pet_id);
    if(!stored)throw new Error('HEALTH_STATE_MISSING');
    const r=JSON.parse(stored.remainder_json);validateGameplayRemainder(r);return {q,r};
  }
  save(q,r) {
    this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x4b=?,unknown_0x47=?,unknown_0x49=?,unknown_0x4e=? WHERE pet_id=?')
      .run(q.health,q.hunger,q.cleanliness,q.mood,q.pet_id);
    this.database.prepare('UPDATE online_pet_vitals_v1 SET remainder_json=? WHERE pet_id=?').run(JSON.stringify(r),q.pet_id);
  }
  view(uin,petId) {
    const {q,r}=this.state(uin,petId),chain=r.disease??'cold';
    return {health:q.health,dead:q.health===0,disease:q.health>0&&q.health<5?DISEASES[chain][q.health-1]:null,
      medicineFor:q.health>0&&q.health<5?`${chain}:${q.health}`:null,fee:q.health>0&&q.health<5?(5-q.health)*50:0,
      hunger:q.hunger,cleanliness:q.cleanliness,mood:q.mood};
  }
  treat(uin,petId,medicine) {
    const {q,r}=this.state(uin,petId);
    if(medicine==='revive') {
      if(q.health!==0)return {ok:false,msg:'宝贝还好好的，不需要还魂丹哦'};
      q.health=5;q.hunger=q.cleanliness=Math.floor(careMaximum(q.level)*0.6);q.mood=600;
      Object.assign(r,{disease:null,illnessMs:0,hungerUnits:0,cleanUnits:0,moodUnits:0,noticeMs:0});
      this.save(q,r);return {ok:true,msg:'宝贝醒过来了！以后也要好好照顾它哦。',action:'revive'};
    }
    if(q.health===0)return {ok:false,msg:'请先使用还魂丹让宝贝醒来'};
    if(q.health<5&&medicine===`${r.disease??'cold'}:${q.health}`) {
      q.health=5;r.disease=null;r.illnessMs=0;this.save(q,r);return {ok:true,msg:'药吃对啦，宝贝已经恢复健康！',action:'medicine'};
    }
    q.health=Math.max(0,q.health-1);r.disease??=chooseDisease(r);r.illnessMs=0;this.save(q,r);
    return {ok:true,msg:q.health===0?'吃错药让病情恶化，宝贝需要还魂丹。':'这不是对症的药，健康值降低了 1 点，请先找五爷看病。',action:q.health===0?'death':'medicine'};
  }
  freeCare(uin,petId,kind) {
    const {q,r}=this.state(uin,petId),key={feed:'hunger',clean:'cleanliness',medicine:'health'}[kind];
    if(!key||q.health===0)return {result:1,msg:'当前不能使用这项免费服务'};
    if(kind==='medicine'&&q.health===5)return {result:1,msg:'宝贝很健康，无需治疗'};
    if(!this.membership.takeFreeCare(uin,petId,kind))return {result:1,msg:'粉钻未开通或今天的这项免费次数已使用'};
    const maximum=careMaximum(q.level);
    q[key]=kind==='medicine'?5:Math.min(maximum,q[key]+Math.floor(maximum/2));
    if(kind!=='medicine'&&this.onlineVitals.policy.gameplay?.feedbackRules)q.mood=Math.min(1000,q.mood+20);
    if(kind==='medicine'){r.disease=null;r.illnessMs=0;}
    this.save(q,r);return {result:0,msg:kind==='medicine'?'宝贝已完全康复！':kind==='feed'?'饥饿增加上限的 50%！':'清洁增加上限的 50%！',careAction:kind};
  }
  consult(uin,petId,nonce) {
    if(typeof nonce!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(nonce))throw new TypeError('INVALID_HOSPITAL_NONCE');
    const {q}=this.state(uin,petId),past=this.database.prepare('SELECT response_json FROM pet_hospital_visit_v1 WHERE pet_id=? AND nonce=?').get(q.pet_id,nonce);
    if(past)return JSON.parse(past.response_json);
    const info=this.view(uin,petId);
    if(info.dead)return {result:1,msg:'宝贝需要还魂丹复活，普通诊疗不能让它醒来。',...info};
    if(!info.disease){const result={result:0,msg:'五爷看过啦，宝贝很健康！',...info,charged:0};
      this.database.prepare('INSERT INTO pet_hospital_visit_v1 VALUES(?,?,?)').run(q.pet_id,nonce,JSON.stringify(result));return result;}
    const fee=info.fee;
    const balance=this.database.prepare('SELECT unknown_0x67 AS yuanbao FROM qqpenguin_login_profile WHERE pet_id=?').get(q.pet_id).yuanbao;
    if(balance<fee)return {result:1,msg:'元宝不足，暂未扣费',...info};
    this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67-? WHERE pet_id=?').run(fee,q.pet_id);
    const result={result:0,msg:'五爷开好处方了，记得按时给宝贝吃对药哦！',...info,charged:fee,yuanbao:balance-fee};
    this.database.prepare('INSERT INTO pet_hospital_visit_v1 VALUES(?,?,?)').run(q.pet_id,nonce,JSON.stringify(result));
    return result;
  }
  recoverGame(uin,petId,nonce){
    if(typeof nonce!=='string'||!/^relive-[A-Za-z0-9_-]{1,40}$/.test(nonce))throw new TypeError('INVALID_RELIVE_NONCE');
    const {q,r}=this.state(uin,petId),past=this.database.prepare('SELECT response_json FROM pet_hospital_visit_v1 WHERE pet_id=? AND nonce=?').get(q.pet_id,nonce);
    if(past)return JSON.parse(past.response_json);
    if(q.health===0||q.health===5)return {result:1,msg:q.health===0?'宝贝需要还魂丹。':'宝贝已经很健康啦！'};
    q.health=5;r.disease=null;r.illnessMs=0;this.save(q,r);
    const result={result:0,msg:'小游戏完成，宝贝已经恢复健康！',careAction:'medicine'};
    this.database.prepare('INSERT INTO pet_hospital_visit_v1 VALUES(?,?,?)').run(q.pet_id,nonce,JSON.stringify(result));return result;
  }
}
