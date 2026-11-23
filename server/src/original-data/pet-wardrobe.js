import {createHash} from 'node:crypto';
import {encodeAvatarInfoSuccess} from '../protocol/community-avatar.js';

const uint=(n,max=0x7fffffff)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=msg=>({data:{result:1,ret:1,msg}});
const ok=data=>({result:0,ret:0,...data});
class WardrobeRefusal extends Error {}
const refuse=msg=>{throw new WardrobeRefusal(msg);};

// Approved local catalogue policy; identifiers/names are not historical market facts.
// Native seat/resource paths and the 053A/0559 consumers are authority-static.
export function validateWardrobeConfiguration(c) {
  if(!exact(c,['enabled','policy','items',...(c.previousDigests?['previousDigests']:[])])||c.enabled!==true
    ||!exact(c.policy,['id','unitPrice','permanent','unrestricted','visualOnly'])
    ||c.policy.id!=='local-community-wardrobe-permanent-v1'||c.policy.unitPrice!==1
    ||c.policy.permanent!==true||c.policy.unrestricted!==true||c.policy.visualOnly!==true
    ||!Array.isArray(c.items)||c.items.length<1||c.items.length>4096)throw new TypeError('INVALID_WARDROBE_CONFIGURATION');
  const cids=new Set(),keys=new Set();
  const items=c.items.map(i=>{
    const metadata=i.iconFile!==undefined?['description','gender','minLevel','maxLevel','iconFile','iconSha256']:[];
    if(!exact(i,['cid','seat','resourceId','name','sequenceTarget','sha256',...metadata,...(i.giftStage?['giftStage']:[])])||!uint(i.seat,9)||i.seat===0
      ||!uint(i.resourceId,65535)||i.resourceId===0||i.cid!==20000000+i.seat*100000+i.resourceId
      ||typeof i.name!=='string'||i.name.length<1||i.name.length>64||/[<>:\x00-\x1f]/u.test(i.name)
      ||! /^[a-f0-9]{64}$/.test(i.sha256??''))throw new TypeError('INVALID_WARDROBE_ITEM');
    if(metadata.length&&(typeof i.description!=='string'||i.description.length>1000||!['male','female',null].includes(i.gender)
      ||!uint(i.minLevel,1000)||!uint(i.maxLevel,1000)||(i.maxLevel!==0&&i.maxLevel<i.minLevel)
      ||!/^server\/assets\/wardrobe-icons\/[a-f0-9]{64}\.png$/.test(i.iconFile)||! /^[a-f0-9]{64}$/.test(i.iconSha256)
      ||!i.iconFile.endsWith('/'+i.iconSha256+'.png')))throw new TypeError('INVALID_WARDROBE_METADATA');
    if(i.giftStage!==undefined&&!['juvenile','adult'].includes(i.giftStage))throw new TypeError('INVALID_WARDROBE_GIFT');
    const seat=String(i.seat).padStart(3,'0'),rid=String(i.resourceId).padStart(5,'0');
    if(i.sequenceTarget!==`/NewQQPet/common/petsoc/Data/res/Avatar/${seat}/${seat}${rid}.png`
      ||cids.has(i.cid)||keys.has(`${i.seat}:${i.resourceId}`))throw new TypeError('INVALID_WARDROBE_ITEM');
    cids.add(i.cid);keys.add(`${i.seat}:${i.resourceId}`);return Object.freeze({...i});
  });
  if(c.previousDigests&&(!Array.isArray(c.previousDigests)||c.previousDigests.length>32||c.previousDigests.some(d=>!/^[a-f0-9]{64}$/.test(d))))throw new TypeError('INVALID_WARDROBE_UPGRADES');
  return Object.freeze({enabled:true,policy:Object.freeze({...c.policy}),items:Object.freeze(items),...(c.previousDigests?{previousDigests:Object.freeze([...c.previousDigests])}:{})});
}

// Wallet, care stock, GID allocation and wardrobe writes share PostEntryState's
// SQLite checkpoint. A savepoint also lets a refused mixed cart retain the normal
// business failure envelope without committing any part of that cart.
export class PetWardrobe {
  constructor({database,careEconomy,configuration,resourceOrigin=''}) {
    this.configuration=validateWardrobeConfiguration(configuration);
    if(careEconomy?.database!==database||typeof careEconomy.reserveInventoryIds!=='function')throw new TypeError('WARDROBE_REQUIRES_SHARED_CARE');
    if(resourceOrigin!==''&&!/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(resourceOrigin))throw new TypeError('WARDROBE_RESOURCE_ORIGIN_INVALID');
    this.database=database;this.careEconomy=careEconomy;this.resourceOrigin=resourceOrigin;
    this.items=new Map(this.configuration.items.map(i=>[i.cid,i]));
    this.resources=new Map(this.configuration.items.map(i=>[`${i.seat}:${i.resourceId}`,i]));
    if([...this.items.keys()].some(cid=>careEconomy.items.has(cid)))throw new TypeError('WARDROBE_CID_COLLISION');
    this.digest=createHash('sha256').update(JSON.stringify(this.configuration)).digest('hex');
    database.exec(`CREATE TABLE IF NOT EXISTS pet_wardrobe_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      avatar_version INTEGER NOT NULL CHECK(avatar_version BETWEEN 0 AND 65535),
      equipped_json TEXT NOT NULL CHECK(json_valid(equipped_json))) STRICT;
      CREATE TABLE IF NOT EXISTS pet_wardrobe_owned_v1 (
      pet_id TEXT NOT NULL REFERENCES pet_wardrobe_v1(pet_id) ON DELETE CASCADE,
      cid INTEGER NOT NULL, gid INTEGER NOT NULL CHECK(gid BETWEEN 1 AND 2147483647),
      PRIMARY KEY(pet_id,cid),UNIQUE(pet_id,gid)) STRICT;`);
    database.exec(`CREATE TABLE IF NOT EXISTS pet_wardrobe_gift_v1 (
      pet_id TEXT NOT NULL REFERENCES pet_wardrobe_v1(pet_id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN ('juvenile','adult')),PRIMARY KEY(pet_id,stage)) STRICT;`);
  }
  identity(uin,petId) {return this.careEconomy.profile(uin,petId).pet_id;}
  initialize(uin,petId) {
    const id=this.identity(uin,petId),r=this.database.prepare('SELECT avatar_version FROM qqpenguin_login_profile WHERE pet_id=?').get(id);
    this.database.prepare('INSERT OR IGNORE INTO pet_wardrobe_v1 VALUES(?,?,?,?)').run(id,this.digest,r.avatar_version,'[]');
    this.load(id);
    this.grantMilestones(uin,petId);
  }
  selection(value) {
    if(!Array.isArray(value)||value.length>9)throw new TypeError('WARDROBE_SELECTION_INVALID');
    const seats=new Set();
    const selected=value.map(i=>{
      if(!exact(i,['seat','resourceId'])||!uint(i.seat,9)||!i.seat||!uint(i.resourceId,65535)||!i.resourceId
        ||seats.has(i.seat)||!this.resources.has(`${i.seat}:${i.resourceId}`))throw new TypeError('WARDROBE_SELECTION_INVALID');
      seats.add(i.seat);return {seat:i.seat,resourceId:i.resourceId};
    });
    return selected.sort((a,b)=>a.seat-b.seat);
  }
  load(id) {
    const row=this.database.prepare('SELECT * FROM pet_wardrobe_v1 WHERE pet_id=?').get(id);
    if(row&&this.configuration.previousDigests?.includes(row.policy_digest)) {
      this.database.prepare('UPDATE pet_wardrobe_v1 SET policy_digest=? WHERE pet_id=?').run(this.digest,id);row.policy_digest=this.digest;
    }
    if(!row||row.policy_digest!==this.digest||!uint(row.avatar_version,65535))throw new Error('WARDROBE_SAVED_STATE_INVALID');
    const equipped=this.selection(JSON.parse(row.equipped_json));
    const owned=this.database.prepare('SELECT cid,gid FROM pet_wardrobe_owned_v1 WHERE pet_id=? ORDER BY cid').all(id);
    const care=this.careEconomy.load(id),careIds=new Set(care.inventory.map(i=>i.gid));
    if(owned.length>this.items.size||owned.some(i=>!this.items.has(i.cid)||!uint(i.gid)||!i.gid||i.gid>=care.nextGid||careIds.has(i.gid))
      ||equipped.some(i=>!owned.some(o=>o.cid===this.resources.get(`${i.seat}:${i.resourceId}`).cid)))throw new Error('WARDROBE_SAVED_STATE_INVALID');
    return {...row,equipped,owned};
  }
  project(uin,petId) {return {avatarVersion:this.load(this.identity(uin,petId)).avatar_version};}
  grantMilestones(uin,petId) {
    const id=this.identity(uin,petId),profile=this.careEconomy.profile(uin,petId);
    const sex=this.database.prepare('SELECT sex FROM pet WHERE pet_id=?').get(id).sex;
    this.database.exec('SAVEPOINT wardrobe_gifts');
    try {
      for(const stage of ['juvenile','adult']) {
        if(profile.level<(stage==='adult'?10:5)||this.database.prepare('SELECT 1 FROM pet_wardrobe_gift_v1 WHERE pet_id=? AND stage=?').get(id,stage))continue;
        const items=[...this.items.values()].filter(i=>i.giftStage===stage&&(!i.gender||i.gender===sex));
        if(!items.length)continue;
        const current=this.load(id),missing=items.filter(i=>!current.owned.some(o=>o.cid===i.cid));
        const gids=this.careEconomy.reserveInventoryIds(uin,petId,missing.length);
        for(let n=0;n<missing.length;n++)this.database.prepare('INSERT INTO pet_wardrobe_owned_v1 VALUES(?,?,?)').run(id,missing[n].cid,gids[n]);
        // Only a newly delivered milestone changes the outfit. Its receipt keeps
        // later logins from overwriting the owner's own wardrobe choice.
        const worn=new Map(current.equipped.map(i=>[i.seat,i]));
        for(const i of items)if(this.eligible(i,{...profile,sex}))worn.set(i.seat,{seat:i.seat,resourceId:i.resourceId});
        const equipped=this.selection([...worn.values()]);
        if(JSON.stringify(equipped)!==JSON.stringify(current.equipped)) {
          const version=(current.avatar_version+1)&65535;
          this.database.prepare('UPDATE pet_wardrobe_v1 SET avatar_version=?,equipped_json=? WHERE pet_id=?').run(version,JSON.stringify(equipped),id);
          this.database.prepare('UPDATE qqpenguin_login_profile SET avatar_version=? WHERE pet_id=?').run(version,id);
        }
        this.database.prepare('INSERT INTO pet_wardrobe_gift_v1 VALUES(?,?)').run(id,stage);
      }
      this.database.exec('RELEASE wardrobe_gifts');
    } catch(error) {this.database.exec('ROLLBACK TO wardrobe_gifts');this.database.exec('RELEASE wardrobe_gifts');throw error;}
  }
  eligible(i,r){return (!i.gender||i.gender===r.sex)&&r.level>=(i.minLevel??0)&&(!i.maxLevel||r.level<=i.maxLevel);}
  itemView(i,owned) {
    return {cid:i.cid,gid:owned?.gid??0,name:i.name,desc:i.description??'',seat:i.seat,resourceId:i.resourceId,price:1,num:1,
      level_min:i.minLevel??0,level_max:i.maxLevel??0,gender:i.gender??null,
      sequenceUrl:this.resourceOrigin+i.sequenceTarget,iconUrl:i.iconFile?`http://img.pet.qq.com/avatar/${i.seat}/${i.resourceId}.png`:null,permanent:true};
  }
  request(uin,petId,onlineMs,q) {
    const id=this.identity(uin,petId),s=this.load(id),r=this.careEconomy.profile(uin,petId);
    if(q.operation==='avatar-shop'||q.operation==='avatar-store') {
      if(!uint(q.seat,9))throw new TypeError('WARDROBE_CATEGORY_INVALID');
      const list=q.operation==='avatar-shop'?[...this.items.values()]:s.owned.map(o=>this.items.get(o.cid));
      // The shelf must show future-level and opposite-sex items as well; their
      // native level fields and purchase/equip checks still enforce eligibility.
      // Fully identified entries are first so the newly restored names/icons do
      // not disappear behind hundreds of unresolved catalogue rows.
      const visible=list.filter(i=>(!q.seat||i.seat===q.seat)&&(q.operation!=='avatar-shop'||!i.giftStage));
      if(q.operation==='avatar-shop')visible.sort((a,b)=>Number(Boolean(b.iconFile))-Number(Boolean(a.iconFile))||a.cid-b.cid);
      return {data:ok({data:{yb:r.yuanbao,items:visible.map(i=>this.itemView(i,s.owned.find(o=>o.cid===i.cid)))}})};
    }
    if(q.operation==='avatar-frame')return {data:ok({avatar:s.equipped.map(i=>({pos:i.seat,res:i.resourceId,did:i.resourceId,cid:0,strcart:''}))})};
    if(q.operation==='avatar-save') {
      if(!Array.isArray(q.shows)||q.shows.length) return fail('此目录暂不支持背景或套装保存');
      let chosen;try{chosen=this.selection(q.avatars);}catch{return fail('装扮位置或资源编号不正确');}
      if(chosen.some(i=>!s.owned.some(o=>o.cid===this.resources.get(`${i.seat}:${i.resourceId}`).cid)))return fail('请先购买所选装扮');
      if(chosen.some(i=>!this.eligible(this.resources.get(`${i.seat}:${i.resourceId}`),r)))return fail('装扮不适合当前性别或成长阶段');
      if(JSON.stringify(chosen)===JSON.stringify(s.equipped))return {data:ok({msg:'装扮已保存'})};
      const version=(s.avatar_version+1)&65535;
      this.database.prepare('UPDATE pet_wardrobe_v1 SET avatar_version=?,equipped_json=? WHERE pet_id=?').run(version,JSON.stringify(chosen),id);
      this.database.prepare('UPDATE qqpenguin_login_profile SET avatar_version=? WHERE pet_id=?').run(version,id);
      return {data:ok({msg:'装扮保存成功'}),avatarVersion:version};
    }
    if(q.operation!=='avatar-cart')throw new TypeError('WARDROBE_OPERATION_INVALID');
    this.database.exec('SAVEPOINT wardrobe_cart');
    try {
      if(!Array.isArray(q.lines)||!q.lines.length||q.lines.length>32)refuse('购物车物品不正确');
      const care=[],avatars=new Map();
      for(const line of q.lines) {
        if(!uint(line?.cid)||!line.cid||!uint(line.count,99)||!line.count)refuse('物品或数量不正确');
        if(this.items.has(line.cid)) {
          const item=this.items.get(line.cid);if(item.giftStage)refuse('成长赠送装扮不在商城出售');
          if(!this.eligible(item,r))refuse('装扮不适合当前性别或成长阶段');
          avatars.set(line.cid,(avatars.get(line.cid)??0)+line.count);
        }
        else if(this.careEconomy.items.has(line.cid))care.push(line);
        else refuse('物品不存在');
      }
      if([...avatars.values()].some(n=>n!==1))refuse('永久装扮每款只需购买一件');
      let careTotal=0;
      if(care.length) {
        const report=this.careEconomy.request(uin,petId,onlineMs,{operation:'cart',lines:care});
        if(report.data.result!==0)refuse(report.data.msg);
        careTotal=Number(report.data.total);
      }
      const fresh=[...avatars.keys()].filter(cid=>!s.owned.some(o=>o.cid===cid));
      const balance=this.careEconomy.profile(uin,petId).yuanbao;
      if(balance<fresh.length)refuse('元宝不足');
      const gids=this.careEconomy.reserveInventoryIds(uin,petId,fresh.length);
      for(let n=0;n<fresh.length;n++)this.database.prepare('INSERT INTO pet_wardrobe_owned_v1 VALUES(?,?,?)').run(id,fresh[n],gids[n]);
      this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(balance-fresh.length,id);
      this.database.exec('RELEASE wardrobe_cart');
      return {data:ok({yb:balance-fresh.length,total:String(careTotal+fresh.length),msg:fresh.length||care.length?'购买成功':'已持有该装扮，无需重复购买'}),
        ...(fresh.length||care.length?{notify:'attributes'}:{})};
    } catch(error) {
      this.database.exec('ROLLBACK TO wardrobe_cart');this.database.exec('RELEASE wardrobe_cart');
      if(error instanceof WardrobeRefusal)return fail(error.message);
      throw error;
    }
  }
  infoResponse(petIds) {
    if(petIds.length>10)return Buffer.from('00010000','hex');
    const records=[];
    for(const petId of petIds) {
      const r=this.database.prepare(`SELECT q.*,p.vip_year_flag,p.current_title FROM qqpenguin_login_profile q
        JOIN pet p USING(pet_id) WHERE q.pet_id_bytes=?`).get(petId);
      if(!r)return Buffer.from('00010000','hex');
      const stored=this.database.prepare('SELECT 1 FROM pet_wardrobe_v1 WHERE pet_id=?').get(r.pet_id);
      const s=stored?this.load(r.pet_id):{avatar_version:r.avatar_version,equipped:[]};
      // The complete baseline persists a textual optional title. None projects to
      // native title ID 0; do not reinterpret an arbitrary title name as an ID.
      const title=r.current_title===null?0:/^(?:0|[1-9][0-9]{0,4})$/.test(r.current_title)?Number(r.current_title):NaN;
      if(!uint(title,65535)||!uint(r.unknown_0x65,255)||!uint(r.vip_year_flag,1))return Buffer.from('00010000','hex');
      records.push({petIdBytes:Buffer.from(petId),petNickBytes:Buffer.from(r.pet_name_bytes),ownerNickBytes:Buffer.from(r.master_name_bytes),
        level:r.level_value,vipFlag:r.vip_flag,avatarVersion:s.avatar_version,avatars:s.equipped,titleId:title,
        recordExtension:Buffer.alloc(0),opaqueTailBytes:Buffer.from([r.unknown_0x65,r.vip_year_flag])});
    }
    return encodeAvatarInfoSuccess(records);
  }
}
