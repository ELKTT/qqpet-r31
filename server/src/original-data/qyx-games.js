import{createHash}from'node:crypto';import{decodeRoomScore}from'./room-adventure.js';
const DAY=86400000,MAX=0x7fffffff;
const fruitStage=Object.freeze({time:30,passmark:50,interval_min:10,interval_max:50,type1:{speed:7,rate:5},type2:{speed:6,rate:5},type3:{speed:10,rate:6},type15:{speed:10,rate:10},type16:{speed:10,rate:10}});
export function decodeQyxScore(game,info,proof,uin,flag){
 // The character interleave is shared; the two wrappers have different
 // flag polynomials from the room game and from each other.
 const expected=game==='qyx-sandwich'?(1109*flag**3+71*flag**2+3)%113:game==='other-31'?(3967*flag**3+331*flag**2+8167)%53:-1;
 if(!Number.isInteger(flag)||flag<1||flag>60||expected<0||proof!==expected)throw new TypeError('INVALID_QYX_SCORE');
 return decodeRoomScore(info,(137*flag**3+617*flag**2+997)%61,uin,flag);
}
export class QyxGames{
 constructor({database,careEconomy}){this.database=database;this.care=careEconomy;database.exec(`CREATE TABLE IF NOT EXISTS pet_qyx_progress_v1 (
  pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,game TEXT NOT NULL,state_json TEXT NOT NULL CHECK(json_valid(state_json)),PRIMARY KEY(pet_id,game)) STRICT;
  CREATE TABLE IF NOT EXISTS pet_qyx_receipt_v1 (pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,game TEXT NOT NULL,nonce TEXT NOT NULL,fingerprint TEXT NOT NULL,response_json TEXT NOT NULL CHECK(json_valid(response_json)),PRIMARY KEY(pet_id,game,nonce)) STRICT;`);}
 request(uin,id,q,onlineMs,now){const p=this.care.profile(uin,id),db=this.database,day=Math.floor((now+8*3600000)/DAY),row=db.prepare('SELECT state_json FROM pet_qyx_progress_v1 WHERE pet_id=? AND game=?').get(p.pet_id,q.game),s=row?JSON.parse(row.state_json):{version:1,day,used:0,unlocked:1,active:-1,began:0,points:0,best:Array(10).fill(0),flag:1,achievements:Array(24).fill(0),rewardDay:-1};
  if(s.version!==1||!['day','used','unlocked','active','began','points','flag','rewardDay'].every(k=>Number.isSafeInteger(s[k]))||!Array.isArray(s.best)||s.best.length!==10||!s.best.every(v=>Number.isInteger(v)&&v>=0&&v<=100000)||!Array.isArray(s.achievements)||s.achievements.length!==24||!s.achievements.every(v=>v===0||v===1))throw Error('INVALID_QYX_STATE');
  if(day>s.day){s.day=day;s.used=0;}
  const key=q.nonce===null?null:q.command+':'+q.nonce,fingerprint=createHash('sha256').update(JSON.stringify([q.command,Object.entries(q.params).sort()])).digest('hex'),previous=key&&db.prepare('SELECT fingerprint,response_json FROM pet_qyx_receipt_v1 WHERE pet_id=? AND game=? AND nonce=?').get(p.pet_id,q.game,key);
  if(previous)return previous.fingerprint===fingerprint?JSON.parse(previous.response_json):{result:-1,msg:'请求标识冲突'};
  const a=q.params,free=p.vipLevel>0?4:3,fail=msg=>({result:-1,msg}),charge=()=>{const balance=db.prepare('SELECT unknown_0x67 AS n FROM qqpenguin_login_profile WHERE pet_id=?').get(p.pet_id).n;if(balance<10)return false;db.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67-10 WHERE pet_id=?').run(p.pet_id);return true;};
  let r={result:0,msg:'祝宝贝玩得开心！'},changes=false;
  const start=level=>{if(q.kind==='river'?level>=s.unlocked:level>s.unlocked)return false;s.active=level;s.began=onlineMs;s.used++;s.flag=s.flag%60+1;changes=true;return true;};
  if(q.kind==='other'){
   if(q.command==='2'){start(1);}
   if(q.command==='3'){if(s.active!==1)return fail('请先开始游戏');let score;try{score=decodeQyxScore(q.game,a.info,a.score,uin,s.flag);}catch{return fail('分数校验失败，请重新开始');}s.best[0]=Math.max(s.best[0],score);s.active=-1;changes=true;r.msg='成绩已保存，心情随实际游玩时间增加。';}
   r={...r,uin,flag:s.flag,vip:p.vipLevel>0?1:0,sex:p.sex==='male'?102:103,level:p.level<5?1:p.level<10?2:3};
  }else if(q.kind==='mission'){
   if(['2','9'].includes(q.command)){
    if(a.level>s.unlocked)return fail('请先完成前面的关卡');
    if(q.command==='2'&&s.used>=free)return fail('今天的免费次数已用完，继续闯关需要10元宝');
    if(q.command==='9'&&!charge())return fail('元宝不足，继续闯关需要10元宝');start(a.level);r.num=1;
   }else if(['6','7'].includes(q.command)){
    if(s.active!==a.level||onlineMs-s.began<1000)return fail('本关尚未开始或已经结算');
    r.newstairscore=Number(a.stairs>s.best[a.level-1]);s.best[a.level-1]=Math.max(s.best[a.level-1],a.stairs);
    if(q.command==='7'){s.points=Math.min(MAX,s.points+1);s.unlocked=Math.min(10,Math.max(s.unlocked,a.level+1));r.msg='通关成功，获得1积分！';}else r.msg='本次成绩已保存，再接再厉！';s.active=-1;changes=true;
   }else if(q.command==='3'){if(a.achieveid>=1&&a.achieveid<=24&&s.active===a.level){s.achievements[a.achieveid-1]=1;changes=true;}}
   else if(q.command==='4'){if(s.active!==a.level)return fail('请先进入关卡');r.woodbox_flag=1;r.silverbox_flag=1;}
   else if(['5','8','10'].includes(q.command))return fail('此奖励的可靠奖品清单尚未补齐，本次未扣费。');
   r={...r,times:Math.max(0,free-s.used),maxlevel:s.unlocked,score:s.points,starnum:0,...Object.fromEntries(s.best.map((v,i)=>['maxstair'+(i+1),v])),...Object.fromEntries(s.achievements.map((v,i)=>['achieve'+(i+1)+'_flag',v]))};
  }else if(q.kind==='river'){
   if(q.command==='enter'){if(!start(a.stage))return fail('请先通过前面的关卡');}
   else if(['report','drop'].includes(q.command)){
    if(s.active!==a.stage||onlineMs-s.began<1000||a.num>(a.all??100000))return fail('本次过河尚未开始或已经结算');
    s.best[a.stage]=Math.max(s.best[a.stage],a.num);if(q.command==='report')s.unlocked=Math.min(5,Math.max(s.unlocked,a.stage+2));s.active=-1;changes=true;r.msg=q.command==='report'?'过河成功！':'本次挑战结束，再接再厉！';
   }else if(['buy','exchange'].includes(q.command))return fail('此兑换的可靠奖品及价格清单尚未补齐，本次未扣费。');
   r.info={totle_start:s.used,pkg_exchangetimes:Array(6).fill(0),fish_nums:Array(4).fill(0),hp:5,coins:[0,0,0],totle_penguin:s.best.reduce((a,b)=>a+b,0),freetimes:3,totle_fish:0,vip:p.vipLevel>0?1:0,curmaxstage:Math.min(5,s.unlocked),totle_buyhp:0};
  }else if(q.kind==='fruit'){
   if(q.command==='begin'){if(!start(a.n))return fail('请先通过前面的关卡');r.stageinfo=fruitStage;}
   else if(q.command==='finish'){
    if(s.active<1||onlineMs-s.began<1000)return fail('本局尚未开始或已经结算');const level=s.active;const win=a.score>=fruitStage.passmark;s.best[level-1]=Math.max(s.best[level-1],a.score);if(win)s.unlocked=Math.min(10,Math.max(s.unlocked,level+1));s.active=-1;changes=true;r.next_level=win?Math.min(10,level+1):0;r.prize='';
   }else if(['buy','reward','get_title'].includes(q.command))return fail('此奖励的可靠奖品清单尚未补齐，心情仍按实际游玩时间增加。');
   r={...r,times:3,reward:1,lastlevel:s.unlocked,scene:Array.from({length:10},(_,i)=>i<s.unlocked?'1':'0').join(''),saving:Array(16).fill(0),achievement:Array(8).fill(0),gain:Array(8).fill(0),title:[]};
  }
  if(changes||!row)db.prepare('INSERT INTO pet_qyx_progress_v1 VALUES(?,?,?) ON CONFLICT(pet_id,game) DO UPDATE SET state_json=excluded.state_json').run(p.pet_id,q.game,JSON.stringify(s));
  if(key&&changes){db.prepare('INSERT INTO pet_qyx_receipt_v1 VALUES(?,?,?,?,?)').run(p.pet_id,q.game,key,fingerprint,JSON.stringify(r));db.prepare('DELETE FROM pet_qyx_receipt_v1 WHERE pet_id=? AND game=? AND rowid NOT IN (SELECT rowid FROM pet_qyx_receipt_v1 WHERE pet_id=? AND game=? ORDER BY rowid DESC LIMIT 128)').run(p.pet_id,q.game,p.pet_id,q.game);}
  return r;
 }
}
