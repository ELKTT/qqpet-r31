import {createHash,randomBytes as systemRandomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {growthStart,careMaximum} from '../original-data/online-pet-state.js';
import {LOCAL_NORMAL_PET_SIZE_VALUE} from '../protocol/login-pet-state.js';
import {annualBirthday,beijingDate} from '../original-data/animation-calendar.js';

// Persistent local accounts. This is the one place a person is turned into a login identity:
// the same row that the launcher authenticates is the row the pet, the community session, the
// market cookies and the Root ticket are all keyed on, so nothing has to be re-bound later.
//
// "Registered, no pet yet" is a legal state here. It is the state a new account is in between
// registration and first adoption, and every other module has to accept it rather than being
// handed a placeholder pet.

export const ACCOUNT_SCHEMA='qqpet-local-accounts/v1';
export const CREDENTIAL_ALGO='scrypt-v1';
const SCRYPT={cost:16384,block:8,parallel:1,keyLength:32,saltLength:16};
// Historical sequence origin retained for consumers of archived fixtures. New registration
// uses its normalized uint32 login number directly; existing account IDs are never migrated.
export const FIRST_INTERNAL_UIN=900000001;
const MAX_UIN=0xffffffff;
const LOGIN_NAME=/^[1-9][0-9]{4,9}$/;
const PASSWORD_MIN=8,PASSWORD_MAX=128;
const SESSION_TTL_MS=3600000,ADMIN_SESSION_TTL_MS=1800000;

const sha256=(value)=>createHash('sha256').update(value).digest();

export class AccountError extends Error {
  constructor(code,message){super(message);this.name='AccountError';this.code=code;}
}

function requireText(value,label,{min=1,max=64}={}) {
  if(typeof value!=='string'||value.length<min||value.length>max||/[\u0000-\u001f\u007f]/.test(value))
    throw new AccountError('INVALID_INPUT',`${label} is not acceptable`);
  return value;
}

// The login name is the person's own identifier, kept exactly as typed but normalised for
// uniqueness. It is never derived from an archive folder name or any other file path.
export function normalizeLoginName(value) {
  const name=typeof value==='string'?value.trim().normalize('NFKC'):'';
  if(!LOGIN_NAME.test(name))throw new AccountError('INVALID_LOGIN_NAME','账号需为 5-10 位数字');
  return name;
}

// New registrations use the native uint32 identity directly. Legacy login names
// remain governed by normalizeLoginName, including old names above uint32.
export function registrationIdentity(value) {
  const loginName=normalizeLoginName(value),uin=Number(loginName);
  if(uin<10000||uin>MAX_UIN)throw new AccountError('REGISTRATION_NUMBER_RANGE','注册号码须在 10000 到 4294967295 之间');
  return {loginName,uin};
}

// The password rules are stated up front so a rejection is never a mystery. The value never
// leaves this module: only its salt and digest are stored, and only the caller with the plain
// text can check it.
export function validatePassword(password,confirm) {
  if(typeof password!=='string')throw new AccountError('INVALID_PASSWORD','密码不能为空');
  if(password.length<PASSWORD_MIN||password.length>PASSWORD_MAX)throw new AccountError('INVALID_PASSWORD','密码长度需为 8-128 个字符');
  if(/[\u0000\r\n]/.test(password))throw new AccountError('INVALID_PASSWORD','密码不能包含换行或空字符');
  if(confirm!==undefined&&password!==confirm)throw new AccountError('PASSWORD_MISMATCH','两次输入的密码不一致');
  return password;
}

export function hashCredential(password,{salt,params}={}) {
  const actualSalt=salt??systemRandomBytes(SCRYPT.saltLength);
  if(!Buffer.isBuffer(actualSalt)||actualSalt.length!==SCRYPT.saltLength)throw new AccountError('INVALID_SALT','salt must be 16 bytes');
  const digest=scryptSync(Buffer.from(password,'utf8'),actualSalt,SCRYPT.keyLength,{N:SCRYPT.cost,r:SCRYPT.block,p:SCRYPT.parallel});
  return Object.freeze({algo:CREDENTIAL_ALGO,salt:actualSalt,cost:SCRYPT.cost,block:SCRYPT.block,parallel:SCRYPT.parallel,digest});
}

export function verifyCredential(password,record) {
  if(!record||record.algo!==CREDENTIAL_ALGO)return false;
  try {
    const digest=scryptSync(Buffer.from(password,'utf8'),Buffer.from(record.salt),record.digest.length,
      {N:record.cost,r:record.block,p:record.parallel});
    return digest.length===record.digest.length&&timingSafeEqual(digest,Buffer.from(record.digest));
  } catch {return false;}
}

// The credential the launcher used to send, kept only so a save written before the salted
// scheme can still be opened. It is a compatibility path, not a second supported scheme: a
// matching login is rewritten to the salted form in the same transaction and the row records
// that it came from the old value.
export function legacyMd5(password) {return createHash('md5').update(Buffer.from(password,'utf8')).digest();}
export function verifyLegacyMd5(password,stored) {
  if(!Buffer.isBuffer(stored)||stored.length!==16)return false;
  return timingSafeEqual(legacyMd5(password),stored);
}

// The login profile's name field is 16 bytes of the client's own ANSI codepage, so a Chinese
// nickname has to be written as GBK rather than UTF-8. Node can decode that codepage but cannot
// encode it, so the encoder is built once by inverting the decoder over the GB2312 lead/trail
// space; a character outside it is refused instead of being written as a wrong byte.
let gbkTable=null;
function gbkReverse() {
  if(gbkTable)return gbkTable;
  const decoder=new TextDecoder('gbk',{fatal:true});
  gbkTable=new Map();
  for(let lead=0xb0;lead<=0xf7;lead++) {
    for(let trail=0xa1;trail<=0xfe;trail++) {
      try {
        const text=decoder.decode(Uint8Array.of(lead,trail));
        if(text.length===1&&!gbkTable.has(text))gbkTable.set(text,lead*256+trail);
      } catch {}
    }
  }
  return gbkTable;
}
export function gbkByteLength(text) {
  const table=gbkReverse();
  let length=0;
  for(const character of text) {
    const code=character.codePointAt(0);
    if(code>=0x20&&code<=0x7e){length+=1;continue;}
    if(!table.has(character))throw new AccountError('NICKNAME_NOT_ENCODABLE','昵称包含客户端字符集之外的字符');
    length+=2;
  }
  return length;
}
export function gbkEncode(text) {
  const table=gbkReverse();
  const bytes=[];
  for(const character of text) {
    const code=character.codePointAt(0);
    if(code>=0x20&&code<=0x7e){bytes.push(code);continue;}
    const encoded=table.get(character);
    if(encoded===undefined)throw new AccountError('NICKNAME_NOT_ENCODABLE','昵称包含客户端字符集之外的字符');
    bytes.push(encoded>>8,encoded&0xff);
  }
  return Buffer.from(bytes);
}

// Both user and pet names reach the original client's character set. Their
// validation is shared; their persistent fields and display roles are separate.
export function validateClientNickname(value) {
  if(typeof value!=='string')throw new AccountError('INVALID_NICKNAME','昵称不能为空');
  const name=value.trim().normalize('NFC');
  if(name.length===0)throw new AccountError('INVALID_NICKNAME','昵称不能为空');
  if(/[\u0000-\u001f\u007f]/.test(name))throw new AccountError('INVALID_NICKNAME','昵称不能包含控制字符');
  const length=gbkByteLength(name);
  if(length===0||length>15)throw new AccountError('INVALID_NICKNAME','昵称过长，最多 15 字节');
  return name;
}

const SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS account_birthday_v1 (
  uin INTEGER PRIMARY KEY REFERENCES account(uin) ON DELETE CASCADE,
  birthday TEXT NOT NULL CHECK(length(birthday)=5)) STRICT;
CREATE TABLE IF NOT EXISTS account_login_v1 (
  uin INTEGER PRIMARY KEY REFERENCES account(uin) ON DELETE CASCADE,
  login_name TEXT NOT NULL UNIQUE CHECK(length(login_name) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS account_credential_v1 (
  uin INTEGER PRIMARY KEY REFERENCES account(uin) ON DELETE CASCADE,
  algo TEXT NOT NULL CHECK(length(algo) BETWEEN 1 AND 32),
  salt BLOB NOT NULL CHECK(length(salt) = 16),
  cost INTEGER NOT NULL CHECK(cost BETWEEN 1024 AND 1048576),
  block INTEGER NOT NULL CHECK(block BETWEEN 1 AND 64),
  parallel INTEGER NOT NULL CHECK(parallel BETWEEN 1 AND 16),
  digest BLOB NOT NULL CHECK(length(digest) = 32),
  updated_at INTEGER NOT NULL,
  legacy_md5 INTEGER NOT NULL CHECK(legacy_md5 IN (0,1))) STRICT;
CREATE TABLE IF NOT EXISTS account_state_v1 (
  uin INTEGER PRIMARY KEY REFERENCES account(uin) ON DELETE CASCADE,
  disabled INTEGER NOT NULL CHECK(disabled IN (0,1)),
  admin INTEGER NOT NULL CHECK(admin IN (0,1)),
  updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS account_session_v1 (
  token_hash BLOB PRIMARY KEY CHECK(length(token_hash) = 32),
  uin INTEGER NOT NULL REFERENCES account(uin) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('user','admin')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
  csrf_hash BLOB NOT NULL CHECK(length(csrf_hash) = 32)) STRICT;
CREATE TABLE IF NOT EXISTS account_audit_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_uin INTEGER,
  actor_scope TEXT NOT NULL CHECK(length(actor_scope) BETWEEN 1 AND 16),
  action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 32),
  target_uin INTEGER,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json))) STRICT;
CREATE TABLE IF NOT EXISTS account_sequence_v1 (
  name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 32),
  value INTEGER NOT NULL CHECK(value > 0)) STRICT;
CREATE TABLE IF NOT EXISTS pet_adoption_v1 (
  request_key TEXT PRIMARY KEY CHECK(length(request_key) = 64),
  uin INTEGER NOT NULL REFERENCES account(uin) ON DELETE CASCADE,
  content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
  pet_id TEXT NOT NULL,
  created_at INTEGER NOT NULL) STRICT;
`;

// The tables the constructor above creates, read off the schema itself rather than repeated, so a
// tool can ask "would constructing AccountService write anything into this database?" — it would
// exactly when one of these is missing — instead of finding out by creating them.
export const ACCOUNT_SERVICE_TABLES=Object.freeze(
  [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gu)].map((match)=>match[1]));

export class AccountService {
  #tokens=new Map();
  constructor({database,clock=Date.now,randomBytes=systemRandomBytes,firstRegistrationAdmin=false}={}) {
    if(!database?.prepare||typeof clock!=='function'||typeof randomBytes!=='function'||typeof firstRegistrationAdmin!=='boolean')
      throw new TypeError('INVALID_ACCOUNT_SERVICE');
    this.database=database;this.clock=clock;this.randomBytes=randomBytes;
    this.firstRegistrationAdmin=firstRegistrationAdmin;
    database.exec(SCHEMA_SQL);
  }
  #now() {
    const value=this.clock();
    if(!Number.isSafeInteger(value)||value<0)throw new AccountError('INVALID_CLOCK','the clock is not a usable time');
    return value;
  }
  // One atomic boundary either way: a step that is already inside a caller's transaction joins
  // it instead of opening a nested one, so composing two steps cannot half-commit.
  #tx(operation) {
    if(this.database.isTransaction===true)return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {const result=operation();this.database.exec('COMMIT');return result;}
    catch(error){try{this.database.exec('ROLLBACK');}catch{}throw error;}
  }
  runTransaction(operation) {return this.#tx(operation);}
  nextSequence(name) {
    const key=requireText(name,'sequence',{max:32});
    const row=this.database.prepare('SELECT value FROM account_sequence_v1 WHERE name=?').get(key);
    const next=row?row.value:1;
    this.database.prepare('INSERT INTO account_sequence_v1(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
      .run(key,next+1);
    return next;
  }
  audit({actorUin=null,actorScope='local',action,targetUin=null,detail={}}) {
    // Only internal ids and the operation itself: no password, digest, ticket or session value
    // ever reaches this row.
    this.database.prepare('INSERT INTO account_audit_v1(at,actor_uin,actor_scope,action,target_uin,detail_json) VALUES(?,?,?,?,?,?)')
      .run(this.#now(),actorUin,actorScope,requireText(action,'action',{max:32}),targetUin,JSON.stringify(detail));
  }
  // A save written before naming existed has no account_login_v1 row, so the account is
  // addressed by its own number: that is the only name it has ever had, it cannot collide with
  // a chosen name (chosen names are reserved to accounts that have a row), and it is what the
  // login form already shows for such an account.
  findByLoginName(loginName) {
    const name=normalizeLoginName(loginName);
    const row=this.database.prepare(`SELECT l.uin,l.login_name,s.disabled,s.admin
      FROM account_login_v1 l LEFT JOIN account_state_v1 s USING(uin) WHERE l.login_name=?`).get(name);
    if(row)return {uin:row.uin,loginName:row.login_name,disabled:Boolean(row.disabled),admin:Boolean(row.admin),chosenName:true};
    const legacy=this.database.prepare(`SELECT a.uin,s.disabled,s.admin
      FROM account a LEFT JOIN account_state_v1 s USING(uin)
      WHERE CAST(a.uin AS TEXT)=? AND NOT EXISTS(SELECT 1 FROM account_login_v1 l WHERE l.uin=a.uin)`).get(name);
    return legacy?{uin:legacy.uin,loginName:name,disabled:Boolean(legacy.disabled),admin:Boolean(legacy.admin),chosenName:false}:null;
  }
  // A SQLite BLOB arrives as a Uint8Array, not a Buffer, so the legacy digest has to be
  // normalised before it can be compared at all.
  static #bytes(value) {
    if(value===null||value===undefined)return null;
    return Buffer.isBuffer(value)?value:Buffer.from(value);
  }
  state(uin) {
    const row=this.database.prepare('SELECT disabled,admin FROM account_state_v1 WHERE uin=?').get(uin);
    return {disabled:Boolean(row?.disabled),admin:Boolean(row?.admin)};
  }
  // Registration is one transaction: the account row, its login name, its credential and its
  // state are written together, so a failure cannot leave an account that can be named but
  // not authenticated. No pet, no inventory and no balance is created here.
  register({loginName,nickname,password,confirm,birthday,at=this.#now()}={}) {
    const {loginName:name,uin}=registrationIdentity(loginName);
    validatePassword(password,confirm);
    // Existing local tool callers omit nickname. The registration page supplies
    // it explicitly, so an empty submitted value cannot fall back to a number.
    const userNickname=nickname===undefined?name:validateClientNickname(nickname);
    let birthdayValue;
    try{birthdayValue=annualBirthday(birthday);}catch{throw new AccountError('INVALID_BIRTHDAY','生日请填写有效的月日，例如 05-12，也可以留空');}
    return this.#tx(()=>{
      if(this.database.prepare('SELECT 1 FROM account_login_v1 WHERE login_name=?').get(name))
        throw new AccountError('LOGIN_NAME_TAKEN','这个账号已经被注册');
      if(this.database.prepare('SELECT 1 FROM account WHERE uin=?').get(uin))
        throw new AccountError('ACCOUNT_NUMBER_UNAVAILABLE','此号码不可用，请选择其它号码');
      // Check while holding the same write transaction as registration. Only an empty save
      // qualifies: a missing/disabled administrator in an existing save must not grant access.
      const admin=this.firstRegistrationAdmin&&!this.database.prepare('SELECT 1 FROM account LIMIT 1').get();
      this.database.prepare('INSERT INTO account(uin,qq_name,extra_json) VALUES(?,?,?)').run(uin,userNickname,'{}');
      if(birthdayValue)this.database.prepare('INSERT INTO account_birthday_v1 VALUES(?,?)').run(uin,birthdayValue);
      this.database.prepare('INSERT INTO account_login_v1(uin,login_name,created_at) VALUES(?,?,?)').run(uin,name,at);
      const credential=hashCredential(password);
      this.database.prepare(`INSERT INTO account_credential_v1(uin,algo,salt,cost,block,parallel,digest,updated_at,legacy_md5)
        VALUES(?,?,?,?,?,?,?,?,0)`).run(uin,credential.algo,credential.salt,credential.cost,credential.block,
        credential.parallel,credential.digest,at);
      this.database.prepare('INSERT INTO account_state_v1(uin,disabled,admin,updated_at) VALUES(?,0,?,?)').run(uin,Number(admin),at);
      this.audit({action:'account-register',targetUin:uin,detail:{source:'registration'}});
      if(admin)this.audit({action:'admin-initialize',targetUin:uin,detail:{source:'first-registration'}});
      return Object.freeze({uin,loginName:name});
    });
  }
  // Returns the authenticated uin or null. A save that predates the salted scheme is opened
  // with its old value and rewritten in place, marked as migrated; the plain text is never
  // stored and the old digest is never claimed to be reversible.
  authenticate({loginName,password}={}) {
    const account=this.findByLoginName(loginName);
    if(!account)return null;
    if(account.disabled)throw new AccountError('ACCOUNT_DISABLED','这个账号已被停用');
    const credential=this.database.prepare('SELECT * FROM account_credential_v1 WHERE uin=?').get(account.uin);
    if(credential) {
      // A salted credential exists, so it is the only verifier: the old digest must not remain
      // usable as a second way in, whether the row was written by registration or by a reset.
      if(!verifyCredential(password,credential))return null;
      return Object.freeze({uin:account.uin,loginName:account.loginName,admin:account.admin});
    }
    const legacy=this.database.prepare('SELECT password_md5 FROM account_auth WHERE uin=?').get(account.uin);
    const storedMd5=AccountService.#bytes(legacy?.password_md5);
    if(!legacy||!verifyLegacyMd5(password,storedMd5))return null;
    return this.#tx(()=>{
      const updated=hashCredential(password);
      this.database.prepare(`INSERT INTO account_credential_v1(uin,algo,salt,cost,block,parallel,digest,updated_at,legacy_md5)
        VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(uin) DO UPDATE SET algo=excluded.algo,salt=excluded.salt,cost=excluded.cost,
        block=excluded.block,parallel=excluded.parallel,digest=excluded.digest,updated_at=excluded.updated_at,legacy_md5=1`)
        .run(account.uin,updated.algo,updated.salt,updated.cost,updated.block,updated.parallel,updated.digest,this.#now());
      this.database.prepare('INSERT INTO account_state_v1(uin,disabled,admin,updated_at) VALUES(?,0,0,?) ON CONFLICT(uin) DO NOTHING')
        .run(account.uin,this.#now());
      this.audit({action:'credential-migrate',targetUin:account.uin,detail:{from:'legacy-md5',to:CREDENTIAL_ALGO}});
      return Object.freeze({uin:account.uin,loginName:account.loginName,admin:this.state(account.uin).admin,migrated:true});
    });
  }
  setCredential({uin,password,confirm,actorUin=null,actorScope='admin'}) {
    validatePassword(password,confirm);
    return this.#tx(()=>{
      if(!this.database.prepare('SELECT 1 FROM account WHERE uin=?').get(uin))throw new AccountError('ACCOUNT_NOT_FOUND','账号不存在');
      const credential=hashCredential(password);
      this.database.prepare(`INSERT INTO account_credential_v1(uin,algo,salt,cost,block,parallel,digest,updated_at,legacy_md5)
        VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(uin) DO UPDATE SET algo=excluded.algo,salt=excluded.salt,cost=excluded.cost,
        block=excluded.block,parallel=excluded.parallel,digest=excluded.digest,updated_at=excluded.updated_at,legacy_md5=0`)
        .run(uin,credential.algo,credential.salt,credential.cost,credential.block,credential.parallel,credential.digest,this.#now());
      // A credential reset invalidates every session that could still act as this account.
      const revoked=this.revokeForUin(uin);
      this.audit({actorUin,actorScope,action:'credential-reset',targetUin:uin,detail:{revokedSessions:revoked}});
      return Object.freeze({uin,revokedSessions:revoked});
    });
  }
  initializeFirstAdmin({loginName,password,confirm}={}) {
    // Explicit local initialisation: the first admin is created by name here, never by the
    // first visitor to the registration page, and there is no shared default credential.
    return this.#tx(()=>{
      if(this.database.prepare('SELECT count(*) AS n FROM account_state_v1 WHERE admin=1').get().n>0)
        throw new AccountError('ADMIN_ALREADY_INITIALIZED','管理员已经初始化');
      const existing=this.findByLoginName(loginName);
      const account=existing??this.register({loginName,password,confirm});
      this.database.prepare('INSERT INTO account_state_v1(uin,disabled,admin,updated_at) VALUES(?,0,1,?) ON CONFLICT(uin) DO UPDATE SET admin=1')
        .run(account.uin,this.#now());
      if(existing)this.setCredential({uin:account.uin,password,confirm,actorScope:'local-init'});
      this.audit({action:'admin-initialize',targetUin:account.uin,detail:{}});
      return Object.freeze({uin:account.uin,loginName:account.loginName});
    });
  }
  // The name an account is addressed by: its chosen name, or its own number when it predates
  // naming.
  #loginNameOf(uin) {
    const row=this.database.prepare('SELECT login_name FROM account_login_v1 WHERE uin=?').get(uin);
    return row?row.login_name:String(uin);
  }
  countAdmins() {return this.database.prepare('SELECT count(*) AS n FROM account_state_v1 WHERE admin=1').get().n;}

  createSession({uin=null,loginName=null,scope,password}={}) {
    if(!['user','admin'].includes(scope))throw new AccountError('INVALID_SCOPE','会话范围无效');
    // An administrator session always requires the password: it cannot be minted from a bare
    // internal id, and the password is verified against the same service that logs people in.
    if(scope==='admin') {
      if(typeof password!=='string'||password.length===0)throw new AccountError('PASSWORD_REQUIRED','管理员登录需要密码');
      const name=loginName??(uin===null?null:this.#loginNameOf(uin));
      const authenticated=name===null?null:this.authenticate({loginName:name,password});
      if(!authenticated)throw new AccountError('AUTHENTICATION_FAILED','账号或密码不正确');
      uin=authenticated.uin;
    } else if(!Number.isInteger(uin)||uin<=0)throw new AccountError('ACCOUNT_REQUIRED','请指定账号');
    const state=this.state(uin);
    if(state.disabled)throw new AccountError('ACCOUNT_DISABLED','这个账号已被停用');
    if(scope==='admin'&&!state.admin)throw new AccountError('ADMIN_REQUIRED','该账号没有管理权限');
    const token=this.randomBytes(32),csrf=this.randomBytes(32),now=this.#now();
    const ttl=scope==='admin'?ADMIN_SESSION_TTL_MS:SESSION_TTL_MS;
    this.database.prepare('INSERT INTO account_session_v1(token_hash,uin,scope,created_at,expires_at,revoked,csrf_hash) VALUES(?,?,?,?,?,0,?)')
      .run(sha256(token),uin,scope,now,now+ttl,sha256(csrf));
    this.#tokens.set(sha256(token).toString('hex'),{uin,scope,expiresAt:now+ttl,csrf});
    return Object.freeze({token,csrf,scope,expiresAt:now+ttl,uin});
  }
  resolveSession(token,{scope}={}) {
    if(!Buffer.isBuffer(token)||token.length!==32)return null;
    const row=this.database.prepare('SELECT * FROM account_session_v1 WHERE token_hash=?').get(sha256(token));
    if(!row||row.revoked||row.expires_at<=this.#now())return null;
    if(scope&&row.scope!==scope)return null;
    const state=this.state(row.uin);
    if(state.disabled)return null;
    if(row.scope==='admin'&&!state.admin)return null;
    // The token is part of the resolved session so a caller can revoke exactly this session:
    // without it a logout had no handle to revoke and silently did nothing.
    return Object.freeze({token:Buffer.from(token),uin:row.uin,scope:row.scope,expiresAt:row.expires_at,
      csrfHash:Buffer.from(row.csrf_hash)});
  }
  verifyCsrf(session,token) {
    if(!session||!Buffer.isBuffer(token)||token.length!==32)return false;
    return timingSafeEqual(sha256(token),session.csrfHash);
  }
  revokeSession(token) {
    if(!Buffer.isBuffer(token)||token.length!==32)return 0;
    const result=this.database.prepare('UPDATE account_session_v1 SET revoked=1 WHERE token_hash=? AND revoked=0').run(sha256(token));
    this.#tokens.delete(sha256(token).toString('hex'));
    return result.changes;
  }
  revokeForUin(uin) {
    const rows=this.database.prepare('SELECT token_hash FROM account_session_v1 WHERE uin=? AND revoked=0').all(uin);
    for(const row of rows)this.#tokens.delete(Buffer.from(row.token_hash).toString('hex'));
    return this.database.prepare('UPDATE account_session_v1 SET revoked=1 WHERE uin=? AND revoked=0').run(uin).changes;
  }
  expireSessions() {
    return this.database.prepare('UPDATE account_session_v1 SET revoked=1 WHERE revoked=0 AND expires_at<=?').run(this.#now()).changes;
  }
  searchAccounts({query='',limit=50}={}) {
    const text=String(query??'').trim();
    const bounded=Math.min(Math.max(Number(limit)||50,1),200);
    // Parameters only: the search text is never concatenated into the statement.
    const rows=text.length===0
      ? this.database.prepare(`SELECT l.uin,l.login_name,a.qq_name,s.disabled,s.admin,
          (SELECT count(*) FROM pet p WHERE p.uin=l.uin) AS pets
          FROM account_login_v1 l JOIN account a USING(uin) LEFT JOIN account_state_v1 s USING(uin) ORDER BY l.uin LIMIT ?`).all(bounded)
      : this.database.prepare(`SELECT l.uin,l.login_name,a.qq_name,s.disabled,s.admin,
          (SELECT count(*) FROM pet p WHERE p.uin=l.uin) AS pets
          FROM account_login_v1 l JOIN account a USING(uin) LEFT JOIN account_state_v1 s USING(uin)
          WHERE l.login_name LIKE ? OR a.qq_name LIKE ? ORDER BY l.uin LIMIT ?`).all(`%${text}%`,`%${text}%`,bounded);
    return rows.map((row)=>Object.freeze({uin:row.uin,loginName:row.login_name,
      nickname:row.qq_name,disabled:Boolean(row.disabled),admin:Boolean(row.admin),pets:row.pets}));
  }
}

// The declared local starting values of a first adoption: level 1, full care for that level,
// full mood, full health and no currency. They are the build's own values, never a copy of an
// existing pet's state. The growth value is the lower bound of the level-1 band, because the
// vitals invariant requires growthStart(level) <= growth < growthStart(level+1); it is derived
// from that curve below rather than written as a number that could drift away from it.
const FIRST_ADOPTION_LEVEL=1;
const FIRST_ADOPTION=Object.freeze({
  level:FIRST_ADOPTION_LEVEL,
  growth:growthStart(FIRST_ADOPTION_LEVEL),
  hunger:careMaximum(FIRST_ADOPTION_LEVEL),
  cleanliness:careMaximum(FIRST_ADOPTION_LEVEL),
  mood:1000,
  health:5,
});

// The pet-owner marker: which word of the 64-bit pet id names the pet's own identity, and where
// it has to sit.
//
// An earlier version of this comment claimed the two locked consumers read the *high* word
// (bits 48..63) and placed the marker there. Instruction-level evidence from the authoritative
// modules refutes that, and the correction matters because both readers are 16-bit loads of
// bytes 4..5 of the little-endian id, i.e. bits 32..47:
//
//   PhaseLogic_20100611_150521.dll RVA 0x1491/0x1497 zero eight bytes, then RVA 0x14B6
//   `0F B7 44 24 14` = `movzx eax, word ptr [esp+14h]` loads bytes 4..5 with no shift and no
//   mask; that value is stored at plugin+0x7C and the class is `{100|110|120} + (value % 10)`.
//   QQStartParamParser_20100913_200520.dll RVA 0x4676 `66 83 7C 24 20 66` compares the same
//   word against 102 to produce DCN_INT_PETGENDER, and PetLogin_20160519_181721.dll RVA 0x234A
//   `66 83 FB 66` reproduces it independently.
//
// The resource set corroborates the placement without relying on those reads: the action tables
// that exist are 102/103/112/113/122/123, and `102 << 32` selects 112/122/102 while
// `103 << 32` selects 113/123/103 - all six present. `102 << 48` selects 110/120/100, none of
// which exists anywhere in Config.xml or res/Action.
export const PET_ID_GENDER_HIGH_WORD=Object.freeze({male:102n,female:103n});
// The marker occupies bits 32..47; the sequence keeps the low 32 bits and may not reach it.
const PET_ID_MARKER_SHIFT=32n;
const PET_ID_SEQUENCE_MASK=0xffffffffn;
export function createLocalPetId({gender,sequence}) {
  const highWord=gender==='male'?PET_ID_GENDER_HIGH_WORD.male:PET_ID_GENDER_HIGH_WORD.female;
  if(!Number.isInteger(sequence)||sequence<1||sequence>0xffffffff||sequence>0xffffffff)
    throw new AccountError('INVALID_PET_SEQUENCE','the local pet sequence is out of range');
  const id=(highWord<<PET_ID_MARKER_SHIFT)|(BigInt(sequence)&PET_ID_SEQUENCE_MASK);
  if(id<=0n||id>0xffffffffffffffffn)throw new AccountError('INVALID_PET_ID','the local pet id is out of range');
  return id.toString(10);
}

// The first adoption. It is one transaction: the pet row, the Login/Hello profile row, the
// account-to-pet link and the adoption receipt are written together, so a failure leaves the
// account exactly as petless as it was. A repeat of the same request returns the same pet; a
// repeat with different content is refused instead of minting a second one.
export function adoptionRequestKey(uin,adoptionId) {
  return createHash('sha256').update(`qqpet-local-adoption-v1\0${uin}\0${adoptionId}`).digest('hex');
}
export function adoptionContentHash({gender,nickname}) {
  return createHash('sha256').update(JSON.stringify({gender,nickname})).digest('hex');
}

export class PetProvisioning {
  constructor({accounts,store,clock=Date.now,careEconomy=null}={}) {
    if(!(accounts instanceof AccountService)||!store?.database||accounts.database!==store.database)
      throw new TypeError('INVALID_PROVISIONING');
    this.accounts=accounts;this.store=store;this.clock=clock;
    this.database=store.database;
    if(careEconomy&&careEconomy.database!==this.database)throw new TypeError('INVALID_PROVISIONING_CARE');
    this.careEconomy=careEconomy;
  }
  petsOf(uin) {
    return this.database.prepare(`SELECT p.pet_id,p.pet_name,p.master_name,p.level,p.growth,p.age_hours,
      q.pet_name_bytes,q.level_value,p.sex FROM pet p LEFT JOIN qqpenguin_login_profile q USING(pet_id)
      WHERE p.uin=? ORDER BY p.pet_id`).all(uin);
  }
  // The nickname contract is the client's own: the login profile carries 16 bytes of GB18030,
  // so a Chinese name is legal here and the old ASCII-only local limit is not inherited.
  static validateNickname(value) {
    return validateClientNickname(value);
  }
  adopt({uin,gender,nickname,adoptionId,now=this.clock()}={}) {
    if(gender!=='male'&&gender!=='female')throw new AccountError('INVALID_GENDER','请选择性别');
    const name=PetProvisioning.validateNickname(nickname);
    // An explicit request id makes a replayed submission idempotent. Without one the content
    // itself is the key, so a double submit of the same form still returns the same pet while a
    // different form cannot quietly create a second one.
    const contentHash=adoptionContentHash({gender,nickname:name});
    if(adoptionId!==undefined&&adoptionId!==null
        &&(typeof adoptionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(adoptionId)))
      throw new AccountError('INVALID_ADOPTION_ID','领养请求标识无效');
    const requestKey=adoptionRequestKey(uin,adoptionId??`content:${contentHash}`);
    return this.accounts.runTransaction(()=>{
      const receipt=this.database.prepare('SELECT * FROM pet_adoption_v1 WHERE request_key=?').get(requestKey);
      if(receipt) {
        if(receipt.content_hash!==contentHash||receipt.uin!==uin)
          throw new AccountError('ADOPTION_RETRY_CONFLICT','同一次领养请求不能改变内容');
        return Object.freeze({uin,petId:receipt.pet_id,replayed:true});
      }
      if(this.petsOf(uin).length>0)throw new AccountError('PET_ALREADY_ADOPTED','这个账号已经有宠物了');
      const sequence=this.accounts.nextSequence('pet');
      const petId=createLocalPetId({gender,sequence});
      const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(petId));
      const encoded=gbkEncode(name);
      if(encoded.length>15)throw new AccountError('INVALID_NICKNAME','昵称过长，最多 15 字节');
      const petName=Buffer.alloc(16);encoded.copy(petName);
      const masterTitle='主人',masterName=Buffer.alloc(16);gbkEncode(masterTitle).copy(masterName);
      const empty=Buffer.alloc(16);
      this.database.prepare(`INSERT INTO pet(pet_id,uin,pet_name,master_name,birthday,level,age_hours,growth,
        generation,sex,vip_level,vip_year_flag,current_title,extra_json)
        VALUES(?,?,?,?,?,?,0,?,NULL,?,0,0,NULL,'{}')`)
        .run(petId,uin,name,masterTitle,beijingDate(now),FIRST_ADOPTION.level,FIRST_ADOPTION.growth,gender);
      this.database.prepare(`INSERT INTO qqpenguin_login_profile(pet_id,pet_id_bytes,pet_name_bytes,master_name_bytes,
        auto_feed_flag,vip_flag,status_id,status_description_bytes,status_time,level_value,unknown_0x3f,unknown_0x43,
        unknown_0x47,unknown_0x49,unknown_0x4b,unknown_0x4d,unknown_0x4e,bubble_id,vehicle_id,decoration_stamp,
        config_version,avatar_version,use_phase_flag,unknown_0x61,unknown_0x65,unknown_0x66,unknown_0x67,unknown_0x6b,
        hello_interval,hello_unknown_0x1b,extra_json)
        VALUES(?,?,?,?,0,0,0,?,0,?,0,0,?,?,?,?,?,0,0,0,0,0,0,?,0,0,300,0,1,0,'{}')`)
        .run(petId,bytes,petName,masterName,empty,FIRST_ADOPTION.level,FIRST_ADOPTION.hunger,
          FIRST_ADOPTION.cleanliness,FIRST_ADOPTION.health,LOCAL_NORMAL_PET_SIZE_VALUE,
          FIRST_ADOPTION.mood,FIRST_ADOPTION.growth);
      if(this.careEconomy?.policy.id==='local-care-economy-v4'){
        const pill=[...this.careEconomy.items.values()].find(i=>i.medicineFor==='revive');
        if(!pill)throw new Error('BIRTH_REVIVAL_ITEM_MISSING');
        this.careEconomy.membership?.initialize(uin,bytes);
        this.careEconomy.initialize(uin,bytes);this.careEconomy.grant(uin,bytes,[{cid:pill.cid,count:1}]);
      }
      this.database.prepare('INSERT INTO pet_adoption_v1(request_key,uin,content_hash,pet_id,created_at) VALUES(?,?,?,?,?)')
        .run(requestKey,uin,contentHash,petId,now);
      this.accounts.audit({actorUin:uin,actorScope:'user',action:'pet-adopt',targetUin:uin,
        detail:{sex:gender,adoption:adoptionId}});
      return Object.freeze({uin,petId,replayed:false});
    });
  }
}
