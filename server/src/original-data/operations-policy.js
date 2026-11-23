import {createHash} from 'node:crypto';
import {loginOnlineRewards,validateLoginOnlineRewards} from './login-online-rewards.js';
import {VIP_PLANS} from './timed-pet-membership.js';

export const DAILY_TASKS=Object.freeze([
 {id:1,event:'feed',name:'喂食一次',condition:'成功使用一件食品',active:10,reward:5},
 {id:2,event:'clean',name:'清洁一次',condition:'成功使用一件清洁用品',active:10,reward:5},
 {id:3,event:'study',name:'完成学习',condition:'完成一节课程',active:20,reward:10},
 {id:4,event:'work',name:'完成打工',condition:'完成半小时打工',active:20,reward:10},
 {id:5,event:'fish',name:'鱼塘收获',condition:'收获一条成熟的鱼',active:20,reward:10,scene:110},
 {id:6,event:'farm',name:'农场收获',condition:'收获一次成熟作物',active:20,reward:10,scene:120},
 {id:7,event:'interact',name:'与宠物互动',condition:'鼠标点击宠物互动，或完成交互→玩耍游戏',active:10,reward:5},
]);
export const ACTIVITY_THRESHOLDS=Object.freeze([20,50,80,100]);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);
const fail=code=>{const error=new Error(code);error.code=code;throw error;};
const prize=entry=>entry.reward.kind==='yb'?entry.reward.amount+'元宝':entry.reward.kind==='item'?entry.reward.name+'×'+entry.reward.count:entry.reward.name;
const initialNotice=p=>'每日登录：'+p.rewards.login.map((r,i)=>'第'+(i+1)+'天'+prize(r)).join('、')+'。\n在线奖励：'+p.rewards.online.map(r=>r.minutes+'分钟'+prize(r)).join('、')+'。\n每日签到'+p.sign.daily+'元宝，每日可抽取10–200点成长值。';
const defaultVipPrices=()=>Object.fromEntries(Object.entries(VIP_PLANS).map(([name,plan])=>[name,plan.price]));
export function defaultOperationsPolicy(rewards=loginOnlineRewards()) {
 return {tasks:DAILY_TASKS.map(t=>({...t,enabled:true})),activityAwards:[5,10,15,20],
  sign:{daily:10,monthly:[20,30,50,80,120,160,200]},rewards:structuredClone(rewards),vipPrices:defaultVipPrices(),
  announcement:{enabled:true,title:'宠物公告板',body:'每日任务、签到和在线礼包已开放。',showRules:true}};
}
export function validateOperationsPolicy(value,{items,originalRewards=loginOnlineRewards()}={}) {
 const p=structuredClone(value);
 if(p&&p.vipPrices===undefined)p.vipPrices=defaultVipPrices();
 if(!p?.vipPrices||Object.keys(p.vipPrices).sort().join('|')!=='month|trial|year'
   ||Object.values(p.vipPrices).some(n=>!integer(n,0,0x7fffffff)))fail('OPERATIONS_INVALID_VIP_PRICES');
 if(!p||!Array.isArray(p.tasks)||p.tasks.length!==DAILY_TASKS.length)fail('OPERATIONS_INVALID_TASKS');
 p.tasks.forEach((t,i)=>{
  const source=DAILY_TASKS[i];
  if(t.id!==source.id||t.event!==source.event||t.scene!==source.scene||typeof t.enabled!=='boolean'
   ||!text(t.name,40)||!text(t.condition,160)||!integer(t.active,0,100)||!integer(t.reward,0,1000000))fail('OPERATIONS_INVALID_TASKS');
 });
 if(!Array.isArray(p.activityAwards)||p.activityAwards.length!==4||p.activityAwards.some(n=>!integer(n,0,1000000)))fail('OPERATIONS_INVALID_ACTIVITY');
 if(!integer(p.sign?.daily,0,1000000)||!Array.isArray(p.sign.monthly)||p.sign.monthly.length!==7||p.sign.monthly.some(n=>!integer(n,0,1000000)))fail('OPERATIONS_INVALID_SIGN');
 try{p.rewards=validateLoginOnlineRewards(p.rewards,{items});}catch(error){error.code=error.message;throw error;}
 if([...p.rewards.login,...p.rewards.online].some(r=>r.reward.kind==='yb'&&r.reward.amount>1000000))fail('INVALID_REWARD_AMOUNT');
 // Native notification thresholds and claim identities remain stable across edits.
 if(p.rewards.login.length!==originalRewards.login.length||p.rewards.online.length!==originalRewards.online.length
  ||p.rewards.online.some((r,i)=>r.seconds!==originalRewards.online[i].seconds)
  ||JSON.stringify(p.rewards.claimKind)!==JSON.stringify(originalRewards.claimKind)
  ||JSON.stringify(p.rewards.previous)!==JSON.stringify(originalRewards.previous))fail('OPERATIONS_FIXED_TIERS');
 const a=p.announcement;
 if(!a||typeof a.enabled!=='boolean'||typeof a.showRules!=='boolean'||!text(a.title,80)||typeof a.body!=='string'||a.body.length>3000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(a.body))fail('OPERATIONS_INVALID_NOTICE');
 // Convert the former generated rules once into ordinary, editable notice text.
 if(a.secondaryBody===undefined)a.secondaryBody=a.showRules?initialNotice(p):'';
 if(typeof a.secondaryBody!=='string'||a.secondaryBody.length>3000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(a.secondaryBody))fail('OPERATIONS_INVALID_NOTICE');
 a.showRules=false;
 return p;
}
export class OperationsPolicy {
 constructor({database,items,rewards=loginOnlineRewards()}={}) {
  this.database=database;this.options={items,originalRewards:rewards};
  database.exec('CREATE TABLE IF NOT EXISTS operations_policy_v1 (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision>0),document TEXT NOT NULL) STRICT');
  this.select=database.prepare('SELECT revision,document FROM operations_policy_v1 WHERE id=1');
  const row=this.select.get();
  this.revision=row?.revision??0;
  const saved=row?JSON.parse(row.document):defaultOperationsPolicy(rewards);
  // Append the new task without resetting any existing operator values or claims.
  if(saved.tasks?.length===6&&saved.tasks.every((t,i)=>t.id===DAILY_TASKS[i].id&&t.event===DAILY_TASKS[i].event))
   saved.tasks.push({...DAILY_TASKS[6],enabled:true});
  this.value=validateOperationsPolicy(saved,this.options);
 }
 snapshot(){return {revision:this.revision,policy:structuredClone(this.value)};}
 get announcementRevision(){return createHash('sha256').update(JSON.stringify(this.value.announcement)).digest('hex');}
 update({revision,section,index,values,accounts,actorUin,reason=''}) {
  if(!accounts?.runTransaction||!accounts?.audit)fail('OPERATIONS_ADMIN_REQUIRED');
  const next=structuredClone(this.value);
  if(section==='task'){
   if(!integer(index,0,DAILY_TASKS.length-1))fail('OPERATIONS_INVALID_TASKS');
   next.tasks[index]={...next.tasks[index],...Object.fromEntries(['name','condition','active','reward','enabled'].map(k=>[k,values[k]]))};
  }else if(section==='activity')next.activityAwards=values.awards;
  else if(section==='sign')next.sign=values;
  else if(section==='vip')next.vipPrices=values;
  else if(section==='announcement')next.announcement=values;
  else if(section==='login'||section==='online'){
   const list=next.rewards[section];if(!integer(index,0,list.length-1))fail('OPERATIONS_INVALID_REWARD');
   let reward;
   if(values.kind==='yb')reward={kind:'yb',amount:values.amount};
   else if(values.kind==='item'){
    const item=this.options.items?.get(values.cid);if(!item)fail('REWARD_ITEM_UNAVAILABLE');
    reward={kind:'item',cid:values.cid,count:values.count,name:item.name};
   }else if(values.kind==='giftPack'&&section==='login'&&index===list.length-1)
    reward={kind:'giftPack',name:'登录大礼包',contents:Array.from({length:index},(_,i)=>i)};
   else fail('OPERATIONS_INVALID_REWARD');
   const tip=reward.kind==='yb'?`${reward.amount}元宝`:reward.kind==='item'?`${reward.name}×${reward.count}`:'包含前六天的全部奖励';
   list[index]={...list[index],reward,tip,icon:reward.kind==='yb'?'LoginPanel\\l1.gif':list[index].icon};
  }else fail('OPERATIONS_INVALID_SECTION');
  const validated=validateOperationsPolicy(next,this.options);
  accounts.runTransaction(()=>{
   const current=this.select.get()?.revision??0;
   if(revision!==current||revision!==this.revision)fail('OPERATIONS_REVISION_CONFLICT');
   this.database.prepare('INSERT INTO operations_policy_v1 VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document').run(current+1,JSON.stringify(validated));
   accounts.audit({actorUin,actorScope:'admin',action:'operations-config',detail:{section,index:index??null,beforeRevision:current,afterRevision:current+1,reason:String(reason).slice(0,80)}});
  });
  this.value=validated;this.revision=revision+1;return this.snapshot();
 }
}
