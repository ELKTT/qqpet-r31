import {OperationsPolicy,DAILY_TASKS,ACTIVITY_THRESHOLDS} from './operations-policy.js';
import {growthStart} from './online-pet-state.js';
import {randomBytes} from 'node:crypto';
import {drawDailyGrowth} from './daily-growth.js';
import {claimPrizes,loginOnlineRewards,validateLoginOnlineRewards,LOGIN_ONLINE_REWARDS_ID}
  from './login-online-rewards.js';

const DAY=86400000,OFFSET=8*3600000,MAX=0x7fffffff;
const dayOf=ms=>Math.floor((ms+OFFSET)/DAY);
const iso=day=>new Date(day*DAY).toISOString().slice(0,10);
const success=(extra={})=>({result:0,ret:0,...extra});
const failure=msg=>({result:1,ret:1,msg});
const monthThresholds=days=>[3,5,7,14,21,28,days];

// Local rules approved 2026-09-17, with the login/online prize table replaced by the one the
// locked small popup displays (2026-09-24). All methods run in PostEntryState's transaction.
// No historical user state, online time or reward table is imported.
export class DesktopTasks {
  constructor({database,clock=Date.now,rewards,items,seedFactory=()=>randomBytes(4).readUInt32LE()}={}) {
    this.seedFactory=seedFactory;
    this.database=database;this.clock=clock;
    // The prize table is one validated object shared by the eligibility query, the claimed
    // state, the reply and the delivery. A malformed table stops the server here.
    this.operations=new OperationsPolicy({database,items,rewards:validateLoginOnlineRewards(rewards??loginOnlineRewards(),{items})});
    if(this.rewards.id!==LOGIN_ONLINE_REWARDS_ID)throw new Error('REWARD_POLICY_VERSION');
    database.exec(`CREATE TABLE IF NOT EXISTS desktop_login_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      last_day INTEGER NOT NULL, streak INTEGER NOT NULL CHECK(streak BETWEEN 1 AND 65535)) STRICT;
      CREATE TABLE IF NOT EXISTS desktop_day_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      day INTEGER NOT NULL, online_ms INTEGER NOT NULL DEFAULT 0 CHECK(online_ms BETWEEN 0 AND 86400000),
      PRIMARY KEY(pet_id,day)) STRICT;
      CREATE TABLE IF NOT EXISTS desktop_event_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      day INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY(pet_id,day,event)) STRICT;
      CREATE TABLE IF NOT EXISTS desktop_claim_v1 (
      pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      period TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL,
      PRIMARY KEY(pet_id,period,kind,value)) STRICT;`);
    database.exec(`CREATE TABLE IF NOT EXISTS desktop_growth_rng_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      state INTEGER NOT NULL CHECK(state BETWEEN 0 AND 4294967295)) STRICT;`);
    database.exec(`CREATE TABLE IF NOT EXISTS desktop_announcement_read_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      revision TEXT NOT NULL CHECK(length(revision)=64)) STRICT;`);
    this.select=database.prepare(`SELECT q.pet_id,q.unknown_0x67 AS yuanbao,q.unknown_0x61 AS growth,q.level_value AS level
      FROM qqpenguin_login_profile q JOIN pet p ON p.pet_id=q.pet_id WHERE p.uin=? AND q.pet_id_bytes=?`);
  }
  get rewards(){return this.operations.value.rewards;}
  get tasks(){return this.operations.value.tasks.filter(t=>t.enabled);}
  get announcementRevision(){return this.operations.announcementRevision;}
  profile(uin,id) {const p=this.select.get(uin,id);if(!p)throw Error('TOOLBAR_ROLE_MISSING');return p;}
  announcementCount(uin,id){
    const p=this.profile(uin,id),r=this.database.prepare('SELECT revision FROM desktop_announcement_read_v1 WHERE pet_id=?').get(p.pet_id);
    return Number(this.operations.value.announcement.enabled&&r?.revision!==this.announcementRevision);
  }
  readAnnouncement(uin,id){
    const p=this.profile(uin,id);
    this.database.prepare('INSERT INTO desktop_announcement_read_v1 VALUES(?,?) ON CONFLICT(pet_id) DO UPDATE SET revision=excluded.revision').run(p.pet_id,this.announcementRevision);
    return success();
  }
  touch(uin,id,now=this.clock()) {
    const p=this.profile(uin,id),day=dayOf(now),old=this.database.prepare('SELECT * FROM desktop_login_v1 WHERE pet_id=?').get(p.pet_id);
    // Clock rollback cannot create a second login or reset a claimed day.
    const current=Math.max(day,old?.last_day??day);
    if(!old||current>old.last_day) {
      const streak=old&&current===old.last_day+1?Math.min(65535,old.streak+1):1;
      this.database.prepare('INSERT INTO desktop_login_v1 VALUES(?,?,?) ON CONFLICT(pet_id) DO UPDATE SET last_day=excluded.last_day,streak=excluded.streak').run(p.pet_id,current,streak);
    }
    this.database.prepare('INSERT OR IGNORE INTO desktop_day_v1(pet_id,day) VALUES(?,?)').run(p.pet_id,current);
    return {...p,day:current,period:iso(current)};
  }
  initialize(uin,id,now) {this.touch(uin,id,now);this.migratePreviousClaims(uin,id,now);}
  advance(uin,id,start,end) {
    if(end<=start)return;
    const p=this.profile(uin,id);
    // Split actual connected time at UTC+8 midnight; no offline credit.
    for(let cursor=start;cursor<end;) {
      const day=dayOf(cursor),next=Math.min(end,(day+1)*DAY-OFFSET),delta=next-cursor;
      this.database.prepare('INSERT INTO desktop_day_v1 VALUES(?,?,?) ON CONFLICT(pet_id,day) DO UPDATE SET online_ms=min(86400000,online_ms+excluded.online_ms)').run(p.pet_id,day,delta);
      cursor=next;
    }
    // Only the day the session actually reaches counts as a login. Touching each day the
    // elapsed span passes through would turn every absence into a consecutive login and a
    // broken streak could never break, which is the opposite of what the counter is for.
    this.touch(uin,id,end);
  }
  record(uin,id,event,now=this.clock()) {
    if(!DAILY_TASKS.some(t=>t.event===event))throw Error('TOOLBAR_EVENT_INVALID');
    const p=this.touch(uin,id,now);
    this.database.prepare('INSERT OR IGNORE INTO desktop_event_v1 VALUES(?,?,?)').run(p.pet_id,p.day,event);
  }
  claimed(p,kind,value=0,period=p.period) {
    return Boolean(this.database.prepare('SELECT 1 FROM desktop_claim_v1 WHERE pet_id=? AND period=? AND kind=? AND value=?').get(p.pet_id,period,kind,value));
  }
  // One claim writes the receipt and pays every part of the prize. Coins and items are both
  // reported as grants so the caller's transaction settles them together: a coin overflow or
  // a full backpack throws before the receipt is written, and the same transaction rolls the
  // receipt back, so a failed delivery is never recorded as claimed.
  settle(p,kind,value,prize,period=p.period) {
    if(this.claimed(p,kind,value,period))return failure('已经领取，请明天再来');
    const current=this.database.prepare('SELECT unknown_0x67 AS yb FROM qqpenguin_login_profile WHERE pet_id=?').get(p.pet_id).yb;
    const amount=prize.coins.reduce((total,coin)=>total+coin,0);
    if(current>MAX-amount)return failure('元宝达到上限，未领取奖励');
    this.database.prepare('INSERT INTO desktop_claim_v1 VALUES(?,?,?,?)').run(p.pet_id,period,kind,value);
    if(amount)this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67+? WHERE pet_id=?').run(amount,p.pet_id);
    return success({msg:prize.items.length&&amount?`获得${amount}元宝和${prize.items.length}件物品`
        :prize.items.length?`获得${prize.items.map((i)=>i.name).join('、')}`:`获得${amount}元宝`,
      pkginfo:amount?`${amount}元宝`:prize.items.map((i)=>i.name).join('、'),
      reward:{label:prize.label,icon:prize.icon,tip:prize.tip,coins:amount,items:prize.items.length},
      ...(prize.items.length?{grants:prize.items.map((i)=>({cid:i.cid,count:i.count}))}:{})});
  }
  // The fixed 20-yuanbao daily login and the four 30/60/120/240-minute tiers were replaced
  // by the locked table. A save that already claimed under the old rule keeps its own rows
  // (they are never deleted or rewritten) and the overlapping prize is marked claimed for
  // the same natural day, so installing the new table cannot pay yesterday's tier twice.
  migratePreviousClaims(uin,id,now) {
    const p=this.touch(uin,id,now),previous=this.rewards.previous,claimKind=this.rewards.claimKind;
    // The migration and the new claim have to agree on which day this is, or the same natural
    // day is paid twice: the old row is marked as the *same index* the new rule would claim
    // today, so reinterpreting the tier cannot hand out a second prize.
    if(this.claimed(p,previous.loginClaimKind,0)) {
      this.database.prepare('INSERT OR IGNORE INTO desktop_claim_v1 VALUES(?,?,?,?)')
        .run(p.pet_id,p.period,claimKind.login,this.loginDay(p)-1);
    }
    for(const tier of previous.onlineTiers)
      if(this.claimed(p,previous.onlineClaimKind,tier.previousIndex))
        this.database.prepare('INSERT OR IGNORE INTO desktop_claim_v1 VALUES(?,?,?,?)').run(p.pet_id,p.period,claimKind.online,tier.index);
  }
  events(p) {return new Set(this.database.prepare('SELECT event FROM desktop_event_v1 WHERE pet_id=? AND day=?').all(p.pet_id,p.day).map(x=>x.event));}
  online(p) {return Math.floor(this.database.prepare('SELECT online_ms FROM desktop_day_v1 WHERE pet_id=? AND day=?').get(p.pet_id,p.day).online_ms/1000);}
  // The locked table has seven rows and its last row is a pack of the six before it, so the
  // table is one cycle and the day is the position inside it. Capping the day at the last row
  // instead would pay the pack every day from the eighth day on, which is a rule the resource
  // does not state either; a cycle is the reading in which the pack closes a round.
  //
  // Local rule, recorded as such: the original continuation and broken-streak semantics are
  // not established by any client evidence. A missed day resets the counter, which restarts
  // the cycle at day 1; whether the original resumed the old position or restarted is the
  // exact unknown this stands in for.
  loginDay(p) {
    const streak=this.database.prepare('SELECT streak FROM desktop_login_v1 WHERE pet_id=?').get(p.pet_id).streak;
    return ((Math.max(1,streak)-1)%this.rewards.login.length)+1;
  }
  // One login prize per natural day. Which index a row carries is a detail of the rule that
  // wrote it: the rule this table replaced capped the day at 7, so its seventh and later days
  // all recorded index 6. Reinterpreting that row under the cycle rule would pay the same day a
  // second time, so the day's claim is decided by the fact that a login row exists for today,
  // under either rule's key, and never by comparing indices.
  loginPaidToday(p) {
    const row=this.database.prepare('SELECT 1 AS paid FROM desktop_claim_v1 WHERE pet_id=? AND period=? AND kind IN (?,?) LIMIT 1')
      .get(p.pet_id,p.period,this.rewards.claimKind.login,this.rewards.previous.loginClaimKind);
    return Boolean(row);
  }
  cycle(p) {
    const streak=this.database.prepare('SELECT streak FROM desktop_login_v1 WHERE pet_id=?').get(p.pet_id).streak;
    return {streak,day:this.loginDay(p),length:this.rewards.login.length};
  }
  // Review64: tag2 is a snapshot of reached, unclaimed online tiers. Native
  // 44D0 adds newly reached tiers; only a committed server snapshot removes
  // claims. Root publishes through the original 2203 receiver, never a second
  // HTML decrement. The approved daily-task projection also counts claimable
  // buttons in tag1; incomplete tasks and future online tiers never contribute.
  dailyTaskInfo(uin,id,base,now=this.clock()) {
    return this.#dailyTaskInfo(this.touch(uin,id,now),base);
  }
  rewardNotices(uin,id,now=this.clock()) {
    const p=this.touch(uin,id,now),sign=this.signInfo(p);
    return {sign:Number(!sign.today||sign.giftbutton),growth:Number(!this.claimed(p,'growth'))};
  }
  // Read only after PostEntryState has committed this pet's daily clock.
  dailyTaskSnapshot(uin,id,base,now) {
    const p=this.profile(uin,id),login=this.database.prepare('SELECT last_day FROM desktop_login_v1 WHERE pet_id=?').get(p.pet_id);
    if(!login||dayOf(now)>login.last_day)throw Error('TOOLBAR_DAY_NOT_SETTLED');
    return this.#dailyTaskInfo({...p,day:login.last_day,period:iso(login.last_day)},base);
  }
  #dailyTaskInfo(p,base) {
    const online=this.online(p);
    const unclaimed=this.rewards.online.reduce((count,entry,index)=>
      count+Number(entry.seconds<=online&&!this.claimed(p,this.rewards.claimKind.online,index)),0);
    const done=this.events(p),activity=Math.min(100,this.tasks.reduce((n,t)=>n+(done.has(t.event)?t.active:0),0));
    const sign=this.signInfo(p);
    const daily=this.tasks.reduce((n,t)=>n+Number(done.has(t.event)&&!this.claimed(p,'task',t.id)),0)
      +ACTIVITY_THRESHOLDS.reduce((n,value)=>n+Number(activity>=value&&!this.claimed(p,'activity',value)),0)
      +Number(!this.loginPaidToday(p))+Number(!sign.today)+Number(!this.claimed(p,'growth'))
      +sign.giftbutton;
    return {noticeCount:Math.min(MAX,(base?.noticeCount??0)+daily),onlineGiftPrizeCount:unclaimed,
      currentBonusDay:this.loginDay(p),unknownTag4Hex:base?.unknownTag4Hex??'00000000'};
  }
  // The client's own tier set and the locked table agree row for row (minutes 1/5/15/30/60/90/120/
  // 150/180/240), so the reached-tier count is a comparison against this server's validated table.
  onlineTiersReached(online) {
    let reached=0;
    for(const entry of this.rewards.online)if(entry.seconds<=online)reached++;
    return reached;
  }
  signInfo(p) {
    const month=p.period.slice(0,7),d=new Date(p.day*DAY),days=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
    const first=p.day-d.getUTCDate()+1,rows=this.database.prepare("SELECT period FROM desktop_claim_v1 WHERE pet_id=? AND kind='sign' AND period>=? AND period<=?").all(p.pet_id,iso(first),iso(first+days-1));
    const dates=new Set(rows.map(r=>r.period)),n=dates.size;
    const giftinfo=this.operations.value.sign.monthly.map((_,i)=>this.claimed(p,'signGift',i,month)?2:n>=monthThresholds(days)[i]?1:0);
    return {date:p.period,signinfo:Array.from({length:days},(_,i)=>Number(dates.has(iso(first+i)))),signtimes:n,
      today:Number(dates.has(p.period)),giftbutton:Number(giftinfo.includes(1)),giftinfo};
  }
  request(uin,id,q,now=this.clock()) {
    const p=this.touch(uin,id,now),events=this.events(p),activity=Math.min(100,this.tasks.reduce((n,t)=>n+(events.has(t.event)?t.active:0),0));
    let data,notify;
    if(q.operation==='tasks') {
      const image='http://pet.qq.com/toolbar/task-icon.png';
      data=success({activity,actv_list:ACTIVITY_THRESHOLDS.map(n=>({actv:n,status:this.claimed(p,'activity',n)?2:activity>=n?1:0})),
        cont_list:{day:this.cycle(p).day,
          image,condition:'今天已登录',award:this.rewards.login.map((entry)=>entry.reward.kind==='yb'
            ?`${entry.reward.amount}元宝`:entry.reward.kind==='item'?`${entry.reward.name}×${entry.reward.count}`:entry.reward.name).join(' / '),
          active:0,status:this.loginPaidToday(p)?2:1},
        list:this.tasks.map(t=>({id:t.id,index:t.id,image,task:t.name,condition:t.condition,award:t.reward+'元宝',active:t.active,
          status:this.claimed(p,'task',t.id)?2:events.has(t.event)?1:0,sceneid:t.scene??5969123,npcid:0,
          lru:'http://act.pet.qq.com/toolbar/help.html?task='+t.event}))});
    }else if(q.operation==='loginGift') {
      // A day that already paid — under either rule's key — never pays again, whatever the tier
      // is called now; the version in force is the one that decides today's prize.
      if(this.loginPaidToday(p))data=failure('已经领取，请明天再来');
      else {
        const index=this.loginDay(p)-1;
        data=this.settle(p,this.rewards.claimKind.login,index,claimPrizes(this.rewards,'login',index));
      }
    }
    else if(q.operation==='taskGift') {
      const t=this.tasks.find(t=>t.id===q.value);
      data=t&&events.has(t.event)?this.settle(p,'task',t.id,{label:t.name,icon:'',tip:'',coins:[t.reward],items:[]}):failure('尚未完成此任务');
    }else if(q.operation==='activityGift') {
      const i=ACTIVITY_THRESHOLDS.indexOf(q.value);
      data=i>=0&&activity>=q.value?this.settle(p,'activity',q.value,{label:'活跃度',icon:'',tip:'',coins:[this.operations.value.activityAwards[i]],items:[]}):failure('活跃度尚未达到要求');
    }else if(q.operation==='onlineInfo') {
      const ot=this.online(p),seconds=this.rewards.online.map((entry)=>entry.seconds);
      const pkg=seconds.map((tier,i)=>this.claimed(p,this.rewards.claimKind.online,i)?2:ot>=tier?0:1),i=pkg.findIndex(n=>n!==2);
      data=success({ot,nt:i<0?0:Math.max(0,seconds[i]-ot),pkg,
        // The locked table the popup renders: label, icon, remaining seconds and the prize
        // that a claim of that tier actually pays.
        tiers:this.rewards.online.map((entry,i)=>({index:i,label:entry.label,icon:entry.icon,tip:entry.tip,
          seconds:entry.seconds,status:pkg[i]}))});
    }else if(q.operation==='onlineGift') {
      const ot=this.online(p),i=this.rewards.online.findIndex((entry,index)=>entry.seconds<=ot&&!this.claimed(p,this.rewards.claimKind.online,index));
      data=i<0?failure('暂无可领取的在线礼包'):this.settle(p,this.rewards.claimKind.online,i,claimPrizes(this.rewards,'online',i));
    }else if(q.operation==='signInfo')data=success({info:this.signInfo(p)});
    else if(q.operation==='sign') {data=this.settle(p,'sign',0,{label:'签到',icon:'',tip:'',coins:[this.operations.value.sign.daily],items:[]});data.info=this.signInfo(p);}
    else if(q.operation==='signTips')data=success({fuceng:this.operations.value.sign.monthly.map(n=>n+'元宝')});
    else if(q.operation==='signGift') {
      const info=this.signInfo(p),eligible=info.giftinfo.map((v,i)=>v===1?i:-1).filter(i=>i>=0);
      if(!eligible.length)data=failure('没有可领取的累计签到奖励');
      else {
        const sum=eligible.reduce((n,i)=>n+this.operations.value.sign.monthly[i],0);
        if(p.yuanbao>MAX-sum)data=failure('元宝达到上限，未领取奖励');
        else {for(const i of eligible)this.settle(p,'signGift',i,{label:'签到礼包',icon:'',tip:'',coins:[this.operations.value.sign.monthly[i]],items:[]},p.period.slice(0,7));data=success({msg:'获得'+sum+'元宝'});}
      }
    }else if(q.operation==='growthInfo')data=success({info:{freetime:this.claimed(p,'growth')?0:1}});
    else if(q.operation==='growthGift') {
      if(this.claimed(p,'growth'))data=failure('今天的成长值已经领取');
      else {
        const saved=this.database.prepare('SELECT state FROM desktop_growth_rng_v1 WHERE pet_id=?').get(p.pet_id);
        const seed=saved?.state??this.seedFactory();
        if(!Number.isInteger(seed)||seed<0||seed>0xffffffff)throw new TypeError('INVALID_GROWTH_SEED');
        const draw=drawDailyGrowth(seed),growth=Math.min(MAX,p.growth+draw.value);let level=p.level;
        this.database.prepare('INSERT INTO desktop_growth_rng_v1 VALUES(?,?) ON CONFLICT(pet_id) DO UPDATE SET state=excluded.state').run(p.pet_id,draw.state);
        while(level<1000&&growth>=growthStart(level+1))level++;
        this.database.prepare('INSERT INTO desktop_claim_v1 VALUES(?,?,?,0)').run(p.pet_id,p.period,'growth');
        this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x61=?,level_value=? WHERE pet_id=?').run(growth,level,p.pet_id);
        this.database.prepare('UPDATE pet SET growth=?,level=? WHERE pet_id=?').run(growth,level,p.pet_id);
        const vipGrowth=this.membership?.addGrowth?.(uin,id,draw.value)??0;
        data=success({msg:'获得'+(growth-p.growth)+'点成长值'+(vipGrowth?'，粉钻同时增加'+vipGrowth+'点成长值':''),growth:draw.value,vipGrowth,info:{freetime:0}});
      }
    }else throw Error('TOOLBAR_OPERATION_INVALID');
    if(data.result===0&&['loginGift','taskGift','activityGift','onlineGift','sign','signGift','growthGift'].includes(q.operation))notify='attributes';
    // `grants` is the item half of the prize. It travels out of this module so the caller's
    // transaction hands it to the shared inventory; the receipt written above and the grant
    // commit or roll back together, which is why neither is applied here.
    return {data,notify,...(Array.isArray(data.grants)?{grants:data.grants}:{})};
  }
}
