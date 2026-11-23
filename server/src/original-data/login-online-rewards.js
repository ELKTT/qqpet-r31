import {createHash} from 'node:crypto';

// 登录送礼 / 在线送礼 rewards, taken from the locked DailyTask resource table the client's
// small popup displays: res/Plugins/DailyTask/LoginPanel/LoginPanel.xml. The table is a
// single versioned constant so the eligibility query, the claimed state, the claim reply
// and the actual delivery can never disagree, and `tools/verify-login-online-rewards.js`
// re-derives it from those locked bytes.
//
// Two local rules are declared here and nowhere else:
//   * the day-7 登录大礼包 is delivered as its six contents in the same transaction rather
//     than as an openable package. The locked tip says the pack contains the earlier
//     prizes; expanding it once removes the double-grant hazard a package plus its own
//     open step would create.
//   * 百草丹's original effect is not established anywhere in the client evidence
//     (analysis/results/care-catalog-preparation-20260915.json lists it as
//     effect_unknown_or_conflicting), so it is delivered as a catalogue-only item: it
//     enters the backpack and cannot be used.
export const LOGIN_ONLINE_REWARDS_ID='local-login-online-rewards-v2';
export const LOGIN_PANEL_SOURCE=Object.freeze({
  path:'NEW-QQPet/QQPenguin/res/Plugins/DailyTask/LoginPanel/LoginPanel.xml',
  sha256:'8437440452f76d06b438dcf10b2076b2ac7d3bb02716f4c13f853275430cdb36',
  bytes:1888,
});
// The reward table this build delivers. `cid` values are resolved against the enabled care
// catalogue at startup, so a name can never silently point at a different item.
const LOGIN=[
  {label:'第1天',icon:'LoginPanel\\l1.gif',tip:'元宝\\n数量：20',reward:{kind:'yb',amount:20}},
  {label:'第2天',icon:'LoginPanel\\l2.gif',tip:'桃桃布丁\\n饥饿：+180\\n数量：1',reward:{kind:'item',name:'桃桃布丁',cid:10000480,count:1}},
  {label:'第3天',icon:'LoginPanel\\l3.gif',tip:'舒爽喷湿器\\n清洁：+360\\n数量：1',reward:{kind:'item',name:'舒爽喷湿器',cid:10000192,count:1}},
  {label:'第4天',icon:'LoginPanel\\l4.gif',tip:'彩虹鱼脆脆\\n饥饿：+1440\\n数量：1',reward:{kind:'item',name:'彩虹鱼脆脆',cid:10000426,count:1}},
  {label:'第5天',icon:'LoginPanel\\l5.gif',tip:'魔幻矿泉泥\\n清洁：+1800\\n数量：1',reward:{kind:'item',name:'魔幻矿泉泥',cid:10000257,count:1}},
  {label:'第6天',icon:'LoginPanel\\l6.gif',tip:'百草丹\\n数量：1',reward:{kind:'item',name:'百草丹',cid:10000841,count:1}},
  {label:'第7天',icon:'LoginPanel\\l7.gif',tip:'登录大礼包\\n（礼包包括了之前\\n的所有奖品哟！）',
   reward:{kind:'giftPack',name:'登录大礼包',contents:[0,1,2,3,4,5]}},
];
const ONLINE=[
  {minutes:1,label:'1分钟',icon:'LoginPanel\\qq.gif',tip:'圈圈冰激凌\\n饥饿：+90\\n数量：1',reward:{kind:'item',name:'圈圈冰激凌',cid:10000367,count:1}},
  {minutes:5,label:'5分钟',icon:'LoginPanel\\fs.gif',tip:'超炫电吹风\\n清洁：+360\\n数量：1',reward:{kind:'item',name:'超炫电吹风',cid:10000211,count:1}},
  {minutes:15,label:'15分钟',icon:'LoginPanel\\l1.gif',tip:'元宝\\n数量：15',reward:{kind:'yb',amount:15}},
  {minutes:30,label:'30分钟',icon:'LoginPanel\\mmh.gif',tip:'果味米米花\\n饥饿：+360\\n数量：1',reward:{kind:'item',name:'果味米米花',cid:10000477,count:1}},
  {minutes:60,label:'60分钟',icon:'LoginPanel\\l1.gif',tip:'元宝\\n数量：25',reward:{kind:'yb',amount:25}},
  {minutes:90,label:'90分钟',icon:'LoginPanel\\ssf.gif',tip:'宝宝爽身粉\\n清洁：+1080\\n数量：1',reward:{kind:'item',name:'宝宝爽身粉',cid:10000063,count:1}},
  {minutes:120,label:'120分钟',icon:'LoginPanel\\ml.gif',tip:'雪山蜜梨\\n饥饿：+720\\n数量：1',reward:{kind:'item',name:'雪山蜜梨',cid:10000712,count:1}},
  {minutes:150,label:'150分钟',icon:'LoginPanel\\np.gif',tip:'吉祥牛排\\n饥饿：+900\\n数量：1',reward:{kind:'item',name:'吉祥牛排',cid:10000358,count:1}},
  {minutes:180,label:'180分钟',icon:'LoginPanel\\l1.gif',tip:'元宝\\n数量：60',reward:{kind:'yb',amount:60}},
  {minutes:240,label:'240分钟',icon:'LoginPanel\\l1.gif',tip:'元宝\\n数量：80',reward:{kind:'yb',amount:80}},
];

// The reward version that replaced the fixed 20-yuanbao daily login and the four
// 30/60/120/240-minute tiers. A save that already claimed one of those keeps its old row;
// the overlapping tier is migrated once so the same day cannot be paid twice.
export const PREVIOUS_REWARD_VERSION=Object.freeze({
  loginClaimKind:'login',
  onlineClaimKind:'online',
  // The replaced rows are keyed by the old tier index (0..3), not by their seconds.
  onlineTiers:Object.freeze([
    Object.freeze({previousIndex:0,seconds:1800,index:3}),
    Object.freeze({previousIndex:1,seconds:3600,index:4}),
    Object.freeze({previousIndex:2,seconds:7200,index:6}),
    Object.freeze({previousIndex:3,seconds:14400,index:9}),
  ]),
});
export const REWARD_CLAIM_KIND=Object.freeze({login:'loginDayV2',online:'onlineV2'});
const MAX_YUANBAO=0x7fffffff;

export function loginOnlineRewards() {
  return Object.freeze({
    id:LOGIN_ONLINE_REWARDS_ID,
    source:LOGIN_PANEL_SOURCE,
    login:Object.freeze(LOGIN.map((entry)=>Object.freeze({...entry}))),
    online:Object.freeze(ONLINE.map((entry)=>Object.freeze({...entry,seconds:entry.minutes*60}))),
    claimKind:REWARD_CLAIM_KIND,
    previous:PREVIOUS_REWARD_VERSION,
  });
}

// Every rule the delivery path relies on is checked here, so a malformed edit stops the
// server instead of paying a wrong prize. The comparison against the locked client resource
// is deliberately not part of this function: it belongs to tools/verify-login-online-rewards.js,
// which reads those bytes, while this one validates the shape any table must have.
// `items` is the enabled catalogue's cid map; when it is given, every named prize must
// resolve to that exact item.
export function validateLoginOnlineRewards(policy,{items}={}) {
  const bad=(code)=>{throw new TypeError(code);};
  if(policy?.id!==LOGIN_ONLINE_REWARDS_ID||!Array.isArray(policy.login)||!Array.isArray(policy.online))bad('INVALID_REWARD_POLICY');
  if(policy.login.length<1||policy.login.length>31||policy.online.length<1||policy.online.length>31)bad('INVALID_REWARD_TIER_COUNT');
  const item=(reward)=>{
    if(reward.kind!=='item')return;
    if(typeof reward.name!=='string'||!reward.name)bad('INVALID_REWARD_ITEM');
    if(!Number.isInteger(reward.count)||reward.count<=0||reward.count>9999)bad('INVALID_REWARD_COUNT');
    if(!items)return;
    const entry=items.get(reward.cid);
    if(!entry||entry.name!==reward.name)bad('REWARD_ITEM_UNAVAILABLE');
  };
  policy.login.forEach((entry,index)=>{
    if(typeof entry.label!=='string'||!entry.label||entry.label!==`第${index+1}天`)bad('INVALID_REWARD_TABLE');
    if(typeof entry.icon!=='string'||!entry.icon||typeof entry.tip!=='string'||!entry.tip)bad('INVALID_REWARD_TABLE');
    const reward=entry.reward;
    if(reward?.kind==='yb') {
      if(!Number.isInteger(reward.amount)||reward.amount<=0||reward.amount>MAX_YUANBAO)bad('INVALID_REWARD_AMOUNT');
    }else if(reward?.kind==='item') {
      if(!Number.isInteger(reward.cid)||reward.cid<=0)bad('INVALID_REWARD_ITEM');
      item(reward);
    }else if(reward?.kind==='giftPack') {
      if(index!==policy.login.length-1||typeof reward.name!=='string'||!reward.name
          ||!Array.isArray(reward.contents)||!reward.contents.length
          ||reward.contents.some((i)=>!Number.isInteger(i)||i<0||i>=index)||new Set(reward.contents).size!==reward.contents.length)
        bad('INVALID_REWARD_PACK');
      for(const i of reward.contents)item(policy.login[i].reward);
    }else bad('INVALID_REWARD_KIND');
  });
  const minutes=policy.online.map((entry)=>entry.minutes);
  if(new Set(minutes).size!==minutes.length)bad('REWARD_TIER_NOT_UNIQUE');
  for(let i=1;i<minutes.length;i++)if(minutes[i]<=minutes[i-1])bad('REWARD_TIER_NOT_ASCENDING');
  policy.online.forEach((entry)=>{
    // Seconds are the unit the online counter is compared in, so the minute label and the
    // conversion are both derived and checked here rather than trusted.
    if(!Number.isInteger(entry.minutes)||entry.minutes<=0||entry.minutes>1440)bad('INVALID_ONLINE_TIER_UNIT');
    if(entry.label!==`${entry.minutes}分钟`)bad('INVALID_ONLINE_TIER_UNIT');
    if(entry.seconds!==entry.minutes*60)bad('INVALID_ONLINE_TIER_UNIT');
    if(typeof entry.icon!=='string'||!entry.icon||typeof entry.tip!=='string'||!entry.tip)bad('INVALID_REWARD_TABLE');
    const reward=entry.reward;
    if(reward?.kind==='yb') {
      if(!Number.isInteger(reward.amount)||reward.amount<=0||reward.amount>MAX_YUANBAO)bad('INVALID_REWARD_AMOUNT');
    }else if(reward?.kind==='item') {
      if(!Number.isInteger(reward.cid)||reward.cid<=0)bad('INVALID_REWARD_ITEM');
      item(reward);
    }else bad('INVALID_REWARD_KIND');
  });
  // Detach caller-owned configuration, including nested arrays.
  return JSON.parse(JSON.stringify(policy));
}

export function rewardDigest(policy) {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

// The full list of prizes one claim pays: the scalar grant and the item grants the shared
// inventory has to receive. A pack is expanded here exactly once.
export function claimPrizes(policy,scope,index) {
  const entry=scope==='login'?policy.login[index]:policy.online[index];
  if(!entry)throw new TypeError('REWARD_TIER_UNKNOWN');
  const coins=[],items=[];
  const collect=(reward)=>{
    if(reward.kind==='yb')coins.push(reward.amount);
    else if(reward.kind==='item')items.push({cid:reward.cid,count:reward.count,name:reward.name});
    else for(const i of reward.contents)collect(policy.login[i].reward);
  };
  collect(entry.reward);
  return Object.freeze({
    label:entry.label,icon:entry.icon,tip:entry.tip,
    coins:Object.freeze(coins),items:Object.freeze(items.map(Object.freeze)),
  });
}
