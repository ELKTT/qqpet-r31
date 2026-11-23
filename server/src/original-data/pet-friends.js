import {PetFriendRelations} from './pet-friend-relations.js';
import {careMaximum} from './online-pet-state.js';
import {createHash} from 'node:crypto';
import {friendXml,friendXmlAttributes,friendGameXml} from '../protocol/friend-http.js';
import {encodeOtherPetInfoSuccess,encodeOtherPetInfoFailure} from '../protocol/other-pet-info.js';
import {PetFriendMessages} from './pet-friend-messages.js';
import {gbkEncode} from '../accounts/account-service.js';
import {decodeCommunityFriendRequest,projectCommunityFriends} from '../protocol/community-friends.js';

// User-approved source and initial zeroes (2026-10-02). This directory exposes
// adopted server pets through the original public contract, without QQ contact
// imports, client changes, credentials or a synthetic online flag. Love follows
// the user-approved 2026-10-02 local +1 / ten-points-per-level rule.
export class PetFriends {
  constructor({store,accounts,policy}) {
    if(!['all-server-pets','community-friends'].includes(policy)||!store?.database||typeof store.profileForUin!=='function'
        ||accounts?.database!==store.database||typeof accounts?.state!=='function')
      throw new TypeError('INVALID_FRIEND_POLICY');
    this.store=store;this.accounts=accounts;this.database=store.database;this.defaultPolicy=policy;
    this.database.exec("CREATE TABLE IF NOT EXISTS pet_friend_policy_v1 (id INTEGER PRIMARY KEY CHECK(id=1), policy TEXT NOT NULL CHECK(policy IN ('all-server-pets','community-friends'))) STRICT");
    this.database.exec(`CREATE TABLE IF NOT EXISTS pet_friend_love_v1 (
      actor_pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      target_pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      points INTEGER NOT NULL CHECK(points BETWEEN 0 AND 65535),
      CHECK(actor_pet_id<>target_pet_id),PRIMARY KEY(actor_pet_id,target_pet_id)) STRICT;
      CREATE TABLE IF NOT EXISTS pet_friend_game_receipts_v1 (
      actor_pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,love_add INTEGER NOT NULL CHECK(love_add BETWEEN 0 AND 1),
      PRIMARY KEY(actor_pet_id,request_id)) STRICT;`);
    this.select=this.database.prepare('SELECT p.uin,p.pet_id,p.sex,a.qq_name FROM pet p '+
      'JOIN account a USING(uin) JOIN qqpenguin_login_profile q USING(pet_id) '+
      'LEFT JOIN account_state_v1 s USING(uin) WHERE COALESCE(s.disabled,0)=0 ORDER BY p.uin,p.pet_id');
    const lookup='SELECT p.uin,p.pet_id,p.sex,a.qq_name FROM pet p '+
      'JOIN account a USING(uin) JOIN qqpenguin_login_profile q USING(pet_id) '+
      'LEFT JOIN account_state_v1 s USING(uin) WHERE COALESCE(s.disabled,0)=0 AND ';
    this.lookupUin=this.database.prepare(lookup+'p.uin=? LIMIT 2');
    this.lookupId=this.database.prepare(lookup+'p.pet_id=? LIMIT 2');
    this.lookupPair=this.database.prepare(lookup+'p.uin=? AND p.pet_id=? LIMIT 2');
    this.inbox=new PetFriendMessages(this);
    this.relations=new PetFriendRelations(this);
  }
  get policy(){return this.database.prepare('SELECT policy FROM pet_friend_policy_v1 WHERE id=1').get()?.policy??this.defaultPolicy;}
  setPolicy({policy,actorUin,reason=''}){
    if(!['all-server-pets','community-friends'].includes(policy))throw new TypeError('INVALID_FRIEND_POLICY');
    const result=this.accounts.runTransaction(()=>{
      const before=this.policy;
      this.database.prepare('INSERT INTO pet_friend_policy_v1 VALUES(1,?) ON CONFLICT(id) DO UPDATE SET policy=excluded.policy').run(policy);
      this.accounts.audit({actorUin,actorScope:'admin',action:'friend-policy',detail:{before,after:policy,reason:String(reason).slice(0,80)}});
      return policy;
    });
    this.relations.revision++;return result;
  }
  find(uin,petId) {
    if(uin!==undefined&&!Number.isInteger(uin)||petId!==undefined&&typeof petId!=='string')return null;
    const rows=uin===undefined?(petId===undefined?this.select.all().slice(0,2):this.lookupId.all(petId)):
      petId===undefined?this.lookupUin.all(uin):this.lookupPair.all(uin,petId);
    if(rows.length!==1)return null;
    const row=rows[0],profiles=this.store.profileForUin(row.uin);
    const profile=profiles.find(p=>p.petIdBytes.readBigUInt64LE().toString()===row.pet_id);
    return profile?{...row,profile}:null;
  }
  friendRows(uin){const actor=this.find(uin);const ids=actor?this.relations.targets(actor.pet_id):new Set();return this.select.all().filter(r=>r.uin!==uin&&(this.policy==='all-server-pets'||ids.has(r.pet_id)));}
  list(uin,{announcements=0}={}) {
    const profilesByUin=new Map();
    const children=this.friendRows(uin).map(row=>{
      if(!profilesByUin.has(row.uin))profilesByUin.set(row.uin,this.store.profileForUin(row.uin));
      const profile=profilesByUin.get(row.uin).find(p=>p.petIdBytes.readBigUInt64LE().toString()===row.pet_id);
      if(!profile)throw new Error('FRIEND_PROFILE_UNAVAILABLE');
      const p=profile.login;
      const love=this.progress(uin,row.pet_id);
      // Original FriendList also forwards this visible user nickname into the
      // target qqnickname used by the manor, pond and farm name consumers.
      return '<friend'+friendXmlAttributes({uin:row.uin,petid:row.pet_id,name:row.qq_name,
        vipflag:p.vipFlag,level:p.levelValue,status:p.unknown_0x4b===5?0:p.unknown_0x4b===0?2:1,
        fishflag:1,farmflag:1,love:love.value,lovelevel:love.level,viplevel:p.unknown_0x65})+'/>';
    }).join('');
    return friendXml({result:0,unread:this.inbox.unread(this.find(uin)?.pet_id??''),announcements},children);
  }
  messages(uin,kind) {return this.inbox.browse(uin,kind);}
  communityPackets(command,body,uin,actorId,isOnline) {
    const request=decodeCommunityFriendRequest(command,body,actorId);
    if([0x0952,0x0954,0x0956,0x0957].includes(command))return this.relations.handle(command,request,uin,actorId,isOnline);
    const nameBytes=text=>{const out=Buffer.alloc(16);let size=0;
      for(const c of text){const b=gbkEncode(c);if(size+b.length>16)break;b.copy(out,size);size+=b.length;}return out;};
    const rows=this.friendRows(uin).slice(0,500).map(r=>{
      const peer=this.find(r.uin,r.pet_id);if(!peer)throw new Error('FRIEND_PROFILE_UNAVAILABLE');
      return {uin:r.uin,id:peer.profile.petIdBytes,petName:peer.profile.login.petName,
        ownerName:nameBytes(r.qq_name),vip:peer.profile.login.vipFlag,level:peer.profile.login.levelValue,
        online:isOnline(r.uin,peer.profile.petIdBytes)};
    });
    return projectCommunityFriends(command,request,actorId,rows);
  }
  clearMessages(uin,kind) {return this.inbox.clear(uin,kind);}
  sendMessage(...args) {return this.inbox.send(...args);}
  name(p) {
    return this.text(p.petName);
  }
  text(bytes) {
    const end=bytes.indexOf(0);
    return new TextDecoder('gb18030',{fatal:true}).decode(end<0?bytes:bytes.subarray(0,end));
  }
  otherInfo(petId,actorUin) {
    const peer=this.find(undefined,petId.toString());
    if(!peer)return encodeOtherPetInfoFailure();
    const owner=Buffer.alloc(16);gbkEncode(peer.qq_name).subarray(0,15).copy(owner);
    return encodeOtherPetInfoSuccess({...peer.profile,login:{...peer.profile.login,masterName:owner}},this.progress(actorUin,peer.pet_id));
  }
  // 37C0 copies the pet id's low DWORD into qqnumber. Older local saves used a
  // sequence there instead of owner UIN. Resolve that proven wire alias without
  // rewriting durable pet ids; refuse any ambiguous owner/alias collision.
  sceneOwner(number) {
    const matches=this.select.all().filter(row=>row.uin===number||Number(BigInt(row.pet_id)&0xffffffffn)===number);
    return matches.length===1?this.find(matches[0].uin,matches[0].pet_id):null;
  }
  detail(uin,actorUin) {
    const peer=this.sceneOwner(uin);if(!peer)return friendXml({result:1,msg:'宠物不可访问'});
    const p=peer.profile.login,name=this.name(p),love=this.progress(actorUin,peer.pet_id);
    const pair=(tag,value,maxvalue)=>'<'+tag+friendXmlAttributes({value,maxvalue})+'/>';
    return friendXml({result:0},'<baseinfo'+friendXmlAttributes({petname:name,ownertitle:peer.qq_name,petlevel:p.levelValue,
      sex:peer.sex==='male'?102:peer.sex==='female'?103:-1})+'/>'+
      pair('starve',p.unknown_0x47,careMaximum(p.levelValue))+
      pair('clean',p.unknown_0x49,careMaximum(p.levelValue))+pair('health',p.unknown_0x4b,5)+
      pair('feel',p.unknown_0x4e,1000)+'<love'+friendXmlAttributes(love)+'/>');
  }
  goodsDetail(uin,actorUin) {
    const peer=this.sceneOwner(uin);if(!peer)return {result:1,msg:'宠物不可访问'};
    const p=peer.profile.login,pair=(value,maxvalue)=>({value,maxvalue});
    return {result:0,baseinfo:{petname:this.name(p),petlevel:p.levelValue,sex:peer.sex==='male'?0:peer.sex==='female'?1:-1},
      starve:pair(p.unknown_0x47,careMaximum(p.levelValue)),clean:pair(p.unknown_0x49,careMaximum(p.levelValue)),
      health:pair(p.unknown_0x4b,5),feel:pair(p.unknown_0x4e,1000),love:this.progress(actorUin,peer.pet_id)};
  }
  progress(actorUin,targetId) {
    const actor=actorUin===undefined?null:this.find(actorUin);
    const value=actor?this.database.prepare('SELECT points FROM pet_friend_love_v1 WHERE actor_pet_id=? AND target_pet_id=?')
      .get(actor.pet_id,targetId)?.points??0:0;
    return {value,level:Math.floor(value/10)};
  }
  // The caller owns the transaction with care inventory or game receipts.
  award(actorUin,actorBytes,targetUin,targetBytes) {
    const actor=this.find(actorUin,actorBytes.readBigUInt64LE().toString()),
      target=this.find(targetUin,targetBytes.readBigUInt64LE().toString());
    if(!actor||!target||actor.uin===target.uin)throw new Error('FRIEND_LOVE_PAIR_UNAVAILABLE');
    this.database.prepare('INSERT OR IGNORE INTO pet_friend_love_v1 VALUES(?,?,0)').run(actor.pet_id,target.pet_id);
    return Number(this.database.prepare('UPDATE pet_friend_love_v1 SET points=points+1 WHERE actor_pet_id=? AND target_pet_id=? AND points<65535')
      .run(actor.pet_id,target.pet_id).changes);
  }
  completeGame(actorUin,actorBytes,peer,{gameType,winFlag,timer},scope,now) {
    if(typeof scope!=='string'||scope.length===0||scope.length>200||![0,1].includes(gameType)||![0,1].includes(winFlag)
        ||!Number.isInteger(timer)||timer< -2147483648||timer>2147483647)throw new TypeError('FRIEND_GAME_INVALID');
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const actorId=actorBytes.readBigUInt64LE().toString(),requestId=digest([scope,timer]),fingerprint=digest([peer.pet_id,gameType,winFlag]);
    const previous=this.database.prepare('SELECT fingerprint,love_add FROM pet_friend_game_receipts_v1 WHERE actor_pet_id=? AND request_id=?')
      .get(actorId,requestId);
    if(previous)return previous.fingerprint===fingerprint?friendGameXml(0,previous.love_add):friendGameXml(1);
    const loveadd=this.award(actorUin,actorBytes,peer.uin,peer.profile.petIdBytes);
    this.inbox.record(actorId,peer.pet_id,1,gameType+1,'与你的宠物玩了'+(gameType===0?'拔河':'猜拳')+'，爱心指数 +'+loveadd,now);
    this.database.prepare('INSERT INTO pet_friend_game_receipts_v1 VALUES(?,?,?,?)').run(actorId,requestId,fingerprint,loveadd);
    this.database.prepare('DELETE FROM pet_friend_game_receipts_v1 WHERE actor_pet_id=? AND rowid NOT IN '+
      '(SELECT rowid FROM pet_friend_game_receipts_v1 WHERE actor_pet_id=? ORDER BY rowid DESC LIMIT 64)').run(actorId,actorId);
    return friendGameXml(0,loveadd);
  }
}
