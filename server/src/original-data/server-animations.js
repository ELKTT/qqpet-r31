import{randomInt}from'node:crypto';
import{animationHolidays,annualBirthday,petBirthdayDate}from'./animation-calendar.js';
const EVENTS=new Set(['entry','exit','work','study','birthday','newyear','valentine','women','aprilfools','labor','children','teachers','national','christmas','mothers','fathers','thanksgiving','easter','spring','dragonboat','qixi','midautumn']);
const SPEECH={
 male:{work:['{name}，我去认真干活啦，赚元宝给咱们的小家添点宝贝！','{name}，小小男子汉开工啦，等我满载而归！','{name}，给我加加油吧，我会把工作做得棒棒的！'],study:['{name}，我要带着满满的好奇心去上课啦！','{name}，今天也要认真听讲，学会了就讲给你听！','{name}，等我变聪明一点，再陪你玩呀！']},
 female:{work:['{name}，勤快的小企鹅出发啦，要把工作做得漂漂亮亮！','{name}，我去赚元宝啦，回来要一个大大的夸奖！','{name}，今天也会努力工作，给我们的小家添点温暖！'],study:['{name}，小书包准备好啦，我要去学新本领！','{name}，今天要认真听课，回来和你分享小发现！','{name}，给我一点鼓励吧，我会乖乖把知识记住的！']}
};
export function validateAnimationCatalog(catalog){
 if(catalog?.version!==1||!Array.isArray(catalog.movies)||catalog.movies.length>512)throw new TypeError('INVALID_ANIMATION_CATALOG');
 const ids=new Set();
 for(const r of catalog.movies){
  if(![102,103,112,113,122,123].includes(r.phase)||!EVENTS.has(r.event)||!Number.isInteger(r.action)||r.action<1||r.action>=10000000||r.action===214
   ||(r.action<1000000&&!((r.action===201&&r.event==='entry')||(r.action===202&&r.event==='exit')))
   ||!/^[a-f0-9]{64}$/.test(r.content)||!/^[a-f0-9]{64}$/.test(r.sha256)||typeof r.label!=='string'||r.label.length>256||typeof r.path!=='string'||!/^Action\/[A-Za-z0-9/_-]+\.swf$/.test(r.path))throw new TypeError('INVALID_ANIMATION_MOVIE');
  const key=r.phase+':'+r.event+':'+r.action;if(ids.has(key))throw new TypeError('DUPLICATE_ANIMATION');ids.add(key);
 }
 return structuredClone(catalog.movies);
}
// The caller owns the SQLite transaction, sharing entry/activity/exit commits.
// Receipts mean dispatched selection, not proof the viewer watched the movie.
export class ServerAnimations{
 constructor({database,catalog,random=randomInt}){
  this.database=database;this.movies=validateAnimationCatalog(catalog);this.random=random;
  database.exec(`CREATE TABLE IF NOT EXISTS pet_animation_v1(pet_id TEXT PRIMARY KEY REFERENCES pet(pet_id), state_json TEXT NOT NULL CHECK(json_valid(state_json))) STRICT;`);
  this.identity=database.prepare(`SELECT p.pet_id,p.sex,p.birthday,q.master_name_bytes,q.level_value AS level,b.birthday AS ownerBirthday,
   (SELECT MIN(created_at) FROM pet_adoption_v1 d WHERE d.pet_id=p.pet_id) AS adoptedAt
   FROM pet p JOIN qqpenguin_login_profile q ON q.pet_id=p.pet_id
   LEFT JOIN account_birthday_v1 b ON b.uin=p.uin WHERE p.uin=? AND q.pet_id_bytes=?`);
 }
 pick(rows){if(!rows.length)return null;const i=this.random(rows.length);if(!Number.isInteger(i)||i<0||i>=rows.length)throw new Error('INVALID_ANIMATION_RANDOM');return rows[i];}
 context(uin,petId){
  const r=this.identity.get(uin,petId);if(!r||!Number.isInteger(r.level)||r.level<0||!['male','female'].includes(r.sex))throw new Error('INVALID_ANIMATION_PET');
  r.birthday=petBirthdayDate(r.birthday,r.adoptedAt);
  // PhaseLogic SHA b0ff0c79, RVA16D0: 0..4 -> 110; 5..9 ->120; >=10 ->100.
  r.phase=(r.level<5?110:r.level<10?120:100)+petId.readUInt16LE(4)%10;
  if(![102,103,112,113,122,123].includes(r.phase))throw new Error('INVALID_ANIMATION_PHASE');
  // Match the owner name displayed by PetInfo, including its GB18030/NUL decoding.
  const end=r.master_name_bytes.indexOf(0),name=new TextDecoder('gb18030',{fatal:false}).decode(end<0?r.master_name_bytes:r.master_name_bytes.subarray(0,end));
  r.name=name.replace(/[<>\x00-\x1f]/g,'')||'主人';return r;
 }
 select(uin,petId,event,now,{firstAdoption=false,activityName}={}){
  if(!['entry','exit','work','study'].includes(event))throw new TypeError('INVALID_ANIMATION_EVENT');
  if(firstAdoption){if(event!=='entry')throw new TypeError('INVALID_BIRTH_EVENT');return {action:214};}
  const r=this.context(uin,petId),calendar=animationHolidays(now),stored=this.database.prepare('SELECT state_json FROM pet_animation_v1 WHERE pet_id=?').get(r.pet_id);
  const s=stored?JSON.parse(stored.state_json):{date:calendar.date,used:[],last:{}};
  if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)||!Array.isArray(s.used)||s.used.length>512||s.used.some(x=>typeof x!=='string'||!(/^[a-z]+:[a-f0-9]{64}$/.test(x)||x==='birthday:greeting'))
   ||!s.last||Array.isArray(s.last)||typeof s.last!=='object'||Object.entries(s.last).some(([k,v])=>!['entry','exit'].includes(k)||!/^[a-f0-9]{64}$/.test(v)))throw new Error('INVALID_ANIMATION_RECEIPT');
  if(s.date!==calendar.date){s.date=calendar.date;s.used=[];}
  let candidates=this.movies.filter(x=>x.phase===r.phase),chosen=null,speech;
  const daily=kind=>{const pool=candidates.filter(x=>x.event===kind),other=pool.filter(x=>x.content!==s.last[kind]);return this.pick(other.length?other:pool);};
  if(event==='entry'){
   const birthday=r.birthday!==calendar.date&&(annualBirthday(r.ownerBirthday)===calendar.date.slice(5)||(typeof r.birthday==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(r.birthday)&&r.birthday.slice(5)===calendar.date.slice(5)));
   const special=[...(birthday?['birthday']:[]),...calendar.events];
   for(const kind of special){
    const pool=candidates.filter(x=>x.event===kind),unused=pool.filter(x=>!s.used.includes(kind+':'+x.content));
    chosen=this.pick(unused);
    if(chosen){s.used.push(kind+':'+chosen.content);break;}
    if(kind==='birthday'&&!pool.length&&!s.used.includes('birthday:greeting')){s.used.push('birthday:greeting');chosen=daily('entry');speech=`${r.name}，生日快乐！愿每一天都有暖暖的陪伴和小惊喜！`;break;}
   }
   chosen??=daily('entry');
  }else if(event==='exit')chosen=daily('exit');
  else{
   if(typeof activityName!=='string'||activityName.length>128)throw new TypeError('INVALID_ACTIVITY_NAME');
   const match=event==='study'?/音乐|美术|礼仪/.test(activityName)?5:/体育|劳技|武术/.test(activityName)?8:/政治|数学|语文/.test(activityName)?11:null
    :Object.entries({'搬砖':1,'保安':2,'花匠':3,'记者':4,'摄影师':4,'木匠':6,'泥瓦':7,'演员':9,'园丁':10}).find(([n])=>activityName.includes(n))?.[1];
   // The description's role is also checked (reporter and photographer share an ID).
   chosen=candidates.find(x=>x.event===event&&x.action===2000000+match&&(event==='study'||activityName.includes(x.label)||x.label.includes(activityName)))??null;
   speech=this.pick(SPEECH[r.sex][event]).replace('{name}',r.name);
  }
  if(chosen&&['entry','exit'].includes(chosen.event))s.last[event]=chosen.content;
  this.database.prepare('INSERT INTO pet_animation_v1 VALUES(?,?) ON CONFLICT(pet_id) DO UPDATE SET state_json=excluded.state_json').run(r.pet_id,JSON.stringify(s));
  return {action:chosen?.action??(event==='entry'?201:event==='exit'?202:0),...(speech?{speech}:{}),event:chosen?.event??event};
 }
}
