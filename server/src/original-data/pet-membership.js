import {createHash} from 'node:crypto';
import {encodeAutoFeedSuccess} from '../protocol/auto-feed.js';
import {TimedPetMembership,validateTimedMembershipPolicy} from './timed-pet-membership.js';

export function validateMembershipPolicy(p) {
  if(p?.id==='local-timed-vip-care-v2')return validateTimedMembershipPolicy(p);
  const keys=['id','permanentVip','initialVipLevel','defaultAutoCare','careBelowPercent','careTargetPercent'];
  if(!p||Array.isArray(p)||Object.keys(p).length!==keys.length||keys.some(k=>!Object.hasOwn(p,k))
    ||p.id!=='local-permanent-vip-care-v1'||p.permanentVip!==true||p.initialVipLevel!==1
    ||p.defaultAutoCare!==false||p.careBelowPercent!==30||p.careTargetPercent!==60)
    throw new TypeError('INVALID_MEMBERSHIP_POLICY');
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,p[k]])));
}

// Permanent eligibility is server policy, not a guessed client expiration timestamp.
// Caller owns the online-clock transaction, including switch changes and projections.
export class PetMembership {
  constructor({database,policy,clock}) {
    if(policy?.id==='local-timed-vip-care-v2')return new TimedPetMembership({database,policy,clock});
    this.database=database;this.policy=validateMembershipPolicy(policy);
    this.digest=createHash('sha256').update(JSON.stringify(this.policy)).digest('hex');
    database.exec(`CREATE TABLE IF NOT EXISTS pet_membership_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      vip_level INTEGER NOT NULL CHECK(vip_level BETWEEN 1 AND 7),
      auto_care INTEGER NOT NULL CHECK(auto_care IN (0,1))) STRICT;`);
    this.profile=database.prepare(`SELECT q.pet_id,q.unknown_0x65 AS vip_level FROM qqpenguin_login_profile q
      JOIN pet p ON p.pet_id=q.pet_id WHERE p.uin=? AND q.pet_id_bytes=?`);
  }
  initialize(uin,petId) {
    const r=this.profile.get(uin,petId);if(!r)throw new Error('MEMBERSHIP_PROFILE_MISSING');
    const level=Number.isInteger(r.vip_level)&&r.vip_level>=1&&r.vip_level<=7?r.vip_level:this.policy.initialVipLevel;
    this.database.prepare('INSERT OR IGNORE INTO pet_membership_v1 VALUES(?,?,?,0)').run(r.pet_id,this.digest,level);
    this.project(uin,petId);
  }
  get(uin,petId) {
    const r=this.database.prepare(`SELECT m.* FROM pet_membership_v1 m JOIN qqpenguin_login_profile q USING(pet_id)
      JOIN pet p USING(pet_id) WHERE p.uin=? AND q.pet_id_bytes=?`).get(uin,petId);
    if(!r||r.policy_digest!==this.digest||!Number.isInteger(r.vip_level)||r.vip_level<1||r.vip_level>7||![0,1].includes(r.auto_care))
      throw new Error('INVALID_MEMBERSHIP_STATE');
    return r;
  }
  project(uin,petId) {
    const r=this.get(uin,petId);
    this.database.prepare('UPDATE qqpenguin_login_profile SET vip_flag=1,unknown_0x65=?,auto_feed_flag=? WHERE pet_id=?')
      .run(r.vip_level,r.auto_care,r.pet_id);
    this.database.prepare('UPDATE pet SET vip_level=? WHERE pet_id=?').run(r.vip_level,r.pet_id);
    return {vipFlag:1,unknown_0x65:r.vip_level,autoFeedFlag:r.auto_care};
  }
  setAutoCare(uin,petId,{enabled}) {
    if(typeof enabled!=='boolean')throw new TypeError('INVALID_AUTO_FEED_STATE');
    const r=this.get(uin,petId);
    this.database.prepare('UPDATE pet_membership_v1 SET auto_care=? WHERE pet_id=?').run(Number(enabled),r.pet_id);
    this.project(uin,petId);return encodeAutoFeedSuccess(enabled);
  }
  care(uin,petId) {
    return {enabled:this.get(uin,petId).auto_care===1,belowPercent:this.policy.careBelowPercent,targetPercent:this.policy.careTargetPercent};
  }
}
