import {HOME_COMMANDS,decodeHomeRequest,encodeHomeVisit,encodeHomeCurrent,encodeHomeConfigure,encodeHomeScene,encodeHomePositions} from '../protocol/legacy-home.js';
import {gbkEncode} from '../accounts/account-service.js';
import {randomInt,createHash} from 'node:crypto';

// Explicit, default-off compatibility policy. A supplied local scene is provisioned
// on the first own-home visit; it is not a historical purchase, reward or wallet item.
export function validateLegacyHomePolicy(p){
  if(!p||Object.keys(p).filter(k=>k!=='backgrounds').sort().join('|')!=='goodsHex|maxPets|name|resourceId|sceneSha256|version|x|y'
    ||p.version!==1||!/^[0-9a-f]{16}$/.test(p.goodsHex)||p.goodsHex==='0000000000000000'
    ||!Number.isInteger(p.resourceId)||p.resourceId<1||p.resourceId>0xffffffff
    ||!/^[0-9a-f]{64}$/.test(p.sceneSha256)||typeof p.name!=='string'||!p.name.trim()||/[<>\x00-\x1f]/.test(p.name)||gbkEncode(p.name).length>31
    ||![p.x,p.y].every(v=>Number.isInteger(v)&&v>=0&&v<=65535)
    ||!Number.isInteger(p.maxPets)||p.maxPets<1||p.maxPets>50)throw new TypeError('INVALID_LEGACY_HOME_POLICY');
  if(p.backgrounds&&(!Array.isArray(p.backgrounds)||p.backgrounds.length>128||p.backgrounds.some(b=>
    !Number.isInteger(b.resourceId)||b.resourceId<1||b.resourceId>0xffffffff||!Number.isInteger(b.price)||b.price<0||b.price>1000000
    ||typeof b.name!=='string'||!b.name.trim()||/[<>\x00-\x1f]/.test(b.name)||gbkEncode(b.name).length>31||!/^[a-f0-9]{16}$/.test(b.goodsHex)||b.goodsHex==='0000000000000000'
    ||!/^[a-f0-9]{64}$/.test(b.sceneSha256))))throw new TypeError('INVALID_HOME_BACKGROUNDS');
  if(p.backgrounds&&(new Set([p.resourceId,...p.backgrounds.map(b=>b.resourceId)]).size!==p.backgrounds.length+1
    ||new Set([p.goodsHex,...p.backgrounds.map(b=>b.goodsHex)]).size!==p.backgrounds.length+1))throw new TypeError('INVALID_HOME_BACKGROUNDS');
  return Object.freeze({...p});
}
export class LegacyHomeState{
  constructor({database,policy,beforeCommit=()=>{}}){
    this.policy=validateLegacyHomePolicy(policy);this.database=database;this.beforeCommit=beforeCommit;
    if(typeof database?.prepare!=='function'||typeof beforeCommit!=='function')throw new TypeError('INVALID_LEGACY_HOME_DATABASE');
    database.exec(`CREATE TABLE IF NOT EXISTS legacy_home_scene_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      goods_hex TEXT NOT NULL CHECK(length(goods_hex)=16),resource_id INTEGER NOT NULL CHECK(resource_id>0),
      scene_sha256 TEXT NOT NULL CHECK(length(scene_sha256)=64),x INTEGER NOT NULL CHECK(x BETWEEN 0 AND 65535),
      y INTEGER NOT NULL CHECK(y BETWEEN 0 AND 65535)) STRICT;`);
    database.exec(`CREATE TABLE IF NOT EXISTS legacy_home_settings_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,name TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_home_background_owned_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,resource INTEGER NOT NULL,PRIMARY KEY(pet_id,resource)) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_home_receipt_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,nonce TEXT NOT NULL,
      operation TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)),PRIMARY KEY(pet_id,nonce)) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_home_invite_v1 (
      host TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      target TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,time INTEGER NOT NULL,
      PRIMARY KEY(host,target)) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_home_guest_position_v1 (
      host TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,x INTEGER NOT NULL,y INTEGER NOT NULL,
      PRIMARY KEY(host,pet_id)) STRICT;`);
  }
  profileForId(petId) {
    if(!Buffer.isBuffer(petId)||petId.length!==8)throw new TypeError('INVALID_HOME_IDENTITY');
    const r=this.database.prepare('SELECT q.* FROM qqpenguin_login_profile q WHERE q.pet_id_bytes=?').get(petId);
    return r?{petIdBytes:Buffer.from(r.pet_id_bytes),login:{petName:Buffer.from(r.pet_name_bytes),levelValue:r.level_value,avatarVersion:r.avatar_version}}:null;
  }
  visitTargets(profile){
    // Match the existing all-server-pets friend policy: an adopted, usable
    // profile belonging to another owner. A pet row alone is not a home.
    const active=this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_state_v1'").get();
    return this.database.prepare('SELECT p.pet_id,p.pet_name FROM pet p JOIN qqpenguin_login_profile q USING(pet_id) '+
      (active?'LEFT JOIN account_state_v1 s ON s.uin=p.uin ':'')+
      'WHERE p.uin<>(SELECT uin FROM pet WHERE pet_id=?) '+(active?'AND COALESCE(s.disabled,0)=0 ':'')+'ORDER BY p.pet_id')
      .all(profile.petIdBytes.readBigUInt64LE().toString());
  }
  catalog(){return [{resourceId:this.policy.resourceId,name:'温暖的小家',price:0,goodsHex:this.policy.goodsHex,sceneSha256:this.policy.sceneSha256},...(this.policy.backgrounds??[])];}
  configuration(profile,row){
    const setting=this.database.prepare('SELECT name FROM legacy_home_settings_v1 WHERE pet_id=?').get(profile.petIdBytes.readBigUInt64LE().toString());
    // Native cache keys are opaque raw64 and ready entries are immutable.
    // A renamed home has its own stable configuration identity, separate from
    // the resourceId used to download the unchanged background artwork.
    const goods=setting?createHash('sha256').update('home-config-v1\0').update(profile.petIdBytes).update(row.goods_hex).update('\0'+setting.name).digest().subarray(0,8):Buffer.from(row.goods_hex,'hex');
    return {goods,name:setting?.name??this.policy.name};
  }
  accepts(command){return [HOME_COMMANDS.visit,HOME_COMMANDS.invite,HOME_COMMANDS.current,HOME_COMMANDS.configure,HOME_COMMANDS.move,HOME_COMMANDS.leave,HOME_COMMANDS.kick].includes(command);}
  scene(profile,create=false){
    const id=profile.petIdBytes.readBigUInt64LE().toString();
    if(create){
      this.database.exec('BEGIN IMMEDIATE');
      try{
        const p=this.policy;
        this.database.prepare('INSERT OR IGNORE INTO legacy_home_scene_v1 VALUES(?,?,?,?,?,?)')
          .run(id,p.goodsHex,p.resourceId,p.sceneSha256,p.x,p.y);
        this.beforeCommit();this.database.exec('COMMIT');
      }catch(error){this.database.exec('ROLLBACK');throw error;}
    }
    const row=this.database.prepare('SELECT goods_hex,resource_id,scene_sha256,x,y FROM legacy_home_scene_v1 WHERE pet_id=?').get(id);
    if(row&&!this.catalog().some(c=>row.goods_hex===c.goodsHex&&row.resource_id===c.resourceId&&row.scene_sha256===c.sceneSha256))
      throw new Error('LEGACY_HOME_CATALOGUE_CHANGED');
    return row;
  }
  notification(profile,row,context={}){
    if(!row)return {command:HOME_COMMANDS.scene,body:encodeHomeScene()};
    const host=context.homeHost??profile.petIdBytes,owner=this.profileForId(host)??profile;
    // A21 names the owner; A01 sceneName is the editable home name.
    const name=Buffer.alloc(16);owner.login.petName.copy(name,0,0,15);
    const live=this.presenceProfiles?.().filter(p=>p.context.inHome&&(p.context.homeHost??p.profile.petIdBytes).equals(host));
    const peers=live?.length?live.slice(0,this.policy.maxPets).map(p=>({pet:p.profile.petIdBytes,level:p.profile.login.levelValue,state:p.profile.login.statusId??0,
      informationVersion:p.profile.login.avatarVersion??0,x:p.context.homeX??row.x,y:p.context.homeY??row.y}))
      :[{pet:profile.petIdBytes,level:profile.login.levelValue,state:profile.login.statusId??0,informationVersion:profile.login.avatarVersion??0,x:row.x,y:row.y}];
    return {command:HOME_COMMANDS.scene,body:encodeHomeScene({host,name,target:profile.petIdBytes,resource:row.resource_id,
      goods:this.configuration(owner,row).goods,peers})};
  }
  handle(command,body,profile,context,now=Date.now()){
    const q=decodeHomeRequest(command,body),own=profile.petIdBytes;
    if(command===HOME_COMMANDS.invite){
      if(!q.source.equals(own))throw new Error('LEGACY_HOME_ACTOR_MISMATCH');
      const result=this.manage(profile,{operation:'home-invite',target:q.target.readBigUInt64LE().toString(),nonce:'native-'+randomInt(0x100000000).toString(16)+'-'+now},now);
      if(result.result===0){context.pendingInvites??=[];if(context.pendingInvites.length<32)context.pendingInvites.push(Buffer.from(q.target));}
      return [{command,body:encodeHomeVisit({code:result.result,message:gbkEncode(result.msg),opaque:q.target})}];
    }
    if(command===HOME_COMMANDS.kick){
      // HomeSystem 2B550 -> 20630/20850: authenticated owner raw64, guest raw64.
      const failure=()=>[{command,body:encodeHomeVisit({code:1,message:gbkEncode('只能请当前家园中的客人离开'),opaque:q.target})}];
      if(!q.source.equals(own)||!context.inHome||!(context.homeHost??own).equals(own)||q.target.equals(own))return failure();
      const guest=this.presenceProfiles?.().find(p=>p.profile.petIdBytes.equals(q.target)&&p.context.inHome&&(p.context.homeHost??p.profile.petIdBytes).equals(own));
      if(!guest)return failure();
      // Provision/validate the destination before changing either live context.
      const row=this.scene(guest.profile,true);
      guest.context.homeHost=Buffer.from(q.target);guest.context.homeX=row.x;guest.context.homeY=row.y;
      guest.context.revision=(guest.context.revision??0)+1;
      guest.context.pendingHomePackets=[this.notification(guest.profile,row,guest.context)];
      return [{command,body:encodeHomeVisit({opaque:q.target})}];
    }
    if(command===HOME_COMMANDS.leave){
      // HOME.Leave -> 27490 -> 296F0 reads base+216 (current host),
      // the same masterID exposed by 29CC0. 20DD0 sends that raw host;
      // the authenticated actor is already bound by the Root frame header.
      const host=context.homeHost??own;
      if(!q.host.equals(host))return [{command,body:encodeHomeVisit({code:1,message:gbkEncode('当前家园已改变,请重新进入后再试')})}];
      context.inHome=false;context.homeHost=null;
      return [{command,body:encodeHomeVisit()}];
    }
    if(command===HOME_COMMANDS.move){
      // A03 has no result decoder on this active protocol object. Only a
      // committed own-home movement produces the original A22 layout update.
      const host=context.homeHost??own,hostProfile=this.profileForId(host);
      if(!context.inHome||!q.host.equals(host)||!hostProfile||!this.scene(hostProfile))return [];
      this.database.exec('BEGIN IMMEDIATE');
      try{
        if(host.equals(own))this.database.prepare('UPDATE legacy_home_scene_v1 SET x=?,y=? WHERE pet_id=?').run(q.x,q.y,own.readBigUInt64LE().toString());
        this.database.prepare('INSERT INTO legacy_home_guest_position_v1 VALUES(?,?,?,?) ON CONFLICT(host,pet_id) DO UPDATE SET x=excluded.x,y=excluded.y')
          .run(host.readBigUInt64LE().toString(),own.readBigUInt64LE().toString(),q.x,q.y);
        this.beforeCommit();this.database.exec('COMMIT');
      }catch(error){this.database.exec('ROLLBACK');throw error;}
      context.homeX=q.x;context.homeY=q.y;context.revision=(context.revision??0)+1;
      return [{command:HOME_COMMANDS.positions,body:encodeHomePositions({host,peers:[{pet:own,x:q.x,y:q.y}]})}];
    }
    if(command===HOME_COMMANDS.visit){
      // 1FE70 sends the actor id first. Neither the frame nor this body may select
      // somebody else's identity. HOME.RndVisit -> 28330 -> 27CE0(0,0)
      // sends a zero target; leaving is the separate A08 request.
      if(!q.source.equals(own))throw new Error('LEGACY_HOME_ACTOR_MISMATCH');
      if(q.target.every(b=>b===0)){
        const targets=this.visitTargets(profile);
        if(!targets.length)return [{command,body:encodeHomeVisit({code:1,message:gbkEncode('暂时还没有可以拜访的小伙伴')})}];
        q.target.writeBigUInt64LE(BigInt(targets[randomInt(targets.length)].pet_id));
      }
      const owner=this.profileForId(q.target);
      if(!owner)return [{command,body:encodeHomeVisit({code:1,message:Buffer.from('Home unavailable')})}];
      const occupants=this.presenceProfiles?.().filter(p=>p.context.inHome&&(p.context.homeHost??p.profile.petIdBytes).equals(q.target)&&!p.profile.petIdBytes.equals(own))??[];
      if(occupants.length>=this.policy.maxPets)return [{command,body:encodeHomeVisit({code:1,message:Buffer.from('Home is full')})}];
      const row=this.scene(owner,true),saved=this.database.prepare('SELECT x,y FROM legacy_home_guest_position_v1 WHERE host=? AND pet_id=?')
        .get(q.target.readBigUInt64LE().toString(),own.readBigUInt64LE().toString());
      context.inHome=true;context.homeHost=Buffer.from(q.target);context.homeX=saved?.x??row.x;context.homeY=saved?.y??row.y;
      return [{command,body:encodeHomeVisit()},this.notification(profile,row,context)];
    }
    if(command===HOME_COMMANDS.current){
      if(!q.pet.equals(own))throw new Error('LEGACY_HOME_ACTOR_MISMATCH');
      const owner=this.profileForId(context.homeHost??own);
      return [{command,body:encodeHomeCurrent()},this.notification(profile,context.inHome&&owner?this.scene(owner):null,context)];
    }
    const owner=this.profileForId(q.host),row=owner&&context.inHome&&(context.homeHost??own).equals(q.host)?this.scene(owner):null;
    if(!row||!q.goods.equals(this.configuration(owner,row).goods))
      return [{command,body:encodeHomeConfigure({code:1,message:Buffer.from('Scene unavailable')})}];
    const name=Buffer.alloc(32);gbkEncode(this.configuration(owner,row).name).copy(name);
    return [{command,body:encodeHomeConfigure({goods:q.goods,resource:row.resource_id,name,level:1,maxPets:this.policy.maxPets})}];
  }
  manage(profile,q,now=Date.now()) {
    const own=profile.petIdBytes,id=own.readBigUInt64LE().toString(),row=this.scene(profile,true),fail=msg=>({result:1,msg});
    if(q.operation==='home-state') {
      const owned=this.database.prepare('SELECT resource FROM legacy_home_background_owned_v1 WHERE pet_id=?').all(id).map(r=>r.resource);
      const setting=this.database.prepare('SELECT name FROM legacy_home_settings_v1 WHERE pet_id=?').get(id);
      const players=this.visitTargets(profile).slice(0,200);
      const invites=this.database.prepare('SELECT i.host AS pet_id,p.pet_name FROM legacy_home_invite_v1 i JOIN pet p ON p.pet_id=i.host WHERE i.target=? AND i.time>?').all(id,now-86400000);
      return {result:0,name:setting?.name??this.policy.name,
        background:row.resource_id,backgrounds:this.catalog().map(b=>({id:b.resourceId,name:b.name,price:b.price,owned:b.resourceId===this.policy.resourceId||owned.includes(b.resourceId)})),
        players:players.map(p=>({petId:p.pet_id,name:p.pet_name})),invites:invites.map(p=>({petId:p.pet_id,name:p.pet_name}))};
    }
    if(q.operation==='home-random') {
      const rows=this.visitTargets(profile);
      return rows.length?{result:0,target:rows[randomInt(rows.length)].pet_id}:fail('暂时还没有可以拜访的小伙伴');
    }
    if(q.operation==='home-visit'||q.operation==='home-accept') {
      const target=Buffer.alloc(8);target.writeBigUInt64LE(BigInt(q.target));
      if(!this.profileForId(target))return fail('这个家园暂时无法拜访');
      if(q.operation==='home-accept') {
        const invite=this.database.prepare('SELECT time FROM legacy_home_invite_v1 WHERE host=? AND target=?').get(q.target,id);
        if(!invite||invite.time<=now-86400000)return fail('邀请已过期');
      }
      return {result:0,target:q.target};
    }
    if(typeof q.nonce!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(q.nonce))throw new TypeError('INVALID_HOME_NONCE');
    const fingerprint=JSON.stringify(q),past=this.database.prepare('SELECT operation,response_json FROM legacy_home_receipt_v1 WHERE pet_id=? AND nonce=?').get(id,q.nonce);
    if(past)return past.operation===fingerprint?JSON.parse(past.response_json):fail('请求标识冲突');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      let result;
      if(q.operation==='home-rename') {
        if(typeof q.name!=='string'||!q.name.trim()||/[<>\x00-\x1f]/.test(q.name)||gbkEncode(q.name).length>15)result=fail('家园名称最多 15 字节，请换一个短一点的名字');
        else {this.database.prepare('INSERT INTO legacy_home_settings_v1 VALUES(?,?) ON CONFLICT(pet_id) DO UPDATE SET name=excluded.name').run(id,q.name);result={result:0,msg:'家园改名成功'};}
      } else if(q.operation==='home-invite') {
        const target=Buffer.alloc(8);target.writeBigUInt64LE(BigInt(q.target));
        if(q.target===id||!this.profileForId(target))result=fail('请选择一个小伙伴');
        else {this.database.prepare('INSERT INTO legacy_home_invite_v1 VALUES(?,?,?) ON CONFLICT(host,target) DO UPDATE SET time=excluded.time').run(id,q.target,now);result={result:0,msg:'邀请已发送,小伙伴可以在游戏内接受,一天内有效'};}
      } else if(['home-buy','home-select'].includes(q.operation)) {
        const b=this.catalog().find(b=>b.resourceId===q.background),has=q.background===this.policy.resourceId||this.database.prepare('SELECT 1 FROM legacy_home_background_owned_v1 WHERE pet_id=? AND resource=?').get(id,q.background);
        const balance=this.database.prepare('SELECT unknown_0x67 AS value FROM qqpenguin_login_profile WHERE pet_id=?').get(id).value;
        if(!b)result=fail('这个背景的原资源尚未补齐');
        else if(q.operation==='home-buy'&&has)result={result:0,msg:'已经拥有这个背景啦'};
        else if(q.operation==='home-buy'&&balance<b.price)result=fail('元宝不足');
        else if(q.operation==='home-select'&&!has)result=fail('请先购买这个背景');
        else if(q.operation==='home-buy') {
          this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67-? WHERE pet_id=?').run(b.price,id);
          this.database.prepare('INSERT INTO legacy_home_background_owned_v1 VALUES(?,?)').run(id,b.resourceId);result={result:0,msg:'背景购买成功'};
        }else {this.database.prepare('UPDATE legacy_home_scene_v1 SET goods_hex=?,resource_id=?,scene_sha256=? WHERE pet_id=?').run(b.goodsHex,b.resourceId,b.sceneSha256,id);result={result:0,msg:'家园背景已更换'};}
      }else throw new TypeError('INVALID_HOME_OPERATION');
      if(result.result===0)this.database.prepare('INSERT INTO legacy_home_receipt_v1 VALUES(?,?,?,?)').run(id,q.nonce,fingerprint,JSON.stringify(result));
      this.beforeCommit();this.database.exec('COMMIT');return result;
    }catch(error){this.database.exec('ROLLBACK');throw error;}
  }
}
