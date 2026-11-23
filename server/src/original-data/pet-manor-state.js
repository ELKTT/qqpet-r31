import {randomInt} from 'node:crypto';
// User-approved local batches: four coins, random 1–9 each, refill after depletion.
// Manor SWF 346/352 consumes these fields. 534 routes snapshots by command id,
// including after Protocol.reset; no request-busy check gates receiving a snapshot.
export const MANOR_REFILL_MS=1800000;
// The original Flash timer adds only ONE coin per tick. The server publishes a
// complete four-coin snapshot at the durable deadline; park that client timer.
export const MANOR_CLIENT_TIMER_SECONDS=2147483;
const MAX=0x7fffffff,MAX_TIME=0xffffffff*1000;
export class PetManorState {
  constructor({database,friends,coinValueFactory=()=>randomInt(1,10),entranceStatus=()=>({farm:3,fish:3})}) {
    if(friends?.database!==database)throw new TypeError('MANOR_REQUIRES_SHARED_FRIENDS');
    if(typeof coinValueFactory!=='function')throw new TypeError('INVALID_MANOR_RANDOM');
    if(typeof entranceStatus!=='function')throw new TypeError('INVALID_MANOR_ENTRANCE_STATUS');
    this.entranceStatus=entranceStatus;
    this.database=database;this.friends=friends;this.coinValueFactory=coinValueFactory;
    database.exec(`CREATE TABLE IF NOT EXISTS pet_manor_coins_v1 (
      actor_pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      target_pet_id TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND 4),
      refill_at INTEGER CHECK(refill_at BETWEEN 0 AND ${MAX_TIME}),
      CHECK((remaining=0 AND refill_at IS NOT NULL) OR (remaining>0 AND refill_at IS NULL)),
      PRIMARY KEY(actor_pet_id,target_pet_id)) STRICT;
      CREATE TABLE IF NOT EXISTS pet_manor_coin_values_v2 (
      actor_pet_id TEXT NOT NULL,target_pet_id TEXT NOT NULL,
      v0 INTEGER NOT NULL CHECK(v0 BETWEEN 1 AND 9),v1 INTEGER NOT NULL CHECK(v1 BETWEEN 1 AND 9),
      v2 INTEGER NOT NULL CHECK(v2 BETWEEN 1 AND 9),v3 INTEGER NOT NULL CHECK(v3 BETWEEN 1 AND 9),
      PRIMARY KEY(actor_pet_id,target_pet_id),
      FOREIGN KEY(actor_pet_id,target_pet_id) REFERENCES pet_manor_coins_v1(actor_pet_id,target_pet_id) ON DELETE CASCADE) STRICT;`);
  }
  pair(uin,petId,targetId) {
    const actor=this.friends.find(uin,petId.readBigUInt64LE().toString()),peer=this.friends.find(undefined,targetId);
    return actor&&peer?{actor,peer}:null;
  }
  row(pair) {
    return this.database.prepare('SELECT remaining,refill_at FROM pet_manor_coins_v1 WHERE actor_pet_id=? AND target_pet_id=?')
      .get(pair.actor.pet_id,pair.peer.pet_id);
  }
  deadline(uin,petId,targetId) {
    const pair=this.pair(uin,petId,targetId);return pair?this.row(pair)?.refill_at??null:null;
  }
  ready(pair,now) {
    if(!Number.isSafeInteger(now)||now<0||now>MAX_TIME-MANOR_REFILL_MS)throw new Error('INVALID_MANOR_CLOCK');
    this.database.prepare('INSERT OR IGNORE INTO pet_manor_coins_v1 VALUES(?,?,4,NULL)').run(pair.actor.pet_id,pair.peer.pet_id);
    let row=this.row(pair);
    const values=this.database.prepare('SELECT 1 FROM pet_manor_coin_values_v2 WHERE actor_pet_id=? AND target_pet_id=?')
      .get(pair.actor.pet_id,pair.peer.pet_id);
    if(!values)this.roll(pair);
    if(row.remaining===0&&now>=row.refill_at) {
      this.database.prepare('UPDATE pet_manor_coins_v1 SET remaining=4,refill_at=NULL WHERE actor_pet_id=? AND target_pet_id=?')
        .run(pair.actor.pet_id,pair.peer.pet_id);
      this.roll(pair);
      row=this.row(pair);
    }
    return row;
  }
  roll(pair) {
    const values=Array.from({length:4},()=>this.coinValueFactory());
    if(values.some(v=>!Number.isInteger(v)||v<1||v>9))throw new Error('INVALID_MANOR_COIN_VALUE');
    this.database.prepare('INSERT OR REPLACE INTO pet_manor_coin_values_v2 VALUES(?,?,?,?,?,?)')
      .run(pair.actor.pet_id,pair.peer.pet_id,...values);
  }
  // Called only inside the caller's checkpoint transaction, including the wallet write.
  request(uin,petId,now,{head,data},readOnlineMs=()=>0) {
    const targetId=data.ullPetID,pair=this.pair(uin,petId,targetId);
    const failure=msg=>({cResult:1,strMsg:msg,...(head.cmd===10?{ullPetID:targetId}:{})});
    if(!pair)return failure('宠物不可访问');
    const row=this.ready(pair,now);
    if(head.cmd===9) {
      const status=this.entranceStatus(pair.peer,readOnlineMs(pair.peer));
      if(![1,2,3].includes(status.farm)||![1,2,3].includes(status.fish))throw new Error('INVALID_MANOR_ENTRANCE_STATUS');
      return {cResult:0,strMsg:'',uFarmButtonStatus:status.farm,uFishButtonStatus:status.fish,
        uYuanBao:row.remaining,uShowYuanBaoLeftTime:MANOR_CLIENT_TIMER_SECONDS};
    }
    if(row.remaining===0)return failure('元宝尚未刷新');
    const r=this.database.prepare('SELECT unknown_0x67 AS yb FROM qqpenguin_login_profile WHERE pet_id=?').get(pair.actor.pet_id);
    if(!Number.isInteger(r?.yb)||r.yb<0||r.yb>MAX)throw new Error('INVALID_MANOR_WALLET');
    const values=this.database.prepare('SELECT v0,v1,v2,v3 FROM pet_manor_coin_values_v2 WHERE actor_pet_id=? AND target_pet_id=?')
      .get(pair.actor.pet_id,pair.peer.pet_id),amount=values['v'+(4-row.remaining)];
    if(r.yb>MAX-amount)return failure('元宝已达上限');
    this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=unknown_0x67+? WHERE pet_id=?').run(amount,pair.actor.pet_id);
    this.database.prepare('UPDATE pet_manor_coins_v1 SET remaining=?,refill_at=? WHERE actor_pet_id=? AND target_pet_id=?')
      .run(row.remaining-1,row.remaining===1?now+MANOR_REFILL_MS:null,pair.actor.pet_id,pair.peer.pet_id);
    // The original UI ignores uAward and writes a literal 1. This local field
    // exposes the committed amount for the separately reviewed display variant.
    return {cResult:0,ullPetID:targetId,strMsg:'',uAward:amount};
  }
}
