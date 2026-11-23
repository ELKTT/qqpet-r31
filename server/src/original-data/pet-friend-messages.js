import {createHash} from 'node:crypto';
import {friendXml,friendXmlAttributes} from '../protocol/friend-http.js';

const html=text=>String(text).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Original BrowseMsg/SendMsg contract. Mutations share the caller's checkpoint
// transaction with care/game awards; message bodies never enter status/log output.
export class PetFriendMessages {
  constructor(friends) {
    this.friends=friends;this.database=friends.database;
    this.database.exec(`CREATE TABLE IF NOT EXISTS pet_friend_messages_v1 (
      sequence INTEGER PRIMARY KEY,recipient TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      sender TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      kind INTEGER NOT NULL CHECK(kind IN (1,2)),event_id INTEGER NOT NULL,
      word TEXT NOT NULL CHECK(length(word) BETWEEN 1 AND 512),created_at INTEGER NOT NULL,
      unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1))) STRICT;
      CREATE INDEX IF NOT EXISTS pet_friend_messages_recipient ON pet_friend_messages_v1(recipient,kind,sequence);
      CREATE TABLE IF NOT EXISTS pet_friend_message_receipts_v1 (
      sender TEXT NOT NULL REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(sender,request_id)) STRICT;`);
  }
  unread(petId) {
    return this.database.prepare('SELECT count(*) AS n FROM pet_friend_messages_v1 WHERE recipient=? AND unread=1').get(petId).n;
  }
  record(sender,recipient,kind,eventId,word,now) {
    if(![1,2].includes(kind)||!Number.isInteger(eventId)||typeof word!=='string'||!word||word.length>512
        ||!Number.isSafeInteger(now)||now<0)throw new TypeError('FRIEND_MESSAGE_INVALID');
    this.database.prepare('INSERT INTO pet_friend_messages_v1(recipient,sender,kind,event_id,word,created_at) VALUES(?,?,?,?,?,?)')
      .run(recipient,sender,kind,eventId,word,now);
    this.database.prepare('DELETE FROM pet_friend_messages_v1 WHERE recipient=? AND kind=? AND sequence NOT IN '+
      '(SELECT sequence FROM pet_friend_messages_v1 WHERE recipient=? AND kind=? ORDER BY sequence DESC LIMIT 50)')
      .run(recipient,kind,recipient,kind);
  }
  send(actorUin,actorBytes,peer,{word,nonce},scope,now) {
    const actor=this.friends.find(actorUin,actorBytes.readBigUInt64LE().toString());
    if(!actor||!peer||actor.uin===peer.uin||typeof scope!=='string'||!scope||scope.length>200
        ||!Number.isFinite(nonce)||nonce<0||nonce>=1||typeof word!=='string'||!word.trim()
        ||[...word].length>200||word.split(/\r\n|\r|\n/).length>3
        ||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f"'#&\ufffe\uffff]/.test(word))return friendXml({result:1,msg:'留言内容无效'});
    const key=digest([scope,nonce]),fingerprint=digest([peer.pet_id,word]);
    const old=this.database.prepare('SELECT fingerprint FROM pet_friend_message_receipts_v1 WHERE sender=? AND request_id=?').get(actor.pet_id,key);
    if(old)return friendXml(old.fingerprint===fingerprint?{result:0,msg:'留言已发送'}:{result:1,msg:'请重新发送留言'});
    this.record(actor.pet_id,peer.pet_id,2,0,word,now);
    this.database.prepare('INSERT INTO pet_friend_message_receipts_v1 VALUES(?,?,?)').run(actor.pet_id,key,fingerprint);
    this.database.prepare('DELETE FROM pet_friend_message_receipts_v1 WHERE sender=? AND rowid NOT IN '+
      '(SELECT rowid FROM pet_friend_message_receipts_v1 WHERE sender=? ORDER BY rowid DESC LIMIT 64)').run(actor.pet_id,actor.pet_id);
    return friendXml({result:0,msg:'留言已发送'});
  }
  browse(uin,kind) {
    const actor=this.friends.find(uin);if(!actor||![1,2].includes(kind))return friendXml({result:1,msg:'资料不可访问'});
    const p=actor.profile.login,points=this.database.prepare('SELECT COALESCE(sum(points),0) AS n FROM pet_friend_love_v1 WHERE actor_pet_id=?').get(actor.pet_id).n;
    const rows=this.database.prepare('SELECT m.*,p.uin,a.qq_name FROM pet_friend_messages_v1 m JOIN pet p ON p.pet_id=m.sender '+
      'JOIN account a USING(uin) WHERE m.recipient=? AND m.kind=? ORDER BY m.sequence').all(actor.pet_id,kind);
    const children=rows.map(row=>'<item'+friendXmlAttributes({id:row.event_id,uin:row.uin,petid:row.sender,name:html(row.qq_name),word:html(row.word),
      time:new Date(row.created_at+8*3600000).toISOString().slice(0,19).replace('T',' ')})+'/>').join('');
    const result=friendXml({result:0},'<baseinfo'+friendXmlAttributes({pic:'',name:this.friends.name(p),lovelevel:Math.floor(points/10),
      lovevalue:points,petlevel:p.levelValue,growth:p.unknown_0x61})+'/>'+
      '<info'+friendXmlAttributes({unread:rows.filter(r=>r.unread).length})+'>'+children+'</info>');
    this.database.prepare('UPDATE pet_friend_messages_v1 SET unread=0 WHERE recipient=? AND kind=?').run(actor.pet_id,kind);
    return result;
  }
  clear(uin,kind) {
    const actor=this.friends.find(uin);if(!actor||![1,2].includes(kind))return friendXml({result:1,msg:'资料不可访问'});
    this.database.prepare('DELETE FROM pet_friend_messages_v1 WHERE recipient=? AND kind=?').run(actor.pet_id,kind);
    return friendXml({result:0,msg:'已清空'});
  }
}
