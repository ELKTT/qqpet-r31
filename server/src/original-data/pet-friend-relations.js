import {createHash} from 'node:crypto';
import {gbkEncode} from '../accounts/account-service.js';
const word=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const dword=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const bytes=id=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(id));return b;};
const key=id=>id.readBigUInt64LE().toString();
// FriendList c4925d2f: 10400/10120 search; 09C50/09AA0 request;
// 08080/07F20 consent; 0A8D0 result; 08CD0 detail; 0B6A0/0B4A0 delete.
// PetBuddy 2849/2851: 1 accept, 2 accept and add back, 3 reject.
export class PetFriendRelations {
 constructor(friends,{clock=Date.now,beforeCommit=()=>{}}={}){
  this.friends=friends;this.database=friends.database;this.clock=clock;this.beforeCommit=beforeCommit;
  this.revision=0;this.events=new Map();
  this.database.exec(`CREATE TABLE IF NOT EXISTS pet_friend_relation_v1 (
   actor TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
   target TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
   CHECK(actor<>target),PRIMARY KEY(actor,target)) STRICT;
   CREATE TABLE IF NOT EXISTS pet_friend_request_v1 (
   actor TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
   target TEXT NOT NULL REFERENCES pet(pet_id) ON DELETE CASCADE,
   time INTEGER NOT NULL,CHECK(actor<>target),PRIMARY KEY(actor,target)) STRICT;
   CREATE INDEX IF NOT EXISTS pet_friend_request_target_v1 ON pet_friend_request_v1(target,time);`);
  this.select=this.database.prepare('SELECT target FROM pet_friend_relation_v1 WHERE actor=?');
  this.exists=this.database.prepare('SELECT 1 FROM pet_friend_relation_v1 WHERE actor=? AND target=?');
 }
 targets(actor){return new Set(this.select.all(actor).map(r=>r.target));}
 packet(command,code,peer){return {command,body:Buffer.concat([word(code),peer?.profile.petIdBytes??Buffer.alloc(8),peer?.profile.login.petName??Buffer.alloc(16)])};}
 queue(target,packet){if(!this.events.has(target)&&this.events.size>=1024)this.events.delete(this.events.keys().next().value);const list=this.events.get(target)??[];if(list.length>=64)list.shift();list.push(packet);this.events.set(target,list);}
 rows(uin,isOnline){return this.friends.select.all().filter(r=>r.uin!==uin).map(r=>{
  const peer=this.friends.find(r.uin,r.pet_id),p=peer.profile;
  const ownerName=Buffer.alloc(16);gbkEncode(r.qq_name).subarray(0,15).copy(ownerName);
  return {uin:r.uin,id:p.petIdBytes,petName:p.login.petName,ownerName,vip:p.login.vipFlag,
   level:p.login.levelValue,online:Boolean(isOnline(r.uin,p.petIdBytes))};
 });}
 detail(row){return Buffer.concat([row.id,row.petName,row.ownerName,word(row.vip),Buffer.from([Number(row.online)]),dword(row.level)]);}
 version(actor){return createHash('sha256').update([...this.targets(actor)].sort().join(',')).digest().readUInt32BE()||1;}
 handle(command,request,uin,actorId,isOnline){
  const actor=key(actorId),self=this.friends.find(uin,actor);
  if(!self)throw Error('FRIEND_ACTOR_UNAVAILABLE');
  if(command===0x0952){
   const rows=this.rows(uin,isOnline).filter(r=>request.uin===0?r.online:r.uin===request.uin||Number(r.id.readBigUInt64LE()&0xffffffffn)===request.uin).slice(0,500);
   return [{command,body:Buffer.concat([word(0),word(rows.length),...rows.map(r=>this.detail(r))])}];
  }
  const target=key(request.target),peer=this.friends.find(undefined,target);
  const failure=()=>command===0x0957?[]:command===0x0954?[{command,body:Buffer.concat([word(1),request.target])}]:[this.packet(command,1,peer)];
  if(!peer||actor===target)return failure();
  const now=this.clock(),out=[],push=[];
  this.database.exec('SAVEPOINT friend_relationship');
  try{
   this.database.prepare('DELETE FROM pet_friend_request_v1 WHERE time<?').run(now-86400000);
   if(command===0x0956){
    if(this.exists.get(actor,target)||this.targets(actor).size>=500)return this.finish(failure());
    const pending=this.database.prepare('SELECT count(*) AS n FROM pet_friend_request_v1 WHERE actor=? OR target=?').get(actor,target).n;
    const existing=this.database.prepare('SELECT 1 FROM pet_friend_request_v1 WHERE actor=? AND target=?').get(actor,target);
    if(pending>=64&&!existing)return this.finish(failure());
    this.database.prepare('INSERT OR IGNORE INTO pet_friend_request_v1 VALUES(?,?,?)').run(actor,target,now);
    out.push(this.packet(command,0,peer));
   }else if(command===0x0957){
    const pending=this.database.prepare('SELECT 1 FROM pet_friend_request_v1 WHERE actor=? AND target=?').get(target,actor);
    if(!pending)return this.finish(failure());
    if(request.decision!==3&&(this.targets(target).size>=500||request.decision===2&&this.targets(actor).size>=500))return this.finish(failure());
    if(request.decision!==3)this.database.prepare('INSERT OR IGNORE INTO pet_friend_relation_v1 VALUES(?,?)').run(target,actor);
    if(request.decision===2)this.database.prepare('INSERT OR IGNORE INTO pet_friend_relation_v1 VALUES(?,?)').run(actor,target);
    this.database.prepare('DELETE FROM pet_friend_request_v1 WHERE actor=? AND target=?').run(target,actor);
    push.push([target,this.packet(0x0958,request.decision,self)]);
    if(request.decision!==3){
     const added=this.rows(peer.uin,isOnline).find(r=>r.id.equals(actorId));
     push.push([target,{command:0x0959,body:Buffer.concat([actorId,dword(this.version(target)),this.detail(added).subarray(8)])}]);
     if(request.decision===2){const back=this.rows(uin,isOnline).find(r=>r.id.equals(request.target));
      out.push({command:0x0959,body:Buffer.concat([request.target,dword(this.version(actor)),this.detail(back).subarray(8)])});}
    }
   }else if(command===0x0954){
    this.database.prepare('DELETE FROM pet_friend_relation_v1 WHERE actor=? AND target=?').run(actor,target);
    this.database.prepare('DELETE FROM pet_friend_request_v1 WHERE actor=? AND target=?').run(actor,target);
    out.push({command,body:Buffer.concat([word(0),dword(this.version(actor)),request.target])});
   }else throw TypeError('INVALID_FRIEND_COMMAND');
   this.beforeCommit();this.database.exec('RELEASE friend_relationship');
  }catch(error){this.database.exec('ROLLBACK TO friend_relationship');this.database.exec('RELEASE friend_relationship');throw error;}
  this.revision++;for(const [to,p]of push)if(isOnline(peer.uin,peer.profile.petIdBytes))this.queue(to,p);return out;
 }
 finish(result){this.database.exec('RELEASE friend_relationship');return result;}
 notifications(actorId,context){
  if(context.revision===this.revision)return [];
  context.revision=this.revision;context.seen??=new Set();
  const actor=key(actorId),now=this.clock(),out=this.events.get(actor)??[];this.events.delete(actor);
  const rows=this.database.prepare('SELECT actor,time FROM pet_friend_request_v1 WHERE target=? AND time>=? ORDER BY time LIMIT 64').all(actor,now-86400000);
  const seen=new Set();
  for(const r of rows){const token=r.actor+':'+r.time;seen.add(token);if(context.seen.has(token))continue;
   const peer=this.friends.find(undefined,r.actor);if(peer)out.push(this.packet(0x0957,this.exists.get(actor,r.actor)?2:1,peer));}
  context.seen=seen;return out;
 }
}
