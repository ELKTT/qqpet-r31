// User's local quota rules; original fish Define fixes max power/recovery times.
// Rows are changed only inside the business checkpoint transaction.
export const BUSINESS_FEED_PRICE=10;
export const BUSINESS_FEED_ADVANCE_MS=3600000;
export const FISHING_POWER_COST=10;
const day=now=>Math.floor((now+8*3600000)/86400000);
export class PetBusinessBenefits {
  constructor(database) {
    this.database=database;
    database.exec(`CREATE TABLE IF NOT EXISTS pet_business_daily_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('fish-super','farm-super','fish-catch')),
      day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 200),PRIMARY KEY(pet_id,kind)) STRICT;
      CREATE TABLE IF NOT EXISTS pet_fishing_power_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      power INTEGER NOT NULL CHECK(power BETWEEN 0 AND 30),recover_at INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS pet_fishing_peer_daily_v1 (
      actor TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 20),PRIMARY KEY(actor,target)) STRICT;
      CREATE TABLE IF NOT EXISTS pet_farm_pick_daily_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 50)) STRICT;
      CREATE TABLE IF NOT EXISTS pet_farm_pick_peer_daily_v1 (
      actor TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 20),PRIMARY KEY(actor,target)) STRICT;`);
  }
  membership(uin,petId,membership) {
    const r=this.database.prepare('SELECT vip_flag,unknown_0x65 AS level,unknown_0x66 AS annual FROM qqpenguin_login_profile q '+
      'JOIN pet p USING(pet_id) WHERE p.uin=? AND q.pet_id_bytes=?').get(uin,petId);
    const level=membership?.get(uin,petId).vip_level??(r?.vip_flag===1?r.level:0);
    if(!Number.isInteger(level)||level<0||level>7)throw new Error('INVALID_BUSINESS_VIP');
    return {level,annual:level>0&&r.annual!==0};
  }
  quota(vip) {return vip.level===0?0:vip.annual?8:[0,1,1,2,3,4,5,8][vip.level];}
  counter(pet,kind,now) {
    const r=this.database.prepare('SELECT day,used FROM pet_business_daily_v1 WHERE pet_id=? AND kind=?').get(pet,kind);
    return !r||day(now)>r.day?{day:day(now),used:0}:r;
  }
  allowance(pet,kind,vip,now) {
    const total=this.quota(vip),r=this.counter(pet,kind+'-super',now);
    return {viplv:vip.level,canusecnt:Math.max(0,total-r.used),allvipcnt:total};
  }
  useSuper(pet,kind,vip,now) {
    const r=this.counter(pet,kind+'-super',now);
    if(r.used>=this.quota(vip))return false;
    this.database.prepare('INSERT INTO pet_business_daily_v1 VALUES(?,?,?,?) ON CONFLICT(pet_id,kind) DO UPDATE SET day=excluded.day,used=excluded.used')
      .run(pet,kind+'-super',r.day,r.used+1);return true;
  }
  power(pet,vip,now) {
    const max=vip.level?30:20,period=(vip.level?1200:1800)*1000;
    const r=this.database.prepare('SELECT power,recover_at FROM pet_fishing_power_v1 WHERE pet_id=?').get(pet);
    if(!r)return {power:max,recoverAt:null,max,period,power_up_left:0};
    let power=Math.min(max,r.power),at=r.recover_at;
    if(power<max&&at!==null&&now>=at) {
      const steps=1+Math.floor((now-at)/period);power=Math.min(max,power+steps);at+=steps*period;
    }
    if(power===max)at=null;
    return {power,recoverAt:at,max,period,power_up_left:at===null?0:Math.max(0,Math.ceil((at-now)/1000))};
  }
  catchAllowance(actor,target,vip,now) {
    const r=this.counter(actor,'fish-catch',now),stored=this.database.prepare('SELECT day,used FROM pet_fishing_peer_daily_v1 WHERE actor=? AND target=?').get(actor,target);
    const peer=!stored||day(now)>stored.day?{day:day(now),used:0}:stored;
    return {global:r,peer,available:r.used<(vip.level?200:100)&&peer.used<(vip.level?20:10)};
  }
  consumeCatch(actor,target,vip,now) {
    const p=this.power(actor,vip,now),q=this.catchAllowance(actor,target,vip,now);
    if(!q.available||p.power<FISHING_POWER_COST)return false;
    this.database.prepare('INSERT INTO pet_fishing_power_v1 VALUES(?,?,?) ON CONFLICT(pet_id) DO UPDATE SET power=excluded.power,recover_at=excluded.recover_at')
      .run(actor,p.power-FISHING_POWER_COST,p.recoverAt??now+p.period);
    this.database.prepare('INSERT INTO pet_business_daily_v1 VALUES(?,?,?,?) ON CONFLICT(pet_id,kind) DO UPDATE SET day=excluded.day,used=excluded.used')
      .run(actor,'fish-catch',q.global.day,q.global.used+1);
    this.database.prepare('INSERT INTO pet_fishing_peer_daily_v1 VALUES(?,?,?,?) ON CONFLICT(actor,target) DO UPDATE SET day=excluded.day,used=excluded.used')
      .run(actor,target,q.peer.day,q.peer.used+1);return true;
  }
  pickAllowance(actor,target,vip,now) {
    // farm4.0 config.xml: 20/50 per day; Define: 10/20 per friend.
    const stored=this.database.prepare('SELECT day,used FROM pet_farm_pick_daily_v1 WHERE pet_id=?').get(actor);
    const global=!stored||day(now)>stored.day?{day:day(now),used:0}:stored;
    const peerStored=this.database.prepare('SELECT day,used FROM pet_farm_pick_peer_daily_v1 WHERE actor=? AND target=?').get(actor,target);
    const peer=!peerStored||day(now)>peerStored.day?{day:day(now),used:0}:peerStored;
    return {global,peer,globalLimit:vip.level?50:20,peerLimit:vip.level?20:10,
      available:global.used<(vip.level?50:20)&&peer.used<(vip.level?20:10)};
  }
  consumePick(actor,target,vip,now) {
    const q=this.pickAllowance(actor,target,vip,now);if(!q.available)return false;
    this.database.prepare('INSERT INTO pet_farm_pick_daily_v1 VALUES(?,?,?) ON CONFLICT(pet_id) DO UPDATE SET day=excluded.day,used=excluded.used')
      .run(actor,q.global.day,q.global.used+1);
    this.database.prepare('INSERT INTO pet_farm_pick_peer_daily_v1 VALUES(?,?,?,?) ON CONFLICT(actor,target) DO UPDATE SET day=excluded.day,used=excluded.used')
      .run(actor,target,q.peer.day,q.peer.used+1);return true;
  }
}
