import { encodeOnlineTimeResponse } from '../protocol/online-time.js';
import { encodeDailyTaskInfoResponse } from '../protocol/daily-task-info.js';
import { encodeNoToolbarAdvertisement } from '../protocol/toolbar-ad.js';
import { encodeLogoutSuccess } from '../protocol/logout.js';
import {SupplementPlay} from './supplement-play.js';
import {PetEmbrace} from './pet-embrace.js';
import {PetActivityRules} from './pet-activity-rules.js';
import {encodeAutoFeedSuccess} from '../protocol/auto-feed.js';

export const MAX_ONLINE_MS=4294967295000;
const HOUR_MS=3600000;

// The pet profile age is a local derivation from the committed accumulated
// online counter, not a recovered historical server rule. Fail closed instead
// of clamping so a future bound change cannot silently render a wrong age.
function derivedAgeHours(onlineMs) {
  if(!Number.isSafeInteger(onlineMs)||onlineMs<0||onlineMs>MAX_ONLINE_MS)throw new Error('INVALID_DERIVED_AGE_HOURS');
  const ageHours=Math.floor(onlineMs/HOUR_MS);
  if(!Number.isSafeInteger(ageHours)||ageHours<0||ageHours>0xffffffff)throw new Error('INVALID_DERIVED_AGE_HOURS');
  return ageHours;
}

// Explicit local counter policy. Never infer daily/lifetime semantics from Hello.
export class PostEntryState {
  #profileBatch=null;
  // Synchronous notification rounds only: never retain snapshots across requests.
  withProfileSnapshots(callback) {
    if(typeof callback!=='function'||callback.constructor?.name==='AsyncFunction')throw new TypeError('SYNCHRONOUS_PROFILE_BATCH_REQUIRED');
    if(this.#profileBatch)return callback();
    this.#profileBatch={snapshots:new Map(),changes:this.database.prepare('SELECT total_changes() AS n').get().n};
    try {
      const result=callback();
      if(result&&typeof result.then==='function')throw new TypeError('SYNCHRONOUS_PROFILE_BATCH_REQUIRED');
      return result;
    } finally {this.#profileBatch=null;}
  }
  #currentProfileBatch() {
    const batch=this.#profileBatch;
    if(batch) {
      const changes=this.database.prepare('SELECT total_changes() AS n').get().n;
      // Includes same-connection writes outside checkpoint, even rolled-back writes.
      if(changes!==batch.changes){batch.snapshots.clear();batch.changes=changes;}
    }
    return batch;
  }
  constructor({database, unknownWordHex, initialOnlineSeconds, dailyTaskInfo, toolbarAd, logout, onlineVitals, petBusiness, playRewards, membership, careEconomy, wardrobe, desktopTasks, friends, ageHoursMirror, serverAnimations, onlineTimeDisplayPolicy='cumulative-connected-time', clock=Date.now}={}) {
    if (!database?.prepare || typeof clock!=='function' || !/^[0-9a-f]{8}$/i.test(unknownWordHex??'') ||
        !Number.isInteger(initialOnlineSeconds) || initialOnlineSeconds<0 || initialOnlineSeconds>0xffffffff) throw new TypeError('INVALID_POST_ENTRY_CONFIGURATION');
    if(!['cumulative-connected-time','session-connected-time'].includes(onlineTimeDisplayPolicy))throw new TypeError('INVALID_ONLINE_TIME_DISPLAY_POLICY');
    this.onlineTimeDisplayPolicy=onlineTimeDisplayPolicy;
    // Mirror capability is explicit: an assembly either owns the profile/pet
    // tables and passes them, or it does not and stays projection-only. Table
    // existence is never probed at runtime.
    if(ageHoursMirror&&(ageHoursMirror.database!==database||typeof ageHoursMirror.writeDerivedAgeHours!=='function'))
      throw new TypeError('INVALID_AGE_HOURS_MIRROR');
    this.ageHoursMirror=ageHoursMirror;
    if(onlineVitals && onlineVitals.database!==database)throw new TypeError('VITALS_DATABASE_MISMATCH');
    if(petBusiness&&(!onlineVitals||petBusiness.database!==database))throw new TypeError('BUSINESS_REQUIRES_SHARED_VITALS');
    if(membership&&(membership.database!==database||onlineVitals?.membership!==membership
      ||(petBusiness&&petBusiness.membership!==membership)))throw new TypeError('MEMBERSHIP_REQUIRES_SHARED_STATE');
    if(!membership&&(onlineVitals?.membership||petBusiness?.membership))throw new TypeError('MEMBERSHIP_REQUIRES_SHARED_STATE');
    this.membership=membership;
    this.petBusiness=petBusiness;
    if(playRewards&&(playRewards.database!==database||playRewards.petBusiness!==petBusiness))throw new TypeError('PLAY_REQUIRES_SHARED_BUSINESS');
    this.playRewards=playRewards;
    if(friends&&(friends.database!==database||petBusiness?.friends!==friends))throw new TypeError('FRIENDS_REQUIRES_SHARED_BUSINESS');
    if(!friends&&petBusiness?.friends)throw new TypeError('FRIENDS_REQUIRES_SHARED_BUSINESS');
    this.friends=friends;
    if(careEconomy&&(!onlineVitals||careEconomy.database!==database))throw new TypeError('CARE_REQUIRES_SHARED_VITALS');
    if(careEconomy&&((['local-online-vitals-v3','local-online-vitals-v5'].includes(onlineVitals.policy.id))!==(['local-care-economy-v3','local-care-economy-v4'].includes(careEconomy.policy.id))))
      throw new TypeError('CARE_VITALS_POLICY_VERSION_MISMATCH');
    if(careEconomy&&(onlineVitals.policy.id==='local-online-vitals-v5')!==careEconomy.policy.id.endsWith('-v4'))
      throw new TypeError('CARE_VITALS_POLICY_VERSION_MISMATCH');
    this.careEconomy=careEconomy;
    if(serverAnimations&&(!careEconomy||serverAnimations.database!==database))throw new TypeError('ANIMATIONS_REQUIRE_SHARED_CARE');
    this.serverAnimations=serverAnimations;
    this.supplementPlay=careEconomy?.policy.id==='local-care-economy-v4'&&petBusiness?new SupplementPlay({database,careEconomy,petBusiness}):null;
    if(wardrobe&&(wardrobe.database!==database||wardrobe.careEconomy!==careEconomy))throw new TypeError('WARDROBE_REQUIRES_SHARED_CARE');
    this.wardrobe=wardrobe;
    if(careEconomy&&friends)careEconomy.friends=friends;
    if(desktopTasks&&(!careEconomy||desktopTasks.database!==database))throw new TypeError('TOOLBAR_REQUIRES_SHARED_CARE');
    this.desktopTasks=desktopTasks;
    if(desktopTasks)membership?.attachOperations?.(desktopTasks.operations);
    this.onlineVitals=onlineVitals;
    this.activityRules=onlineVitals?.policy.gameplay?.feedbackRules&&careEconomy
      ?new PetActivityRules({database,careEconomy,desktopTasks}):null;
    if(this.activityRules){careEconomy.activityRules=this.activityRules;if(playRewards)playRewards.activityRules=this.activityRules;
      if(this.supplementPlay)this.supplementPlay.activityRules=this.activityRules;}
    this.embrace=onlineVitals?.policy.id==='local-online-vitals-v5'&&membership&&careEconomy
      ?new PetEmbrace({database,membership,careEconomy,clock}):null;
    if(this.embrace)careEconomy.embrace=this.embrace;
    this.database=database;this.clock=clock;this.unknownWord=Buffer.from(unknownWordHex,'hex');
    this.initialMs=initialOnlineSeconds*1000;this.active=new Map();
    // The configured block supplies only what has no live source (the notice count and the
    // unknown word). The bonus day is asked of the same claim ledger the gifts pages write, and the
    // online word is the day's reached-tier count of that ledger's online total, so the small popup
    // and the web page cannot disagree about which tier index a day has reached.
    this.dailyTaskBase=dailyTaskInfo===undefined ? null : {...dailyTaskInfo};
    this.dailyTaskResponse=dailyTaskInfo===undefined ? null : encodeDailyTaskInfoResponse(dailyTaskInfo);
    this.toolbarAdResponse=toolbarAd===undefined ? null : encodeNoToolbarAdvertisement(toolbarAd);
    this.logoutResponse=logout===undefined ? null : encodeLogoutSuccess(0,logout);
    database.exec(`CREATE TABLE IF NOT EXISTS original_online_time_v1 (
      uin INTEGER NOT NULL, pet_id BLOB NOT NULL CHECK(length(pet_id)=8),
      online_ms INTEGER NOT NULL CHECK(online_ms BETWEEN 0 AND ${MAX_ONLINE_MS}),
      PRIMARY KEY(uin,pet_id)) STRICT;`);
  }
  now() {
    const value=this.clock();
    if(!Number.isSafeInteger(value)||value<0||value>0xffffffff*1000)throw new Error('INVALID_SERVER_CLOCK');
    return value;
  }
  // Observe another pet without opening a session or committing its counter.
  // Only an already-active shared counter contributes uncommitted online time.
  onlineMilliseconds(uin,petId) {
    const row=this.database.prepare('SELECT online_ms FROM original_online_time_v1 WHERE uin=? AND pet_id=?').get(uin,petId);
    const entry=this.active.get(`${uin}:${petId.toString('hex')}`);
    return Math.min(MAX_ONLINE_MS,(row?.online_ms??this.initialMs)+(entry?Math.max(0,this.now()-entry.last):0));
  }
  open(uin,petId) {
    if(!Number.isInteger(uin)||uin<1||uin>0xffffffff||!Buffer.isBuffer(petId)||petId.length!==8)throw new TypeError('INVALID_TIME_IDENTITY');
    this.#profileBatch?.snapshots.clear();
    const key=`${uin}:${petId.toString('hex')}`;
    let entry=this.active.get(key);
    if(!entry) {
      const now=this.now();
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.membership?.initialize(uin,petId);
        this.onlineVitals?.initialize(uin,petId);
        this.petBusiness?.initialize(uin,petId);
        this.playRewards?.initialize(uin,petId,now);
        this.careEconomy?.initialize(uin,petId);
        this.embrace?.initialize(uin,petId);
        this.wardrobe?.initialize(uin,petId);
        this.desktopTasks?.initialize(uin,petId,now);
        this.activityRules?.initialize(uin,petId);
        this.database.prepare('INSERT OR IGNORE INTO original_online_time_v1 VALUES(?,?,?)').run(uin,petId,this.initialMs);
        this.database.exec('COMMIT');
      }catch(error){this.database.exec('ROLLBACK');throw error;}
      entry={uin,petId:Buffer.from(petId),last:now,refs:0,events:[]};this.active.set(key,entry);
    }
    // Display belongs to this login; business elapsed time remains shared and durable.
    let displayLast=this.now(),displayMs=0;
    entry.refs++;
    let closed=false;
    const display=result=>{
      displayMs=Math.min(MAX_ONLINE_MS,displayMs+Math.max(0,result.now-displayLast));
      displayLast=Math.max(displayLast,result.now);
      return {...result,vitals:result.vitals?Object.fromEntries(Object.entries(result.vitals).map(([key,value])=>[key,Buffer.isBuffer(value)?Buffer.from(value):value])):result.vitals,displaySeconds:Math.floor(displayMs/1000)};
    };
    const checkpoint=(effect)=>{
      if(closed)throw new Error('TIME_SESSION_CLOSED');
      const batch=this.#currentProfileBatch();
      if(!effect&&batch?.snapshots.has(entry))return display(batch.snapshots.get(entry));
      // Business effects can also change another pet; invalidate the entire round.
      if(effect)batch?.snapshots.clear();
      const now=this.now(),elapsed=Math.max(0,now-entry.last);
      // Atomic increment: a failed commit leaves both durable state and last unchanged.
      this.database.exec('BEGIN IMMEDIATE');
      let result,vitals,effectResult,ageHours,autoExit;const events=[];
      try {
        result=this.database.prepare('UPDATE original_online_time_v1 SET online_ms=min(?,online_ms+?) WHERE uin=? AND pet_id=? RETURNING online_ms').get(MAX_ONLINE_MS,elapsed,uin,entry.petId);
        if(!result)throw new Error('TIME_STATE_MISSING');
        // Derived once, inside the transaction, from the value this transaction committed.
        ageHours=derivedAgeHours(result.online_ms);
        if(this.ageHoursMirror) {
          const mirror=this.ageHoursMirror.writeDerivedAgeHours(uin,entry.petId,ageHours);
          if(mirror?.profileRows!==1)throw new Error('AGE_HOURS_MIRROR_PROFILE_ROW');
          if(mirror?.petRows!==1)throw new Error('AGE_HOURS_MIRROR_PET_ROW');
        }
        // A caretaker must reach the same feeding opportunities whether Hello arrives
        // every second or after a longer gap. Otherwise an overdue interval can kill
        // a pet before its enabled caretaker gets to use the available supplies.
        let offset=0;
        do {
          const remaining=elapsed-offset,enabled=this.activityRules&&this.membership?.get(uin,entry.petId).autoCare;
          const span=enabled?this.onlineVitals.nextGameplaySpan(entry.petId,remaining):remaining,onlineMs=result.online_ms-elapsed+offset;
          const activityLoss=this.careEconomy?.activityLoss(uin,entry.petId,onlineMs);
          vitals=this.onlineVitals?.advance(uin,entry.petId,span,activityLoss,this.embrace?.interval(uin,entry.petId,entry.last+offset,entry.last+offset+span));
          if(vitals?.events){events.push(...vitals.events);delete vitals.events;}
          offset+=span;
          events.push(...(this.careEconomy?.automaticCare?.(uin,entry.petId,onlineMs+span)??[]));
          this.careEconomy?.advance(uin,entry.petId,onlineMs+span,event=>events.push(event));
        }while(offset<elapsed);
        this.desktopTasks?.advance(uin,entry.petId,entry.last,Math.max(entry.last,now));
        if(effect) {
          effectResult=effect(result.online_ms,now);
          events.push(...(this.careEconomy?.automaticCare?.(uin,entry.petId,result.online_ms)??[]));
        }
        // Care, wages and explicit effects may all mutate this profile. Project the committed
        // values after them; sending the pre-care snapshot hid successful feeding and washing.
        if(this.onlineVitals){vitals=this.onlineVitals.advance(uin,entry.petId,0,undefined,this.embrace?.interval(uin,entry.petId,now,now));
          if(vitals?.events){events.push(...vitals.events);delete vitals.events;}}
        if(this.petBusiness)vitals={...vitals,...this.petBusiness.project(uin,entry.petId)};
        if(this.membership)vitals={...vitals,...this.membership.project(uin,entry.petId)};
        if(this.careEconomy)vitals={...vitals,...this.careEconomy.project(uin,entry.petId,result.online_ms)};
        if(this.embrace){this.embrace.reconcile(uin,entry.petId);vitals={...vitals,...this.embrace.project(uin,entry.petId)};}
        if(this.wardrobe){this.wardrobe.grantMilestones?.(uin,entry.petId);vitals={...vitals,...this.wardrobe.project(uin,entry.petId)};}
        if(batch)autoExit=this.membership?.get(uin,entry.petId).autoExit===true;
        this.database.exec('COMMIT');
      } catch(error) {this.database.exec('ROLLBACK');batch?.snapshots.clear();throw error;}
      entry.last=Math.max(entry.last,now);
      entry.events.push(...events);entry.events=entry.events.slice(-100);
      const snapshot={now,seconds:Math.floor(result.online_ms/1000),vitals,ageHours,autoExit};
      if(batch) {
        // Automatic settlement touches this pet only. Explicit effects above invalidate peers.
        batch.changes=this.database.prepare('SELECT total_changes() AS n').get().n;
        batch.snapshots.set(entry,snapshot);
      }
      return {...display(snapshot),effectResult};
    };
    return {
      checkpoint,
      shouldAutoExit:()=>this.#profileBatch?checkpoint().autoExit:this.membership?.get(uin,entry.petId).autoExit===true,
      drainGameplayEvents:()=>entry.events.splice(0),
      gameplay:request=>{const settled=checkpoint(ms=>{
        const member=this.membership,health=this.careEconomy?.health;
        if(!health||typeof member?.view!=='function')throw new Error('GAMEPLAY_NOT_ENABLED');
        if(request.operation==='game-recover')return health.recoverGame(uin,entry.petId,request.nonce);
        if(request.operation==='legacy-game'&&this.supplementPlay)return this.supplementPlay.legacy(uin,entry.petId,request,ms,this.now());
        if(['game-start','game-pulse'].includes(request.operation)&&this.supplementPlay)return this.supplementPlay.request(uin,entry.petId,request,ms);
        if(request.operation==='vip-free')return health.freeCare(uin,entry.petId,request.kind);
        if(request.operation==='vip-native-info')return member.nativeCareInfo(uin,entry.petId);
        if(request.operation==='vip-native-use') {
          const result=health.freeCare(uin,entry.petId,{1:'feed',2:'clean',3:'medicine'}[request.type]);
          return {...member.nativeCareInfo(uin,entry.petId),...result};
        }
        if(request.operation==='vip-buy')return member.purchase(uin,entry.petId,request.plan,request.nonce);
        if(request.operation==='vip-boost')return member.enableBoost(uin,entry.petId);
        if(['embrace-start','embrace-stop'].includes(request.operation)&&this.embrace)return this.embrace.request(uin,entry.petId,request.operation,request.nonce);
        if(request.operation==='care-settings')return member.configure(uin,entry.petId,request.settings);
        if(request.operation==='care-switch'){member.setAutoCare(uin,entry.petId,{enabled:request.enabled});
          const enabled=member.get(uin,entry.petId).autoCare;
          return {result:request.enabled&&!enabled?1:0,enabled,msg:enabled?'贴心宝贝已开启':'贴心宝贝已关闭；开启需要有效粉钻且宠物健康'};}
        if(request.operation==='hospital')return health.consult(uin,entry.petId,request.nonce);
        if(request.operation==='notice-read')return this.desktopTasks.readAnnouncement(uin,entry.petId);
        if(request.operation==='notice-state')return {result:0,unread:this.friends?.inbox.unread(entry.petId.readBigUInt64LE().toString())??0,
          onlineGifts:this.desktopTasks?.dailyTaskInfo(uin,entry.petId,this.dailyTaskBase).onlineGiftPrizeCount??0,
          ...this.desktopTasks?.rewardNotices(uin,entry.petId),
          announcements:this.desktopTasks?.announcementCount(uin,entry.petId)??0};
        if(request.operation!=='state')throw new TypeError('INVALID_GAMEPLAY_OPERATION');
        const info=health.view(uin,entry.petId);
        return {result:0,vip:member.view(uin,entry.petId),...(this.embrace?{embrace:this.embrace.view(uin,entry.petId)}:{}),health:info,medicineBox:this.careEconomy.medicineBox(uin,entry.petId),yuanbao:this.careEconomy.profile(uin,entry.petId).yuanbao,
          inventory:this.careEconomy.inventorySummary(uin,entry.petId),medicines:[...this.careEconomy.items.values()]
          .filter(i=>i.class==='medicine').map(i=>({cid:i.cid,name:i.name,medicineFor:i.medicineFor,price:this.careEconomy.priceOf(i,member.get(uin,entry.petId).vip_level)}))};
      });
        if(request.operation==='care-switch'){
          const enabled=Boolean(settled.vitals.autoFeedFlag);
          return {...settled.effectResult,enabled,result:request.enabled&&!enabled?1:0,
            msg:enabled?'贴心宝贝已开启':request.enabled?'照料未能继续，请查看宝贝日志中的用品、元宝或健康提示':'贴心宝贝已关闭'};
        }
        return settled.effectResult;
      },
      care:request=>checkpoint((ms,now)=>{
        const result=this.careEconomy.request(uin,entry.petId,ms,request);
        if(this.serverAnimations&&result.notify==='status'&&result.data.result===0&&['work','study'].includes(request.operation)){
          const activity=(request.operation==='work'?this.careEconomy.jobs:this.careEconomy.courses).get(request.id);
          result.animation=this.serverAnimations.select(uin,entry.petId,request.operation,now,{activityName:activity.name});
        }
        return result;
      }).effectResult,
      ...(this.serverAnimations?{animation:(event,options,encode)=>checkpoint((ms,now)=>encode(this.serverAnimations.select(uin,entry.petId,event,now,options))).effectResult}:{}),
      wardrobe:request=>checkpoint(ms=>this.wardrobe.request(uin,entry.petId,ms,request)).effectResult,
      friendCare:(peer,request)=>checkpoint((ms,now)=>this.careEconomy.request(uin,entry.petId,ms,{operation:'friend-use',
        targetUin:peer.uin,targetPetIdHex:peer.profile.petIdBytes.toString('hex'),
        gid:request.gid,type:request.type,nonce:request.nonce},now)).effectResult,
      friendGame:(peer,request,scope)=>checkpoint((ms,now)=>this.friends.completeGame(uin,entry.petId,peer,request,scope,now)).effectResult,
      friendMessage:(peer,request,scope)=>checkpoint((ms,now)=>this.friends.sendMessage(uin,entry.petId,peer,request,scope,now)).effectResult,
      friendInbox:request=>checkpoint(()=>request.operation==='messages'?this.friends.messages(uin,request.kind)
        :this.friends.clearMessages(uin,request.kind)).effectResult,
      // 0x2203 is answered from the live ledger when that module is assembled: the bonus day
      // follows the consecutive-login counter and the online word counts reached, unclaimed tiers.
      // Native increments add new tiers; committed 2203 snapshots replace the count. Without it the
      // key is absent, so the Root keeps its own configured fallback instead of calling into a module
      // that is not there.
      ...(this.desktopTasks
        ? {dailyTask:()=>{
          const project=(settled)=>{
            const result=settled?this.desktopTasks.dailyTaskSnapshot(uin,entry.petId,this.dailyTaskBase,settled.now)
              :this.desktopTasks.dailyTaskInfo(uin,entry.petId,this.dailyTaskBase);
            // InteractSystem owns friend notifications through DCN_INT_NEWFEEDS and
            // IBubbleObject type 5; adding them here opens the unrelated task window.
            return {...result,noticeCount:Math.min(0x7fffffff,result.noticeCount+this.desktopTasks.announcementCount(uin,entry.petId))};
          };
          return this.#profileBatch?project(checkpoint()):checkpoint(()=>project()).effectResult;
        }}
        : {}),
      toolbar:request=>checkpoint(()=>{
        const result=this.desktopTasks.request(uin,entry.petId,request);
        // Reward items are delivered inside the same transaction as the claim receipt and
        // the coin grant. A grant that cannot be settled throws, so the whole claim rolls
        // back instead of leaving a claimed receipt with nothing in the backpack.
        if(Array.isArray(result.grants)&&result.grants.length)this.careEconomy.grant(uin,entry.petId,result.grants);
        return result;
      }).effectResult,
      stopActivity:status=>checkpoint(()=>status===20&&this.embrace?(this.embrace.cancel(uin,entry.petId),true):this.careEconomy.stop(uin,entry.petId,status)).effectResult,
      setAutoCare:request=>encodeAutoFeedSuccess(Boolean(checkpoint(()=>this.membership.setAutoCare(uin,entry.petId,request)).vitals.autoFeedFlag)),
      interact:request=>checkpoint(ms=>this.activityRules?this.activityRules.click(uin,entry.petId,request):this.petBusiness.interact(uin,entry.petId,ms,request)).effectResult,
      specialInteract:request=>checkpoint((ms,now)=>this.playRewards.request(uin,entry.petId,ms,now,request)).effectResult,
      playInteraction:request=>checkpoint((ms,now)=>this.playRewards.commonRequest(uin,entry.petId,ms,now,request)).effectResult,
      flash:request=>checkpoint((ms,now)=>this.petBusiness.flash(uin,entry.petId,ms,request,
        (targetUin,targetPetId)=>this.onlineMilliseconds(targetUin,targetPetId),now)).effectResult,
      profile:record=>{
        const {vitals,ageHours}=checkpoint();
        // The profile directory holds a startup snapshot, so the committed age
        // has to be merged here or the stale bootstrap value keeps being sent.
        const login={...record.login,unknown_0x43:ageHours};
        if(!vitals)return {...record,login};
        const {growthSpeed,...vitalsLogin}=vitals;
        return {...record,login:{...login,...vitalsLogin,unknown_0x43:ageHours},growthSpeed};
      },
      response:()=>{const s=checkpoint();return encodeOnlineTimeResponse({type:'OnlineTimeResponse',dayClockUnixSeconds:Math.floor(s.now/1000),unknown_0x04:this.unknownWord,onlineSeconds:this.onlineTimeDisplayPolicy==='session-connected-time'?s.displaySeconds:s.seconds});},
      close:(effect)=>{if(closed)return;try{return checkpoint(effect?((ms,now)=>effect(this.serverAnimations?.select(uin,entry.petId,'exit',now))):undefined).effectResult;}finally{closed=true;this.#profileBatch?.snapshots.delete(entry);if(--entry.refs===0)this.active.delete(key);}},
    };
  }
}
