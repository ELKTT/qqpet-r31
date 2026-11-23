import {randomBytes,timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {parseCommunityEntry} from './community-entry.js';
import {communityProfileBinding} from '../original-login/community-profile-binding.js';

// Local owner launch for the explicitly enabled webpage fallback. This is not TXSSO.
// Never reads client account directories, credentials, or historical cookies.
export function loadCommunityPet(filename,binding) {
  if(!binding)throw Error('COMMUNITY_BINDING_REQUIRED');
  return projectCommunityPet(filename,binding);
}

// Legacy offline single-pet helper; the live handoff uses loadCommunityPet.
export function loadSoleCommunityPet(filename) { return projectCommunityPet(filename,null); }

function projectCommunityPet(filename,binding) {
  const db=new DatabaseSync(filename,{readOnly:true});
  try {
    if(binding!==null && (!binding || typeof binding.generation!=='string'||!binding.generation
      ||binding.generation.length>128|| !/^[a-f0-9]{64}$/.test(binding.profileKey??'')))throw Error('COMMUNITY_BINDING_INVALID');
    let selected=null;
    if(binding){
      const matches=[];
      for(const row of db.prepare('SELECT pet_id,pet_id_bytes FROM qqpenguin_login_profile').iterate()){
        if(communityProfileBinding(binding.generation,Buffer.from(row.pet_id_bytes))===binding.profileKey)matches.push(row.pet_id);
      }
      if(matches.length!==1)throw Error('COMMUNITY_PROFILE_NOT_BOUND');
      selected=matches[0];
    }
    const rows=db.prepare(`SELECT p.pet_id,q.pet_id_bytes,q.pet_name_bytes,q.level_value,q.vip_flag,q.unknown_0x65
      FROM pet p JOIN qqpenguin_login_profile q USING(pet_id) ${binding?'WHERE p.pet_id=?':''} LIMIT 2`)
      .all(...(binding?[selected]:[]));
    if(rows.length!==1)throw new Error('COMMUNITY_REQUIRES_ONE_LOCAL_PET');
    const r=rows[0],id=Buffer.from(r.pet_id_bytes);
    if(id.length!==8 || id.readBigUInt64LE().toString()!==r.pet_id)throw new Error('COMMUNITY_PET_BINDING_INVALID');
    const bytes=Buffer.from(r.pet_name_bytes),end=bytes.indexOf(0);
    return validateCommunityPet({petId:r.pet_id,
      // QSP RVA 4676 (ORIG-IDENTITY-001): the PETGENDER producer compares the 16-bit word at
      // bytes 4..5 of the little-endian pet id against 102. Bytes 4..5 are bits 32..47; an
      // earlier version of this line read bits 48..63, which is where the adopted pet id used to
      // write the marker rather than where the client reads it. Producer and consumer agree now:
      // `createLocalPetId` places the marker at bits 32..47.
      gender:(BigInt(r.pet_id)>>32n&0xffffn)===102n?0:1,
      level:r.level_value,nickname:new TextDecoder('gb18030',{fatal:true}).decode(end<0?bytes:bytes.subarray(0,end)),
      vip:r.vip_flag,vipLevel:r.unknown_0x65});
  } finally { db.close(); }
}

export function validateCommunityPet(p) {
  if(!p || typeof p.petId!=='string' || !/^[1-9][0-9]{0,19}$/.test(p.petId)
      || BigInt(p.petId)>0xffffffffffffffffn || ![0,1].includes(p.gender)
      || !Number.isInteger(p.level) || p.level<0 || p.level>1000
      || typeof p.nickname!=='string' || !p.nickname || p.nickname.length>64
      || /[\x00-\x1f\x7f\ufffd]/.test(p.nickname) || !Number.isInteger(p.vip) || p.vip<0 || p.vip>255
      || !Number.isInteger(p.vipLevel) || p.vipLevel<0 || p.vipLevel>255)
    throw new TypeError('INVALID_COMMUNITY_PET');
  return Object.freeze({petId:p.petId,gender:p.gender,level:p.level,nickname:p.nickname,vip:p.vip,vipLevel:p.vipLevel});
}

export class CommunitySession {
  #pet; #grant; #cookie; #expires; #scene=null;
  constructor({pet,now=Date.now}) {
    this.#pet=validateCommunityPet(pet);this.now=now;
    this.#grant=randomBytes(32).toString('hex');this.#expires=now()+300000;this.grantExpires=this.#expires;
  }
  updatePet(pet) {
    const next=validateCommunityPet(pet);
    if(next.petId!==this.#pet.petId)throw TypeError('COMMUNITY_OWNER_CHANGED');
    this.#pet=next;
  }
  issueGrant() { this.#grant=randomBytes(32).toString('hex');this.grantExpires=this.now()+300000;return this.#grant; }
  capabilityActive() { return Boolean(this.#cookie) && this.now()<this.#expires; }
  launchCredential() { return this.#grant; }
  redeem(value) {
    if(!this.#grant || this.now()>=this.grantExpires || typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)
      || !timingSafeEqual(Buffer.from(value),Buffer.from(this.#grant)))return null;
    this.#grant=null;this.#cookie=randomBytes(32).toString('hex');this.#expires=this.now()+86400000;
    return this.#cookie;
  }
  authorized(cookie) {
    if(!this.#cookie || this.now()>=this.#expires || typeof cookie!=='string' || cookie.length>4096)return false;
    const entries=cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('qqpet_community='));
    if(entries.length!==1)return false;
    const value=entries[0].slice(16);
    return /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value),Buffer.from(this.#cookie));
  }
  profile(cookie) { if(!this.authorized(cookie))return null;return {...this.#pet}; }
  enter(cookie,choice,directory) {
    if(!this.authorized(cookie))return null;
    if(!choice || Object.keys(choice).length!==3 || typeof choice.region!=='string'
        || !Number.isInteger(choice.zone) || !Number.isInteger(choice.area))return null;
    const region=directory.snapshot().regions.find(r=>r.Name===choice.region);
    const zone=region?.Zooms.find(z=>z.ID===choice.zone);
    const area=zone?.Areas.find(a=>a.ID===choice.area);
    if(!zone || zone.Status>=3 || !area || area.Status>=3)return null;
    // Approved local entry policy: Fengyu Square's map center, verified walkable
    // against SceneConfig_1116/22 and NavigationMap_1116/22. No original wire claim.
    this.#scene={sceneId:22,x:1250,y:880,direction:4};
    return {...this.#scene};
  }
  findPath(cookie,request,navigation) {
    if(!this.authorized(cookie) || !this.#scene || !navigation || !request
        || Object.keys(request).length!==4 || !['x','y','targetX','targetY'].every(k=>Number.isFinite(request[k])))return null;
    const nav=typeof navigation.navigation==='function'?navigation.navigation(this.#scene.sceneId):navigation;
    return nav?nav.find({x:request.x,y:request.y},{x:request.targetX,y:request.targetY}):[];
  }
  changeScene(cookie,request,world,jump=false) {
    if(!this.authorized(cookie) || !this.#scene || !world || !request
        || Object.keys(request).length!==1 || !Number.isInteger(request.sceneId))return null;
    const next=jump?world.jumpDestination(request.sceneId):world.destination(this.#scene.sceneId,request.sceneId);
    if(!next)return null;
    this.#scene=next;return {...next};
  }
  sceneInfo(cookie,world) {
    if(!this.authorized(cookie) || !this.#scene || !world)return null;
    return world.describe(this.#scene.sceneId);
  }
  openPage(cookie,request,world) {
    if(!this.authorized(cookie) || !this.#scene || !request || Object.keys(request).length!==1 || !world)return null;
    return world.page(this.#scene.sceneId,request.url);
  }
  entryTarget(cookie,request,world) {
    if(!this.authorized(cookie) || !this.#scene || !request || Array.isArray(request)
        || Object.keys(request).length!==1 || typeof world?.npcTarget!=='function')return null;
    const entry=parseCommunityEntry(request.query);
    return entry===null?null:entry.npcId?world.npcTarget(entry.sceneId,entry.npcId):{};
  }
  close() { this.#grant=null;this.#cookie=null;this.#scene=null; }
}
