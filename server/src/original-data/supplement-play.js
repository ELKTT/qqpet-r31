import {supplementGameCatalogue} from './supplement-game-catalogue.js';
import {RoomAdventure} from './room-adventure.js';
import {QyxGames} from './qyx-games.js';
export class SupplementPlay {
 constructor({database,careEconomy,petBusiness}){
  this.database=database;this.care=careEconomy;this.business=petBusiness;this.games=new Map(supplementGameCatalogue().map(e=>[e.id,e]));
  database.exec(`CREATE TABLE IF NOT EXISTS pet_supplement_play_v1 (
   pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   game TEXT NOT NULL, nonce TEXT NOT NULL, last_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL,
   sequence INTEGER NOT NULL) STRICT;`);
  database.exec(`CREATE TABLE IF NOT EXISTS pet_room_game_v1 (
   pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
   unlocked INTEGER NOT NULL CHECK(unlocked BETWEEN 1 AND 10),active INTEGER NOT NULL CHECK(active BETWEEN 0 AND 10)) STRICT;`);
  this.room=new RoomAdventure({database,careEconomy});
  this.qyx=new QyxGames({database,careEconomy});
 }
 legacy(uin,petId,q,onlineMs=0,now=Date.now()){
  const p=this.care.profile(uin,petId);
  if(p.health!==5)return {result:-1,msg:'请让宝贝恢复健康后再来玩。'};
  if(q.kind&&this.games.has(q.game))return this.qyx.request(uin,petId,q,onlineMs,now);
  if(q.game==='carnival'){
   // These are movie branch codes, not a universal zero-success convention.
   // Gift-free branches preserve the existing practice/time-mood policy;
   // the original item/prize table has not been supplied.
   const male=p.sex==='male',codes={startHighJump:5,HighJump:male?2:4,startrace:5,
    racemain:male?2:4,startswim:5,swim:male?2:4,balloonstart:0,balloon:male?2:4};
   const result=['baseball','rockcraft'].includes(q.command)?q.type===3?9:male?3:7:codes[q.command]??0;
   return {result,msg:'练习游玩不扣元宝，心情奖励随游玩时间结算。'};
  }
  return this.room.request(uin,petId,q);
 }
 request(uin,petId,q,onlineMs){
  const p=this.care.profile(uin,petId),g=this.games.get(q.game);
  if(!g||g.unavailable||p.level<g.minLevel||g.sex!==null&&(p.sex==='male'?0:1)!==g.sex||p.health!==5)return {result:1,msg:'资源未齐，或宝贝的等级、性别和健康不符合游玩条件。'};
  const row=this.database.prepare('SELECT * FROM pet_supplement_play_v1 WHERE pet_id=?').get(p.pet_id);
  if(q.operation==='game-start'){
   if(row?.nonce===q.nonce&&row.game===q.game)return {result:0,sequence:row.sequence};
   this.database.prepare('INSERT INTO pet_supplement_play_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET game=excluded.game,nonce=excluded.nonce,last_ms=excluded.last_ms,active_ms=0,sequence=0')
    .run(p.pet_id,q.game,q.nonce,onlineMs,0,0);return {result:0,sequence:0};
  }
  if(!row||row.game!==q.game||row.nonce!==q.nonce||q.sequence!==row.sequence+1)return {result:1,msg:'游戏会话已结束，请重新打开。'};
  const elapsed=onlineMs-row.last_ms;
  let active=row.active_ms+(elapsed>0&&elapsed<=15000?elapsed:0),mood=0;
  if(this.activityRules){const result=this.activityRules.gameMood(uin,petId,elapsed>0&&elapsed<=15000?elapsed:0,row.active_ms);mood=result.mood;active=result.remainder;
   this.activityRules.tasks?.record(uin,petId,'interact');}
  else if(active>=30000){mood=this.business.grantInteractionMood(uin,petId,onlineMs);active%=30000;}
  this.database.prepare('UPDATE pet_supplement_play_v1 SET last_ms=?,active_ms=?,sequence=? WHERE pet_id=?').run(onlineMs,active,q.sequence,p.pet_id);
  return {result:0,mood,sequence:q.sequence,msg:mood?'玩得真开心，心情 +'+mood:'游戏进行中'};
 }
}
