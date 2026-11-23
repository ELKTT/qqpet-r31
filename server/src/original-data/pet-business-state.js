import {createHash} from 'node:crypto';
import {encodeCommInteractFailure,encodeCommInteractSuccess} from '../protocol/comm-interact.js';
import {encodeFlashBusinessResponse} from '../protocol/flash-business.js';
import {PetManorState} from './pet-manor-state.js';
import {PetBusinessBenefits,BUSINESS_FEED_PRICE,BUSINESS_FEED_ADVANCE_MS,FISHING_POWER_COST} from './pet-business-benefits.js';

const MAX=0x7fffffff;
const uint=(v,max=MAX)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const catalogKeys=['speciesId','name','buyYuanbao','sellYuanbao','matureOnlineSeconds','capacity'];
const itemKeys=['speciesId','name','level','vipOnly'];
const catalogIds={fish:[1,2,3,4,5,7,8],farm:[1,2,3,4,5,6,7,8]};
const emptyState=()=>({nextFishId:1,fishHarvestCount:0,fish:[],farm:[],lastInteractionAt:null,lastFishBuyAt:null,lastFarmBuyAt:null});
export function validatePetBusinessPolicy(p) {
  const expanded=p?.id==='local-pet-business-v3';
  if(!exact(p,['id','interactionMood','interactionCooldownMs','interactionUnknownKey2','purchaseCooldownMs','fish','farm',...(expanded?['previousDigest']:[]),...(Object.hasOwn(p??{},'previousCatalogDigest')?['previousCatalogDigest']:[]),...(Object.hasOwn(p??{},'previousBalanceDigest')?['previousBalanceDigest','sharingProfitPercent','paidAccelerationLimit']:[])])
      ||!['local-pet-business-v1','local-pet-business-v2','local-pet-business-v3'].includes(p.id)||!uint(p.interactionMood,1000)||p.interactionMood===0
      ||!uint(p.interactionCooldownMs,86400000)||p.interactionCooldownMs<1000
      ||!uint(p.interactionUnknownKey2,0xffffffff)||!uint(p.purchaseCooldownMs,60000)||p.purchaseCooldownMs<1000)
    throw new TypeError('INVALID_PET_BUSINESS_POLICY');
  const catalogs={};
  for(const [kind,max] of [['fish',3],['farm',6]]) {
    const c=p[kind];
    if(!exact(c,p.id!=='local-pet-business-v1'?[...catalogKeys,'items']:catalogKeys)||c.speciesId!==(kind==='fish'?2:3)||typeof c.name!=='string'
        ||! /^[\p{L}\p{N} ]{1,16}$/u.test(c.name)||!uint(c.buyYuanbao,1000000)||c.buyYuanbao===0
        ||!uint(c.sellYuanbao,1000000)||c.sellYuanbao<c.buyYuanbao
        ||!uint(c.matureOnlineSeconds,86400000)||c.matureOnlineSeconds<60
        ||!uint(c.capacity,max)||c.capacity===0)throw new TypeError('INVALID_PET_BUSINESS_POLICY');
    catalogs[kind]=Object.freeze(Object.fromEntries(catalogKeys.map(k=>[k,c[k]])));
    if(p.id!=='local-pet-business-v1') {
      if(!Array.isArray(c.items)||(expanded?c.items.length<1||c.items.length>128:c.items.length!==catalogIds[kind].length)
          ||new Set(c.items.map(i=>i?.speciesId)).size!==c.items.length
          ||c.items.some(i=>!exact(i,expanded?[...itemKeys,'buyYuanbao','sellYuanbao','matureOnlineSeconds','quantity','avatar','plantFlag']:itemKeys)
            ||(expanded?!uint(i.speciesId,65535)||i.speciesId===0:!catalogIds[kind].includes(i.speciesId))
            ||typeof i.name!=='string'||! /^[\p{L}\p{N} ()·-]{1,64}$/u.test(i.name)
            ||!uint(i.level,expanded?1000:100)||typeof i.vipOnly!=='boolean'
            ||(expanded&&(!uint(i.buyYuanbao,1000000)||!i.buyYuanbao||!uint(i.sellYuanbao,1000000)
              ||!uint(i.matureOnlineSeconds,86400000)||i.matureOnlineSeconds<60||!uint(i.quantity,10000)||!i.quantity
              ||!uint(i.avatar,65535)||!uint(i.plantFlag,0xffffffff))))
          ||(!expanded&&c.items.filter(i=>i.vipOnly).length!==1)||!c.items.find(i=>i.speciesId===c.speciesId&&!i.vipOnly))
        throw new TypeError('INVALID_PET_BUSINESS_POLICY');
      catalogs[kind]=Object.freeze({...catalogs[kind],items:Object.freeze(c.items.map(i=>Object.freeze({...i})))});
    }
  }
  if(expanded&&!/^[a-f0-9]{64}$/.test(p.previousDigest))throw new TypeError('INVALID_PET_BUSINESS_POLICY');
  if(Object.hasOwn(p,'previousCatalogDigest')&&(!expanded||!/^[a-f0-9]{64}$/.test(p.previousCatalogDigest)))throw new TypeError('INVALID_PET_BUSINESS_POLICY');
  if(Object.hasOwn(p,'previousBalanceDigest')&&(!expanded||!/^[a-f0-9]{64}$/.test(p.previousBalanceDigest)||p.sharingProfitPercent!==20||p.paidAccelerationLimit!==1))throw new TypeError('INVALID_PET_BUSINESS_POLICY');
  return Object.freeze({id:p.id,interactionMood:p.interactionMood,interactionCooldownMs:p.interactionCooldownMs,
    interactionUnknownKey2:p.interactionUnknownKey2,purchaseCooldownMs:p.purchaseCooldownMs,...catalogs,...(expanded?{previousDigest:p.previousDigest}:{}),
    ...(p.previousCatalogDigest?{previousCatalogDigest:p.previousCatalogDigest}:{}),
    ...(p.previousBalanceDigest?{previousBalanceDigest:p.previousBalanceDigest,sharingProfitPercent:p.sharingProfitPercent,paidAccelerationLimit:p.paidAccelerationLimit}:{})});
}

function validateSaved(s,p) {
  const stamp=v=>v===null||uint(v,0xffffffff*1000);
  if(!exact(s,['nextFishId','fishHarvestCount','fish','farm','lastInteractionAt','lastFishBuyAt','lastFarmBuyAt'])
      ||!uint(s.nextFishId)||s.nextFishId===0||!uint(s.fishHarvestCount)
      ||!stamp(s.lastInteractionAt)||!stamp(s.lastFishBuyAt)||!stamp(s.lastFarmBuyAt))
    throw new Error('INVALID_PET_BUSINESS_STATE');
  for(const kind of ['fish','farm']) {
    const items=s[kind];
    if(!Array.isArray(items)||items.length>(kind==='fish'?5:9)||new Set(items.map(i=>i?.id)).size!==items.length
        ||items.some(i=>{
          const keys=p.id!=='local-pet-business-v1'?['id','bornOnlineMs','speciesId','paidYuanbao']:['id','bornOnlineMs'];
          if(Object.hasOwn(i,'paidFeedUsed')){if(!p.paidAccelerationLimit||typeof i.paidFeedUsed!=='boolean')return true;keys.push('paidFeedUsed');}
          const maxAdvance=p.id==='local-pet-business-v3'?(p[kind].items.find(c=>c.speciesId===i.speciesId)?.matureOnlineSeconds??0)*1000:BUSINESS_FEED_ADVANCE_MS;
          return !(exact(i,keys)||exact(i,[...keys,'acceleratedOnlineMs']))||!uint(i.acceleratedOnlineMs??0,maxAdvance)||!uint(i.id,kind==='fish'?MAX:8)
          ||(kind==='fish'&&(i.id===0||i.id>=s.nextFishId))||!uint(i.bornOnlineMs,0xffffffff*1000);
        }))
      throw new Error('INVALID_PET_BUSINESS_STATE');
    if(p.id!=='local-pet-business-v1'&&items.some(i=>!p[kind].items.some(c=>c.speciesId===i.speciesId)
        ||(p.id==='local-pet-business-v3'?!uint(i.paidYuanbao,1000000):![p[kind].buyYuanbao,Math.floor(p[kind].buyYuanbao*0.8)].includes(i.paidYuanbao))))
      throw new Error('INVALID_PET_BUSINESS_STATE');
  }
}

export class PetBusinessState {
  constructor({database,policy,membership,desktopTasks,friends,coinValueFactory}) {
    if(friends&&(friends.database!==database||typeof friends.find!=='function'))throw new TypeError('FRIENDS_DATABASE_MISMATCH');
    this.friends=friends;
    this.manor=friends?new PetManorState({database,friends,coinValueFactory,
      entranceStatus:(peer,onlineMs)=>this.entranceStatus(peer,onlineMs)}):null;
    if(desktopTasks&&desktopTasks.database!==database)throw new TypeError('TOOLBAR_DATABASE_MISMATCH');
    this.desktopTasks=desktopTasks;
    this.database=database;this.policy=validatePetBusinessPolicy(policy);this.benefits=new PetBusinessBenefits(database);
    if(membership&&membership.database!==database)throw new TypeError('MEMBERSHIP_DATABASE_MISMATCH');
    this.membership=membership;
    this.digest=createHash('sha256').update(JSON.stringify(this.policy)).digest('hex');
    this.legacyPolicy=this.policy.id==='local-pet-business-v2'?validatePetBusinessPolicy({...this.policy,id:'local-pet-business-v1',
      fish:Object.fromEntries(catalogKeys.map(k=>[k,this.policy.fish[k]])),farm:Object.fromEntries(catalogKeys.map(k=>[k,this.policy.farm[k]]))}):null;
    this.legacyDigest=this.legacyPolicy?createHash('sha256').update(JSON.stringify(this.legacyPolicy)).digest('hex'):null;
    database.exec(`CREATE TABLE IF NOT EXISTS pet_business_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
      state_json TEXT NOT NULL CHECK(json_valid(state_json))) STRICT;`);
    this.select=database.prepare(`SELECT q.pet_id,q.level_value AS level,q.unknown_0x4e AS mood,q.unknown_0x67 AS yuanbao
      FROM qqpenguin_login_profile q JOIN pet p ON p.pet_id=q.pet_id WHERE p.uin=? AND q.pet_id_bytes=?`);
  }
  profile(uin,petId) {
    const r=this.select.get(uin,petId);
    if(!r||!uint(r.level,1000)||!uint(r.mood,1000)||!uint(r.yuanbao))throw new Error('INVALID_PET_BUSINESS_PROFILE');
    return r;
  }
  initialize(uin,petId) {
    const r=this.profile(uin,petId);
    if(!this.database.prepare('SELECT 1 FROM pet_business_v1 WHERE pet_id=?').get(r.pet_id))
      this.database.prepare('INSERT INTO pet_business_v1 VALUES(?,?,?)').run(r.pet_id,this.digest,
        JSON.stringify(emptyState()));
    this.load(r.pet_id);
  }
  load(pet,allowUninitialized=false) {
    const r=this.database.prepare('SELECT * FROM pet_business_v1 WHERE pet_id=?').get(pet);
    if(!r&&allowUninitialized)return emptyState();
    if(this.policy.id==='local-pet-business-v3'&&[this.policy.previousDigest,this.policy.previousCatalogDigest,this.policy.previousBalanceDigest].filter(Boolean).includes(r?.policy_digest)) {
      const state=JSON.parse(r.state_json);validateSaved(state,this.policy);
      if(!allowUninitialized)this.database.prepare('UPDATE pet_business_v1 SET policy_digest=? WHERE pet_id=?').run(this.digest,pet);
      return state;
    }
    if(r?.policy_digest===this.legacyDigest&&this.legacyPolicy) {
      const old=JSON.parse(r.state_json);validateSaved(old,this.legacyPolicy);
      for(const kind of ['fish','farm'])old[kind]=old[kind].map(item=>({...item,
        speciesId:this.policy[kind].speciesId,paidYuanbao:this.policy[kind].buyYuanbao}));
      validateSaved(old,this.policy);
      // Peer queries stay read-only. The owner's next checkpoint atomically pins
      // the approved v2 catalogue without losing stock, time, ids or cooldowns.
      if(!allowUninitialized)this.database.prepare('UPDATE pet_business_v1 SET policy_digest=?,state_json=? WHERE pet_id=?')
        .run(this.digest,JSON.stringify(old),pet);
      return old;
    }
    if(r?.policy_digest!==this.digest)throw new Error('PET_BUSINESS_POLICY_CHANGED');
    const s=JSON.parse(r.state_json);validateSaved(s,this.policy);return s;
  }
  save(r,s) {
    validateSaved(s,this.policy);
    if(!uint(r.yuanbao)||!uint(r.mood,1000))throw new Error('INVALID_PET_BUSINESS_PROFILE');
    this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x4e=?,unknown_0x67=? WHERE pet_id=?').run(r.mood,r.yuanbao,r.pet_id);
    this.database.prepare('UPDATE pet_business_v1 SET policy_digest=?,state_json=? WHERE pet_id=?').run(this.digest,JSON.stringify(s),r.pet_id);
  }
  project(uin,petId) {
    const r=this.profile(uin,petId);return {unknown_0x4e:r.mood,unknown_0x67:r.yuanbao};
  }
  species(kind,item){return {...this.policy[kind],...(this.policy[kind].items?.find(i=>i.speciesId===item.speciesId)??{})};}
  sharedHarvest(kind,item) {
    const c=this.species(kind,item),total=c.sellYuanbao;
    if(!this.policy.sharingProfitPercent)return {visitor:total,owner:0};
    // One harvest is split, never minted twice. Paid cost (including discounts) stays with the owner.
    const profit=Math.max(0,total-(item.paidYuanbao??c.buyYuanbao));
    const visitor=Math.floor(profit*this.policy.sharingProfitPercent/100);
    return {visitor,owner:total-visitor};
  }
  // All entry points run inside PostEntryState's online-time/vitals transaction.
  interact(uin,petId,onlineMs,request) {
    if(request.items.length!==1||request.items[0].type!==104||request.items[0].times!==1)return encodeCommInteractFailure(1);
    const delta=this.grantInteractionMood(uin,petId,onlineMs);
    return delta?encodeCommInteractSuccess(request.sequence,delta,this.policy.interactionUnknownKey2):encodeCommInteractFailure(1);
  }
  grantInteractionMood(uin,petId,onlineMs) {
    const r=this.profile(uin,petId),s=this.load(r.pet_id),p=this.policy;
    if((s.lastInteractionAt!==null&&onlineMs-s.lastInteractionAt<p.interactionCooldownMs)||r.mood===1000)return 0;
    const delta=Math.min(p.interactionMood,1000-r.mood);
    r.mood+=delta;s.lastInteractionAt=onlineMs;this.save(r,s);
    return delta;
  }
  flash(uin,petId,onlineMs,{head,data},readOnlineMs,now) {
    if(![6,9].includes(head.game))return null;
    if([9,10].includes(head.cmd)&&this.manor)
      return encodeFlashBusinessResponse(head,this.manor.request(uin,petId,now,{head,data},
        (peer)=>peer.uin===uin?onlineMs:readOnlineMs(peer.uin,peer.profile.petIdBytes)));
    // Native cmd6's result3 is a quota error, not the ordinary failure branch.
    if(head.cmd===6)return head.game===6?this.fishAtFriend(uin,petId,onlineMs,{head,data},readOnlineMs,now)
      :this.pickAtFriend(uin,petId,{head,data},readOnlineMs,now);
    if(![1,2,3,4,5,7,8].includes(head.cmd))return encodeFlashBusinessResponse(head,{result:3,msg:'此项业务尚未开放'});
    if(data.petid!==petId.readBigUInt64LE().toString()) {
      const peer=head.cmd===1?this.friends?.find(undefined,data.petid):null;
      if(!peer||!this.friends.find(uin,petId.readBigUInt64LE().toString()))throw new Error('FLASH_BUSINESS_PET_MISMATCH');
      if(typeof readOnlineMs!=='function')throw new Error('FRIEND_TIME_UNAVAILABLE');
      const r=this.profile(uin,petId),target=this.profile(peer.uin,peer.profile.petIdBytes);
      const vip=this.benefits.membership(uin,petId,this.membership),power=this.benefits.power(r.pet_id,vip,now);
      const pond=this.pond(head.game===6?'fish':'farm',target,this.load(target.pet_id,true),
        readOnlineMs(peer.uin,peer.profile.petIdBytes),peer.profile.login.unknown_0x65,vip.level,{power:power.power,power_up_left:power.power_up_left});
      return encodeFlashBusinessResponse(head,{...pond,yb:r.yuanbao});
    }
    const kind=head.game===6?'fish':'farm',r=this.profile(uin,petId),s=this.load(r.pet_id);
    const vip=this.benefits.membership(uin,petId,this.membership),vipLevel=vip.level;
    const c={...this.policy[kind],...(vipLevel?{capacity:kind==='fish'?5:9}:{})};
    const reply=value=>encodeFlashBusinessResponse(head,value);
    const rejected=(msg,result=3)=>reply({result,msg});
    if(head.cmd===1) {
      const power=this.benefits.power(r.pet_id,vip,now);
      return reply(this.pond(kind,r,s,onlineMs,vipLevel,vipLevel,{...this.benefits.allowance(r.pet_id,kind,vip,now),
        ...(kind==='fish'?{power:power.power,power_up_left:power.power_up_left}:{})}));
    }
    if([2,7].includes(head.cmd)) {
      const growing=s[kind].filter(item=>onlineMs-item.bornOnlineMs+(item.acceleratedOnlineMs??0)<this.species(kind,item).matureOnlineSeconds*1000);
      const targets=head.cmd===7?growing:growing.filter(item=>item.id===(kind==='fish'?data.id:data.idx));
      if(targets.length===0)return rejected('没有可以加速成长的对象');
      if(head.cmd===2) {
        if(this.policy.paidAccelerationLimit&&targets.some(i=>i.paidFeedUsed??((i.acceleratedOnlineMs??0)>=BUSINESS_FEED_ADVANCE_MS)))
          return rejected('本轮已经使用过普通加速，成熟后再来收获吧');
        if(r.yuanbao<BUSINESS_FEED_PRICE)return rejected('元宝不足',1);
        r.yuanbao-=BUSINESS_FEED_PRICE;
        if(this.policy.paidAccelerationLimit)for(const item of targets)item.paidFeedUsed=true;
      }else if(!this.benefits.useSuper(r.pet_id,kind,vip,now))return rejected(vipLevel?'今日粉钻次数已用完':'此功能需要粉钻会员');
      for(const item of targets)item.acceleratedOnlineMs=this.policy.id==='local-pet-business-v3'
        ?Math.min(this.species(kind,item).matureOnlineSeconds*1000,(item.acceleratedOnlineMs??0)+BUSINESS_FEED_ADVANCE_MS):BUSINESS_FEED_ADVANCE_MS;
      this.save(r,s);
      return reply({result:0,msg:kind==='fish'?'喂食成功，鱼儿长得更快啦':'施肥成功，作物长得更快啦',id:targets[0].id,yb:r.yuanbao});
    }
    if(head.cmd===3) {
      const items=c.items??[{speciesId:c.speciesId,name:c.name,level:0,vipOnly:false}];
      const size=this.policy.id==='local-pet-business-v3'?9:items.length,total=Math.ceil(items.length/size);
      if(!uint(data.page,total-1))return rejected('无此商店页');
      const rows=items.slice(data.page*size,(data.page+1)*size).map(i=>this.shop(kind,c,i));
      return reply(kind==='fish'?{fries:rows,totalpage:total}:{plants:rows,total_page:total});
    }
    if(head.cmd===4) {
      const species=kind==='fish'?data.fryid:data.id,stamp=kind==='fish'?'lastFishBuyAt':'lastFarmBuyAt';
      if(data.paytype!==1)return rejected('暂未开放此支付方式');
      const item=c.items?.find(i=>i.speciesId===species)??(species===c.speciesId?{speciesId:species,level:0,vipOnly:false}:null);
      if(!item)return rejected('商品不存在');
      if(r.level<item.level)return rejected('宠物等级不符合要求');
      if(item.vipOnly&&!vipLevel)return rejected('此商品需要粉钻会员');
      const unit=item.buyYuanbao??c.buyYuanbao,cost=vipLevel?Math.max(1,Math.floor(unit*(this.policy.id==='local-pet-business-v3'&&vipLevel>=7?0.7:0.8))):unit;
      if(s[stamp]!==null&&onlineMs-s[stamp]<this.policy.purchaseCooldownMs)return rejected('请稍后再购买');
      if(s[kind].length>=c.capacity)return rejected('已达到数量上限',2);
      if(kind==='farm'&&(!uint(data.idx,c.capacity-1)||s.farm.some(i=>i.id===data.idx)))return rejected('这块地无法播种',2);
      if(r.yuanbao<cost)return rejected('元宝不足',1);
      if(kind==='fish'&&s.nextFishId===MAX)return rejected('鱼塘编号已用尽');
      const id=kind==='fish'?s.nextFishId++:data.idx;
      s[kind].push({id,bornOnlineMs:onlineMs,...(c.items?{speciesId:species,paidYuanbao:cost}:{})});
      r.yuanbao-=cost;s[stamp]=onlineMs;this.save(r,s);
      return reply({result:0,msg:'购买成功',yb:r.yuanbao});
    }
    if([5,8].includes(head.cmd)) {
      const id=kind==='fish'?data.id:data.idx,index=s[kind].findIndex(i=>i.id===id);
      if(index<0)return rejected('没有可收获的对象');
      const isMature=item=>onlineMs-item.bornOnlineMs+(item.acceleratedOnlineMs??0)>=this.species(kind,item).matureOnlineSeconds*1000;
      const item=s[kind][index],mature=isMature(item),bulk=head.cmd===8;
      // Farm's native button explicitly confirms uprooting immature crops for half their cost.
      if(!mature&&(kind==='fish'||bulk))return rejected(kind==='fish'?'鱼儿还没有成熟':'作物还没有成熟');
      // The selected object comes first, then every other mature object. Young
      // crops remain planted; the client's bulk button never confirms uprooting.
      const targets=bulk?[item,...s[kind].filter(i=>i.id!==id&&isMature(i))]:[item];
      const awardOf=item=>isMature(item)?this.species(kind,item).sellYuanbao:Math.floor((item.paidYuanbao??c.buyYuanbao)/2);
      const award=awardOf(item),total=targets.reduce((n,item)=>n+awardOf(item),0);
      if(r.yuanbao>MAX-total)return rejected('元宝已达上限');
      const ids=new Set(targets.map(i=>i.id));s[kind]=s[kind].filter(i=>!ids.has(i.id));r.yuanbao+=total;
      if(kind==='fish')s.fishHarvestCount=Math.min(MAX,s.fishHarvestCount+targets.length);
      if(mature)for(const _ of targets)this.desktopTasks?.record(uin,petId,kind);
      this.save(r,s);
      // Unlike pond/buy yb (balance), ShouhuoProtocol.yb feeds the award
      // animation. The committed wallet is published independently via 0550.
      const reward={result:0,msg:mature?'收获成功':'已铲除',yb:award,growth:0,strong:0,charm:0,iq:0,
        ...(kind==='farm'?{jiangli:award+'元宝',quantity:mature?(this.species(kind,item).quantity??1):0,go_url:null}:{})};
      return reply(bulk?{result:0,msg:'收获成功',harvests:targets.map(i=>({[kind==='fish'?'id':'idx']:i.id,...reward,yb:awardOf(i)}))}:reward);
    }
  }
  fishAtFriend(uin,petId,onlineMs,{head,data},readOnlineMs,now) {
    const reply=value=>encodeFlashBusinessResponse(head,value),peer=this.friends?.find(undefined,data.petid),r=this.profile(uin,petId);
    if(!peer||peer.uin===uin||typeof readOnlineMs!=='function')return reply({result:255,msg:'请在好友鱼塘钓鱼'});
    const vip=this.benefits.membership(uin,petId,this.membership),power=this.benefits.power(r.pet_id,vip,now);
    if(power.power<FISHING_POWER_COST)return reply({result:255,msg:'体力不足10点，请等待恢复'});
    const quota=this.benefits.catchAllowance(r.pet_id,peer.pet_id,vip,now);
    if(!quota.available)return reply({result:quota.global.used>=(vip.level?200:100)?5:3,msg:'今日钓鱼次数已用完'});
    const target=this.profile(peer.uin,peer.profile.petIdBytes),stock=this.load(target.pet_id,true),c=this.policy.fish;
    const time=readOnlineMs(peer.uin,peer.profile.petIdBytes);
    const index=stock.fish.findIndex(item=>time-item.bornOnlineMs+(item.acceleratedOnlineMs??0)>=this.species('fish',item).matureOnlineSeconds*1000);
    const share=index>=0?this.sharedHarvest('fish',stock.fish[index]):{visitor:0,owner:0},award=share.visitor;
    if(index>=0&&(r.yuanbao>MAX-award||target.yuanbao>MAX-share.owner))return reply({result:255,msg:'元宝已达上限'});
    // Each accepted attempt costs ten power. A mature fish is sold once; the
    // approved share and owner reimbursement commit with stock and quotas.
    if(!this.benefits.consumeCatch(r.pet_id,peer.pet_id,vip,now))throw new Error('FISHING_ALLOWANCE_CHANGED');
    if(index<0)return reply({result:0});
    const item=stock.fish.splice(index,1)[0],species=c.items?.find(i=>i.speciesId===item.speciesId)??c;
    target.yuanbao+=share.owner;this.save(target,stock);r.yuanbao+=award;this.save(r,this.load(r.pet_id));
    this.friends.inbox.record(r.pet_id,target.pet_id,1,11,'从你的鱼塘钓走了1条'+species.name+(share.owner?'，已为你结算'+share.owner+'元宝':''),now);
    return reply({result:1,fish:{id:species.speciesId,name:species.name,quantity:1,yb:award}});
  }
  pickAtFriend(uin,petId,{head,data},readOnlineMs,now) {
    const reply=value=>encodeFlashBusinessResponse(head,value),peer=this.friends?.find(undefined,data.petid),r=this.profile(uin,petId);
    if(!peer||peer.uin===uin||typeof readOnlineMs!=='function')return reply({result:0,msg:'请在好友农场采摘'});
    const vip=this.benefits.membership(uin,petId,this.membership),quota=this.benefits.pickAllowance(r.pet_id,peer.pet_id,vip,now);
    if(!quota.available)return reply(quota.global.used>=quota.globalLimit?{result:3}
      :{result:0,msg:'今日在这位好友农场的采摘次数已用完'});
    const target=this.profile(peer.uin,peer.profile.petIdBytes),stock=this.load(target.pet_id,true),c=this.policy.farm;
    const time=readOnlineMs(peer.uin,peer.profile.petIdBytes),index=stock.farm.findIndex(i=>i.id===data.idx);
    if(index<0)return reply({result:0,msg:'这块地没有可采摘的作物'});
    const item=stock.farm[index];
    const catalog=this.species('farm',item);
    if(time-item.bornOnlineMs+(item.acceleratedOnlineMs??0)<catalog.matureOnlineSeconds*1000)
      return reply({result:0,msg:'作物还没有成熟'});
    const share=this.sharedHarvest('farm',item);
    if(r.yuanbao>MAX-share.visitor||target.yuanbao>MAX-share.owner)return reply({result:0,msg:'元宝已达上限'});
    if(!this.benefits.consumePick(r.pet_id,peer.pet_id,vip,now))throw new Error('FARM_PICK_ALLOWANCE_CHANGED');
    const species=c.items?.find(i=>i.speciesId===item.speciesId)??c;
    stock.farm.splice(index,1);target.yuanbao+=share.owner;this.save(target,stock);r.yuanbao+=share.visitor;this.save(r,this.load(r.pet_id));
    this.friends.inbox.record(r.pet_id,target.pet_id,1,12,'从你的农场采摘了1个'+species.name+(share.owner?'，已为你结算'+share.owner+'元宝':''),now);
    return reply({result:1,quantity:1,yb:share.visitor,pet_quan:0});
  }
  shop(kind,c,item={speciesId:c.speciesId,name:c.name,level:0,vipOnly:false}) {
    const catalog={...c,...item},quantity=item.quantity??1;
    const common={name:item.name,level:item.level,quantity,interval:catalog.matureOnlineSeconds,flag:Number(item.vipOnly),growth:0,strong:0,iq:0,charm:0,
      limit_num:c.capacity,avatar:item.avatar??'',avator:item.avatar??item.speciesId};
    return kind==='fish'?{...common,fryid:item.speciesId,sell_price:catalog.sellYuanbao/quantity,price_yb:catalog.buyYuanbao,price_qb:0}
      :{...common,id:item.speciesId,desc:'在线成长，成熟后可以收获',sell_yb:catalog.sellYuanbao,buy_yb:catalog.buyYuanbao,buy_qfen:0,place:0};
  }
  pond(kind,r,s,onlineMs,vipLevel=0,actorVipLevel=vipLevel,extra={}) {
    const items=s[kind].map(item=>{
      const c=this.species(kind,item);
      const species=c.items?.find(i=>i.speciesId===item.speciesId)??c;
      const elapsed=Math.max(0,Math.min(c.matureOnlineSeconds,Math.floor((onlineMs-item.bornOnlineMs+(item.acceleratedOnlineMs??0))/1000)));
      const mature=elapsed===c.matureOnlineSeconds;
      if(kind==='fish')return {id:item.id,fryid:species.speciesId,name:species.name,stage:mature?3:1+Math.floor(elapsed*2/c.matureOnlineSeconds),
        time:c.matureOnlineSeconds-elapsed,interval:c.matureOnlineSeconds,quantity:c.quantity??1,basequantity:c.quantity??1,YB:c.sellYuanbao,
        costyb:item.paidYuanbao??c.buyYuanbao,growth:0,strong:0,iq:0,charm:0,avatar:''};
      return {idx:item.id,id:species.speciesId,name:species.name,stage:mature?4:1+Math.floor(elapsed*3/c.matureOnlineSeconds),
        time:elapsed,interval:c.matureOnlineSeconds,quantity:c.quantity??1,base_quantity:c.quantity??1,sell_yb:c.sellYuanbao,buy_yb:c.buyYuanbao,plant_flag:c.plantFlag??0};
    });
    const common={yb:r.yuanbao,viplv:vipLevel,canusecnt:0,allvipcnt:0};
    return kind==='fish'?{...common,power:actorVipLevel?30:20,power_up_left:0,
      harvestfish:s.fishHarvestCount,fishes:items,...extra}:{...common,fields:items,...extra};
  }
  entranceStatus(peer,onlineMs) {
    const state=this.load(peer.pet_id,true);
    const status=kind=>state[kind].length===0?3:state[kind].some(item=>
      onlineMs-item.bornOnlineMs+(item.acceleratedOnlineMs??0)>=this.species(kind,item).matureOnlineSeconds*1000)?1:2;
    return {farm:status('farm'),fish:status('fish')};
  }
}
