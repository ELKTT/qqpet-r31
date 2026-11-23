import {randomInt} from 'node:crypto';
import {encodeCommInteractFailure,encodeCommInteractSuccess} from '../protocol/comm-interact.js';

const excluded=new Set(['乐园卡','乐扣贝','改名卡','红宝石','蓝宝石','黄宝石','续关币']);
export const isToy=i=>i?.class==='functional'&&!excluded.has(i.name);
export const interactionMood=mood=>mood<100?70:mood<300?50:mood<600?30:mood<900?10:5;
const DAY=86400000,MAX=0x7fffffff;
// User rules, 2026-10-21. The caller owns the online checkpoint transaction, so
// receipts, mood, coins, task progress and inventory commit or roll back together.
export class PetActivityRules {
 constructor({database,careEconomy,desktopTasks,coinFactory=()=>randomInt(10,21)}){
  this.database=database;this.care=careEconomy;this.tasks=desktopTasks;this.coinFactory=coinFactory;
  database.exec(`CREATE TABLE IF NOT EXISTS pet_activity_rules_v1 (
   pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   mouse_sequence INTEGER, toy_until INTEGER NOT NULL DEFAULT 0,
   native_last INTEGER, native_remainder INTEGER NOT NULL DEFAULT 0,
   coin_day INTEGER NOT NULL DEFAULT 0, coins INTEGER NOT NULL DEFAULT 0 CHECK(coins BETWEEN 0 AND 100),
   sequences TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sequences))) STRICT;`);
 }
 initialize(uin,id){const p=this.care.profile(uin,id);this.database.prepare('INSERT OR IGNORE INTO pet_activity_rules_v1(pet_id) VALUES(?)').run(p.pet_id);
  // A fresh native login starts a fresh request sequence. Daily coin receipts stay durable.
  // Keep the former timing columns for existing saves, but never carry their
  // partial minutes into the result-based native game rule (2026-10-22).
  this.database.prepare('UPDATE pet_activity_rules_v1 SET mouse_sequence=NULL,native_last=NULL,native_remainder=0 WHERE pet_id=?').run(p.pet_id);}
 row(uin,id){const p=this.care.profile(uin,id),s=this.database.prepare('SELECT * FROM pet_activity_rules_v1 WHERE pet_id=?').get(p.pet_id);if(!s)throw Error('ACTIVITY_STATE_MISSING');return {p,s};}
 mood(p,amount){const gain=Math.min(amount,1000-p.mood);if(gain)this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x4e=unknown_0x4e+? WHERE pet_id=?').run(gain,p.pet_id);return gain;}
 click(uin,id,q){
  if(!Number.isInteger(q?.sequence)||q.sequence<0||q.sequence>0xffffffff||q.items?.length!==1||q.items[0].type!==104||q.items[0].times!==1)return encodeCommInteractFailure(1);
  const {p,s}=this.row(uin,id);if(p.health===0||s.mouse_sequence!==null&&q.sequence<=s.mouse_sequence)return encodeCommInteractFailure(1);
  this.database.prepare('UPDATE pet_activity_rules_v1 SET mouse_sequence=? WHERE pet_id=?').run(q.sequence,p.pet_id);
  const gain=this.mood(p,interactionMood(p.mood));this.tasks?.record(uin,id,'interact');return encodeCommInteractSuccess(q.sequence,gain,0);
 }
 toy(uin,id,onlineMs){const {p}=this.row(uin,id);this.database.prepare('UPDATE pet_activity_rules_v1 SET toy_until=? WHERE pet_id=?').run(onlineMs+300000,p.pet_id);this.tasks?.record(uin,id,'interact');}
 toyRemaining(uin,id,ms){return Math.max(0,this.row(uin,id).s.toy_until-ms);}
 stopToy(uin,id){const {p}=this.row(uin,id);this.database.prepare('UPDATE pet_activity_rules_v1 SET toy_until=0 WHERE pet_id=?').run(p.pet_id);}
 gameMood(uin,id,elapsed,remainder=0){const {p}=this.row(uin,id);const units=remainder+elapsed*50;return {mood:p.health===5?this.mood(p,Math.floor(units/60000)):0,remainder:units%60000};}
 nativeGame(uin,id,now,sequence,{coins=false}={}){
  const {p,s}=this.row(uin,id);if(p.health!==5)return null;
  const day=Math.floor((now+8*3600000)/DAY);if(day<s.coin_day)return null;
  const receipts=day===s.coin_day?JSON.parse(s.sequences):[],earned=day===s.coin_day?s.coins:0;
  const key=String(sequence);if(receipts.includes(key))return null;
  const gain=this.mood(p,interactionMood(p.mood));
  let award=0;
  if(coins&&earned<100){const draw=this.coinFactory();if(!Number.isInteger(draw)||draw<10||draw>20)throw Error('INVALID_DIUDIULE_DRAW');award=Math.min(draw,100-earned,MAX-p.yuanbao);}
  if(award)this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67+? WHERE pet_id=?').run(award,p.pet_id);
  receipts.push(key);this.database.prepare('UPDATE pet_activity_rules_v1 SET native_last=NULL,native_remainder=0,coin_day=?,coins=?,sequences=? WHERE pet_id=?')
   .run(day,earned+award,JSON.stringify(receipts.slice(-128)),p.pet_id);
  this.tasks?.record(uin,id,'interact');return {mood:gain,coins:award};
 }
}
