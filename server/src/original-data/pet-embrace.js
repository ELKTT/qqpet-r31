import {encodeClientText} from '../protocol/client-text.js';
const HOUR=3600000,DAY=86400000;
const day=n=>Math.floor((n+8*3600000)/DAY);
const validNonce=n=>typeof n==='string'&&/^[A-Za-z0-9_-]{8,64}$/.test(n);
const description=Buffer.alloc(16);encodeClientText('爱的怀抱').copy(description);

// Original petstatusdesc.xml identifies state 20 as 爱的怀抱. The rates and
// limits below are the user's explicit policy, committed with the online clock.
export class PetEmbrace {
 constructor({database,membership,careEconomy,clock=Date.now}){
  this.database=database;this.member=membership;this.care=careEconomy;this.clock=clock;
  database.exec(`CREATE TABLE IF NOT EXISTS pet_embrace_v1 (
   pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   day INTEGER NOT NULL,used INTEGER NOT NULL CHECK(used BETWEEN 0 AND 4),
   started_ms INTEGER NOT NULL,until_ms INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS pet_embrace_receipt_v1 (
   pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   nonce TEXT NOT NULL,operation TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),
   PRIMARY KEY(pet_id,nonce)) STRICT;`);
 }
 initialize(uin,id){const p=this.care.profile(uin,id);this.database.prepare('INSERT OR IGNORE INTO pet_embrace_v1 VALUES(?,?,0,0,0)').run(p.pet_id,day(this.clock()));}
 load(uin,id){
  const p=this.care.profile(uin,id),r=this.database.prepare('SELECT * FROM pet_embrace_v1 WHERE pet_id=?').get(p.pet_id);
  if(!r||!Number.isInteger(r.day)||r.day<0||r.used<0||r.used>4||![r.started_ms,r.until_ms].every(n=>Number.isSafeInteger(n)&&n>=0)
   ||r.until_ms!==0&&r.until_ms-r.started_ms!==HOUR)throw Error('INVALID_EMBRACE_STATE');
  const today=day(this.clock());if(today>r.day){r.day=today;r.used=0;this.database.prepare('UPDATE pet_embrace_v1 SET day=?,used=0 WHERE pet_id=?').run(today,r.pet_id);}
  return {p,r};
 }
 blocked(p){return p.health!==5||[1,2,3,5].includes(p.nativeStatus)||Boolean(this.care.load(p.pet_id).activity);}
 until(uin,id,r){const s=this.member.get(uin,id);return Math.min(r.until_ms,s.plan==='none'?0:s.expiresAt??Number.MAX_SAFE_INTEGER);}
 interval(uin,id,start,end){
  const {p,r}=this.load(uin,id),until=this.until(uin,id,r),blocked=this.blocked(p);
  return {elapsedMs:blocked?0:Math.max(0,Math.min(end,until)-Math.max(start,r.started_ms)),active:!blocked&&until>end};
 }
 active(uin,id){const now=this.clock();return this.interval(uin,id,now,now).active;}
 cancel(uin,id){const {r}=this.load(uin,id);this.database.prepare('UPDATE pet_embrace_v1 SET until_ms=0 WHERE pet_id=?').run(r.pet_id);return {result:0,msg:'爱的怀抱已结束'};}
 reconcile(uin,id){const {p}=this.load(uin,id);if(this.blocked(p))this.cancel(uin,id);}
 request(uin,id,operation,nonce){
  if(!['embrace-start','embrace-stop'].includes(operation)||!validNonce(nonce))throw new TypeError('INVALID_EMBRACE_REQUEST');
  const {p,r}=this.load(uin,id),old=this.database.prepare('SELECT operation,result_json FROM pet_embrace_receipt_v1 WHERE pet_id=? AND nonce=?').get(r.pet_id,nonce);
  if(old)return old.operation===operation?JSON.parse(old.result_json):{result:1,msg:'请求标识冲突'};
  let result;
  if(operation==='embrace-stop')result=this.cancel(uin,id);
  else {
   const member=this.member.get(uin,id),now=this.clock();
   if(member.vip_level===0)return {result:1,msg:'开通粉钻后才能享受爱的怀抱'};
   if(this.blocked(p))return {result:1,msg:'生病、打工、学习或旅游时不能进入爱的怀抱'};
   if(this.active(uin,id))return {result:1,msg:'宝贝正在爱的怀抱中'};
   if(r.used>=4)return {result:1,msg:'今天的四次爱的怀抱已用完，明天再来吧'};
   this.database.prepare('UPDATE pet_embrace_v1 SET used=used+1,started_ms=?,until_ms=? WHERE pet_id=?').run(now,now+HOUR,r.pet_id);
   this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x4e=1000 WHERE pet_id=?').run(r.pet_id);
   result={result:0,msg:'进入爱的怀抱，心情已恢复到100%，每小时额外成长4点',expiresAt:now+HOUR};
  }
  this.database.prepare('INSERT INTO pet_embrace_receipt_v1 VALUES(?,?,?,?)').run(r.pet_id,nonce,operation,JSON.stringify(result));
  this.database.prepare('DELETE FROM pet_embrace_receipt_v1 WHERE pet_id=? AND rowid NOT IN (SELECT rowid FROM pet_embrace_receipt_v1 WHERE pet_id=? ORDER BY rowid DESC LIMIT 64)').run(r.pet_id,r.pet_id);
  return result;
 }
 view(uin,id){const {r}=this.load(uin,id),active=this.active(uin,id),until=this.until(uin,id,r);return {active,remaining:4-r.used,
  remainingMs:active?until-this.clock():0,expiresAt:active?until:0,durationMinutes:60,growthPerHour:4,hungerPerMinute:8,cleanlinessPerMinute:8};}
 project(uin,id){const {r}=this.load(uin,id);return this.active(uin,id)?{statusId:20,statusDescription:Buffer.from(description),statusTime:Math.floor((this.clock()-r.started_ms)/1000)}:{};}
}
