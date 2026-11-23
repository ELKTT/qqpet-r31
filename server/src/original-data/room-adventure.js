const MAX=0x7fffffff;
// Inverse of the shipped ORG.Algorithm m1/2, not a client-provided plaintext
// score. It binds the five score digits to this pet's account suffix and flag.
export function decodeRoomScore(info,proof,uin,flag){
 if(typeof info!=='string'||!/^\d{30}$/.test(info)||!Number.isInteger(flag)||flag<1||flag>60
  ||proof!==(137*flag**3+617*flag**2+997)%61)throw new TypeError('INVALID_ROOM_SCORE');
 const digits=Array(10);
 for(let i=0;i<5;i++){
  const sum=Number(info.slice(i*6,i*6+3)),difference=Number(info.slice(i*6+3,i*6+6))-100;
  const a=(sum+difference)/2,b=(sum-difference)/2;
  if(![a,b].every(n=>Number.isInteger(n)&&n>=48&&n<=57))throw new TypeError('INVALID_ROOM_SCORE');
  digits[i]=String.fromCharCode(a);digits[9-i]=String.fromCharCode(b);
 }
 if(digits.filter((_,i)=>i%2).join('')!==String(uin).slice(-5).padStart(5,'0'))throw new TypeError('INVALID_ROOM_SCORE');
 return Number(digits.filter((_,i)=>i%2===0).join(''));
}
export class RoomAdventure {
 constructor({database,careEconomy}){
  this.database=database;this.care=careEconomy;
  database.exec(`CREATE TABLE IF NOT EXISTS pet_room_progress_v2 (
   pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 99999),
   points INTEGER NOT NULL CHECK(points BETWEEN 0 AND ${MAX}),
   gems INTEGER NOT NULL CHECK(gems BETWEEN 0 AND ${MAX}),
   continues INTEGER NOT NULL CHECK(continues BETWEEN 0 AND 999),flag INTEGER NOT NULL CHECK(flag BETWEEN 1 AND 60)) STRICT;
   CREATE TABLE IF NOT EXISTS pet_room_receipt_v1 (
   pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   nonce TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),PRIMARY KEY(pet_id,nonce)) STRICT;`);
 }
 request(uin,id,q){
  const p=this.care.profile(uin,id),db=this.database;
  db.prepare('INSERT OR IGNORE INTO pet_room_game_v1 VALUES(?,1,0)').run(p.pet_id);
  db.prepare('INSERT OR IGNORE INTO pet_room_progress_v2 VALUES(?,0,0,0,0,1)').run(p.pet_id);
  const stage=db.prepare('SELECT * FROM pet_room_game_v1 WHERE pet_id=?').get(p.pet_id),s=db.prepare('SELECT * FROM pet_room_progress_v2 WHERE pet_id=?').get(p.pet_id);
  const fingerprint=JSON.stringify(q),nonce=q.nonce??'compat-'+q.command+'-'+q.gate;
  const previous=db.prepare('SELECT fingerprint,result_json FROM pet_room_receipt_v1 WHERE pet_id=? AND nonce=?').get(p.pet_id,nonce);
  if(q.command!==1&&previous)return previous.fingerprint===fingerprint?JSON.parse(previous.result_json):{result:-1,msg:'请求标识冲突'};
  const fail=msg=>({result:-1,msg}),balance=()=>db.prepare('SELECT unknown_0x67 AS yuanbao FROM qqpenguin_login_profile WHERE pet_id=?').get(p.pet_id).yuanbao;
  const charge=()=>{
   if(balance()<10)return false;
   db.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67-10 WHERE pet_id=?').run(p.pet_id);return true;
  };
  let result={result:0,msg:'祝宝贝探险愉快！'};
  if(q.command===1){result.result=stage.active>0?1:0;result.msg=stage.active>0?'上次的关卡还没有完成，是否继续？':'开始密室探险吧！';}
  else if([2,10].includes(q.command)){
   if(q.gate>stage.unlocked)return fail('请先完成前面的关卡');
   stage.active=q.gate;s.continues=0;if(q.command===2)s.score=0;s.flag=s.flag%60+1;
  }else if([3,4,6].includes(q.command)){
   if(stage.active!==q.gate)return fail('本关游戏尚未开始或已经结算');
   let score;try{score=q.info===undefined?s.score:decodeRoomScore(q.info,q.proof,uin,s.flag);}catch{return fail('分数校验失败，请重新开始本关');}
   if(score<s.score)return fail('分数不能倒退');s.score=score;
   if(q.command===3)stage.unlocked=Math.min(10,Math.max(stage.unlocked,q.gate+1));
   if(q.command===6){s.points=Math.min(MAX,s.points+s.score);stage.active=0;}
  }else if(q.command===5){
   if(stage.active!==q.gate)return fail('本关游戏尚未开始');
   return {result:-2,msg:'继续本关需要支付 10 元宝，确认后扣费。',count:s.continues+1};
  }else if(q.command===7){
   if(stage.active!==q.gate||q.count!==s.continues+1||s.continues>=999)return fail('续关请求已失效');
   if(!charge())return {result:100,msg:'元宝不足，续关需要 10 元宝'};
   s.continues++;result.msg='已支付 10 元宝，继续探险吧！';
  }else if([8,9,11].includes(q.command)){
   // The supplied XML snapshots contain refusal examples, not the original
   // item/prize table. Do not charge for an unconfigured award or invent one.
   return fail('奖励清单尚未补齐，本次未扣费；原收费服务统一为每次10元宝。');
  }
  db.prepare('UPDATE pet_room_game_v1 SET unlocked=?,active=? WHERE pet_id=?').run(stage.unlocked,stage.active,p.pet_id);
  db.prepare('UPDATE pet_room_progress_v2 SET score=?,points=?,gems=?,continues=?,flag=? WHERE pet_id=?').run(s.score,s.points,s.gems,s.continues,s.flag,p.pet_id);
  result={...result,sex:p.sex==='male'?102:103,level:p.level<5?1:p.level<10?2:3,
   gate:q.command===1?stage.unlocked:q.command===3?Math.min(10,q.gate+1):q.gate,uin,flag:s.flag,score:s.score,count:s.continues,jifen:s.points,baoshi:s.gems};
  if(q.command!==1){
   db.prepare('INSERT INTO pet_room_receipt_v1 VALUES(?,?,?,?)').run(p.pet_id,nonce,fingerprint,JSON.stringify(result));
   db.prepare('DELETE FROM pet_room_receipt_v1 WHERE pet_id=? AND rowid NOT IN (SELECT rowid FROM pet_room_receipt_v1 WHERE pet_id=? ORDER BY rowid DESC LIMIT 128)').run(p.pet_id,p.pet_id);
  }
  return result;
 }
}
