import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,statSync} from 'node:fs';
import path from 'node:path';
import {AccountError,validateClientNickname} from './account-service.js';
import {growthStart,careMaximum} from '../original-data/online-pet-state.js';
import {validateCareEconomyPolicy,policyDigest,declaredPath} from '../original-data/pet-care-economy.js';

// The administrator operations that act on data the account service does not own: the account's
// disabled flag, a pet's wallet, and the local price of a catalogue item.
//
// Prices are kept as an override beside the catalogue rather than written into it. The catalogue
// is a locked reference definition whose digest a save is pinned to; editing it to change a price
// would invalidate every existing save and force a migration for what is only a local selling
// decision. An override is auditable on its own, and the catalogue stays the reference.

const MAX_YUANBAO = 0x7fffffff;
export const MAX_TEST_PET_LEVEL = 100;

export class AccountAdmin {
  isOnline(uin){return [...(this.sessions?.connections??[])].some(([socket,c])=>!socket.destroyed&&socket.writable&&!c.closed&&!c.logoutCount&&c.sessionKey&&c.profile&&c.authenticatedUin===uin);}
  setUserNickname({uin,nickname,actorUin,reason=''}){
    const name=validateClientNickname(nickname);
    return this.accounts.runTransaction(()=>{
      const row=this.database.prepare('SELECT qq_name FROM account WHERE uin=?').get(uin);if(!row)throw new AccountError('ACCOUNT_REQUIRED','账号不存在');
      this.database.prepare('UPDATE account SET qq_name=? WHERE uin=?').run(name,uin);
      this.accounts.audit({actorUin,actorScope:'admin',action:'user-nickname-set',targetUin:uin,detail:{changed:row.qq_name!==name,reason:String(reason).slice(0,80)}});
      return name;
    });
  }
  constructor({accounts, database, clock = Date.now, tickets = null, sessions = null,
      adoptionHandles = null} = {}) {
    if (typeof accounts?.audit !== 'function' || accounts.database !== database)
      throw new TypeError('INVALID_ACCOUNT_ADMIN');
    this.accounts = accounts;
    this.database = database;
    this.clock = clock;
    // The ticket issuer and the live game connections are what an outstanding credential still
    // reaches, so a disable has to close them too, not only the account row.
    if (tickets !== null && typeof tickets.revokeUin !== 'function') throw new TypeError('INVALID_TICKET_REVOCATION');
    if (sessions !== null && typeof sessions.closeUin !== 'function') throw new TypeError('INVALID_SESSION_CLOSURE');
    if (adoptionHandles !== null && typeof adoptionHandles.revokeAdoptionTokens !== 'function')
      throw new TypeError('INVALID_ADOPTION_REVOCATION');
    this.tickets = tickets; this.sessions = sessions; this.adoptionHandles = adoptionHandles;
    // The account state table is the account service's; this only writes the flag and the audit.
    if (!database.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get('account_state_v1'))
      throw new TypeError('ACCOUNT_STATE_TABLE_MISSING');
  }
  #now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new AccountError('INVALID_CLOCK', '时钟不可用');
    return value;
  }
  setDisabled({uin, disabled, actorUin = null, reason = ''} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    if (typeof disabled !== 'boolean') throw new AccountError('INVALID_DISABLED', '停用状态无效');
    return this.accounts.runTransaction(() => {
      const row = this.database.prepare('SELECT disabled FROM account_state_v1 WHERE uin=?').get(uin);
      if (!row) throw new AccountError('ACCOUNT_NOT_FOUND', '账号不存在');
      const before = Boolean(row.disabled);
      if (before === disabled) return Object.freeze({uin, before, after: before, revokedSessions: 0});
      this.database.prepare('UPDATE account_state_v1 SET disabled=?,updated_at=? WHERE uin=?')
        .run(disabled ? 1 : 0, this.#now(), uin);
      // Disabling takes effect on the live entry points immediately: every session of that account
      // stops resolving, including an administrator's own.
      const revoked = disabled ? this.accounts.revokeForUin(uin) : 0;
      const tickets = disabled && this.tickets ? this.tickets.revokeUin(uin) : 0;
      const closed = disabled && this.sessions ? this.sessions.closeUin(uin) : 0;
      const handles = disabled && this.adoptionHandles ? this.adoptionHandles.revokeAdoptionTokens(uin) : 0;
      this.accounts.audit({actorUin, actorScope: 'admin', action: disabled ? 'account-disable' : 'account-enable',
        targetUin: uin, detail: {before, after: disabled, revokedSessions: revoked, revokedTickets: tickets,
          closedChannels: closed, revokedAdoptionHandles: handles, reason: String(reason).slice(0, 80)}});
      return Object.freeze({uin, before, after: disabled, revokedSessions: revoked, revokedTickets: tickets,
        closedChannels: closed, revokedAdoptionHandles: handles});
    });
  }
  // A credential reset has the same live reach a disable has. The service rewrites the row and
  // revokes this account's web sessions in one transaction; the outstanding tickets and the
  // already-open game channels the old credential still reaches are closed by the same
  // coordination, so a reset cannot leave a ticket or a Root that predates it still working.
  // Other accounts keep their tickets, sessions and channels: the revocation is per uin.
  resetCredential({uin, password, confirm, actorUin = null, reason = ''} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    return this.accounts.runTransaction(() => {
      const result = this.accounts.setCredential({uin, password, confirm, actorUin});
      const tickets = this.tickets ? this.tickets.revokeUin(uin) : 0;
      const closed = this.sessions ? this.sessions.closeUin(uin) : 0;
      const handles = this.adoptionHandles ? this.adoptionHandles.revokeAdoptionTokens(uin) : 0;
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'credential-reset-revoke',
        targetUin: uin, detail: {revokedTickets: tickets, closedChannels: closed, revokedAdoptionHandles: handles,
          reason: String(reason).slice(0, 80)}});
      return Object.freeze({...result, revokedTickets: tickets, closedChannels: closed, revokedAdoptionHandles: handles});
    });
  }
  // The wallet lives in the login profile, keyed by the pet the account owns. Both the before and
  // after values are read and written inside one transaction, and the audit records both.
  adjustYuanbao({uin, amount, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000)
      throw new AccountError('INVALID_AMOUNT', '请输入 -1000000 到 1000000 之间的整数增减量');
    return this.accounts.runTransaction(() => {
      const pets = this.database.prepare('SELECT pet_id,unknown_0x67 AS yuanbao FROM qqpenguin_login_profile WHERE pet_id IN (SELECT pet_id FROM pet WHERE uin=?)').all(uin);
      if (pets.length === 0) throw new AccountError('ACCOUNT_WITHOUT_PET', '这个账号还没有宠物，没有可调整的钱包');
      if (pets.length > 1) throw new AccountError('ACCOUNT_MULTIPLE_PETS', '这个账号有多只宠物，无法确定要调整哪一个');
      const before = pets[0].yuanbao;
      const after = before + amount;
      if (!Number.isSafeInteger(after) || after < 0 || after > MAX_YUANBAO)
        throw new AccountError('YUANBAO_OUT_OF_RANGE', '调整后的元宝超出可表示范围');
      this.database.prepare('UPDATE qqpenguin_login_profile SET unknown_0x67=? WHERE pet_id=?').run(after, pets[0].pet_id);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'yuanbao-adjust', targetUin: uin,
        detail: {before, after, amount, reason: String(reason).slice(0, 80)}});
      return Object.freeze({uin, petId: pets[0].pet_id, before, after});
    });
  }
  // Operator-only test state. Growth must sit inside the chosen level's interval,
  // and both durable mirrors must agree before the next Login/Hello projection.
  setPetLevel({uin, level, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    if (!Number.isInteger(level) || level < 0 || level > MAX_TEST_PET_LEVEL)
      throw new AccountError('INVALID_PET_LEVEL', `请输入 0 到 ${MAX_TEST_PET_LEVEL} 之间的整数等级`);
    return this.accounts.runTransaction(() => {
      const pets = this.database.prepare(`SELECT p.pet_id,p.level AS petLevel,p.growth AS petGrowth,
        q.level_value AS level,q.unknown_0x61 AS growth,q.unknown_0x47 AS hunger,q.unknown_0x49 AS cleanliness
        FROM pet p LEFT JOIN qqpenguin_login_profile q USING(pet_id) WHERE p.uin=?`).all(uin);
      if (pets.length === 0) throw new AccountError('ACCOUNT_WITHOUT_PET', '这个账号还没有宠物');
      if (pets.length > 1) throw new AccountError('ACCOUNT_MULTIPLE_PETS', '这个账号有多只宠物，无法确定要操作哪一只');
      if (pets[0].level === null) throw new AccountError('PET_PROFILE_MISSING', '宠物资料缺失，无法修改等级');
      const {pet_id: petId, ...before} = pets[0];
      const after = {level, growth: growthStart(level), hunger: Math.min(before.hunger, careMaximum(level)),
        cleanliness: Math.min(before.cleanliness, careMaximum(level))};
      this.database.prepare(`UPDATE qqpenguin_login_profile SET level_value=?,unknown_0x61=?,unknown_0x47=?,unknown_0x49=?
        WHERE pet_id=?`).run(after.level,after.growth,after.hunger,after.cleanliness,petId);
      this.database.prepare('UPDATE pet SET level=?,growth=? WHERE pet_id=?').run(after.level,after.growth,petId);
      // Drop only fractional growth belonging to the previous level. The other
      // online counters, RNG state and policy digest remain in their own domain.
      if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='online_pet_vitals_v1'").get())
        this.database.prepare("UPDATE online_pet_vitals_v1 SET remainder_json=json_set(remainder_json,'$.growth',0) WHERE pet_id=?").run(petId);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'pet-level-set', targetUin: uin,
        detail: {before, after, reason: String(reason).slice(0, 80)}});
      return Object.freeze({uin, petId, before, after});
    });
  }
  // Absolute testing values use the same durable profile the online clock reads.
  // Do not cache them in the administrator or revoke a live pet's connection.
  setPetVitals({uin, hunger, cleanliness, mood, health, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    const requested={hunger,cleanliness,mood,health};
    if(Object.values(requested).some(n=>!Number.isSafeInteger(n)||n<0)||mood>1000||health>5)
      throw new AccountError('INVALID_PET_VITALS','请填写整数：心情 0–1000，健康 0–5，饥饿和清洁不能超过当前等级上限');
    return this.accounts.runTransaction(()=>{
      const rows=this.database.prepare(`SELECT p.pet_id,q.level_value AS level,q.unknown_0x47 AS hunger,
        q.unknown_0x49 AS cleanliness,q.unknown_0x4e AS mood,q.unknown_0x4b AS health
        FROM pet p LEFT JOIN qqpenguin_login_profile q USING(pet_id) WHERE p.uin=?`).all(uin);
      if(!rows.length)throw new AccountError('ACCOUNT_WITHOUT_PET','这个账号还没有宠物');
      if(rows.length!==1)throw new AccountError('ACCOUNT_MULTIPLE_PETS','这个账号有多只宠物，无法确定要操作哪一只');
      if(rows[0].level===null)throw new AccountError('PET_PROFILE_MISSING','宠物资料缺失');
      const {pet_id:petId,level,...before}=rows[0],maximum=careMaximum(level);
      if(hunger>maximum||cleanliness>maximum)throw new AccountError('INVALID_PET_VITALS',`当前等级的饥饿、清洁上限为 ${maximum}`);
      // Keep the game's four-zero death rule and the approved adult mood rule.
      const after={...requested};if(!hunger||!cleanliness||!mood)after.health=0;
      if(level>=10&&after.health>0&&after.mood>=900&&(hunger<720||cleanliness<1080))after.mood=899;
      this.database.prepare(`UPDATE qqpenguin_login_profile SET unknown_0x47=?,unknown_0x49=?,unknown_0x4e=?,unknown_0x4b=? WHERE pet_id=?`)
        .run(after.hunger,after.cleanliness,after.mood,after.health,petId);
      if(this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='online_pet_vitals_v1'").get()){
        const row=this.database.prepare('SELECT remainder_json FROM online_pet_vitals_v1 WHERE pet_id=?').get(petId);
        if(row){
          const r=JSON.parse(row.remainder_json);
          // Only reset the edited values' fractional carries. Clock/growth/RNG
          // and policy version stay intact, including older supported policies.
          for(const key of ['hungerUnits','cleanUnits','moodUnits','hunger','cleanliness','mood','health','moodHalf','illnessMs','noticeMs'])if(Object.hasOwn(r,key))r[key]=0;
          if(Object.hasOwn(r,'disease'))r.disease=after.health>0&&after.health<5?(r.disease??'cold'):null;
          this.database.prepare('UPDATE online_pet_vitals_v1 SET remainder_json=? WHERE pet_id=?').run(JSON.stringify(r),petId);
        }
      }
      this.accounts.audit({actorUin,actorScope:'admin',action:'pet-vitals-set',targetUin:uin,detail:{before,after,reason:String(reason).slice(0,80)}});
      return Object.freeze({uin,petId,before,after,maximum});
    });
  }
}

// The rest of the administrator's minimum scope: what a pet currently looks like, an explicit
// inventory change, the catalogue as an operator sees it, and a consistent local backup.
//
// Category and effect edits go through the explicit catalogue-migration path, never silently:
// a staged edit produces a validated new policy, records the digest transition the saves need,
// and takes effect at the next server start, where each pet migrates through the recorded
// transition. Nothing here edits the file the running process already loaded.
export class AccountEconomyAdmin {
  constructor({accounts, database, economy, clock = Date.now, backupsRoot = null,
      careProfileFile = null} = {}) {
    if (typeof accounts?.audit !== 'function' || accounts.database !== database)
      throw new TypeError('INVALID_ECONOMY_ADMIN');
    if (typeof economy?.grant !== 'function' || typeof economy?.revoke !== 'function'
        || typeof economy?.itemSummary !== 'function') throw new TypeError('INVALID_ECONOMY_ADMIN');
    this.accounts = accounts; this.database = database; this.economy = economy;
    this.clock = clock; this.backupsRoot = backupsRoot; this.careProfileFile = careProfileFile;
    // The durable intent rows for staged catalogue generations: phase 1 of the commit
    // arrangement writes here before anything on disk moves, and the recovery pass reads it.
    database.exec(`CREATE TABLE IF NOT EXISTS catalogue_staging_v1 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      from_digest TEXT NOT NULL CHECK(length(from_digest)=64),
      to_digest TEXT NOT NULL CHECK(length(to_digest)=64),
      status TEXT NOT NULL CHECK(status IN ('pending','activated','failed')),
      activated_at INTEGER) STRICT;`);
  }
  #petsOf(uin) {
    return this.database.prepare(`SELECT p.pet_id,p.pet_name,p.level,p.growth,p.age_hours,p.sex,
      q.unknown_0x47 AS hunger,q.unknown_0x49 AS cleanliness,q.unknown_0x4b AS health,q.unknown_0x4e AS mood,
      q.unknown_0x67 AS yuanbao,q.level_value AS levelValue
      FROM pet p JOIN qqpenguin_login_profile q USING(pet_id) WHERE p.uin=? ORDER BY p.pet_id`).all(uin);
  }
  #requireOnePet(uin) {
    const pets = this.#petsOf(uin);
    if (pets.length === 0) throw new AccountError('ACCOUNT_WITHOUT_PET', '这个账号还没有宠物');
    if (pets.length > 1) throw new AccountError('ACCOUNT_MULTIPLE_PETS', '这个账号有多只宠物，无法确定要操作哪一只');
    return pets[0];
  }
  // The pet's own status, taken from the rows the game reads, plus the inventory the shop shows.
  petDetails(uin) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    const pet = this.#requireOnePet(uin);
    const state = this.database.prepare('SELECT state_json FROM pet_care_economy_v1 WHERE pet_id=?').get(pet.pet_id);
    const inventory = state ? JSON.parse(state.state_json).inventory : [];
    return Object.freeze({uin, petId: pet.pet_id, name: pet.pet_name, sex: pet.sex,
      level: pet.level, levelValue: pet.levelValue, growth: pet.growth, ageHours: pet.age_hours,
      hunger: pet.hunger, cleanliness: pet.cleanliness, health: pet.health, mood: pet.mood,
      yuanbao: pet.yuanbao, inventoryKinds: inventory.length,
      inventoryQuantity: inventory.reduce((sum, row) => sum + row.quantity, 0)});
  }
  // An explicit inventory change, in one transaction with the audit that records both sides.
  // A pet that has never entered the game has no care-economy state row yet; initializing it
  // here (idempotent) is what makes the operator's grant work on a freshly adopted pet instead
  // of failing on an absent row.
  adjustInventory({uin, cid, count, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(uin) || uin <= 0) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
    if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM', '商品编号无效');
    if (!Number.isInteger(count) || count === 0 || Math.abs(count) > 9999)
      throw new AccountError('INVALID_COUNT', '请输入 -9999 到 9999 之间的整数增减量');
    if (!this.economy.itemSummary(cid)) throw new AccountError('INVALID_ITEM', '没有这个商品');
    return this.accounts.runTransaction(() => {
      const pet = this.#requireOnePet(uin);
      const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(pet.pet_id));
      if (typeof this.economy.initialize === 'function') this.economy.initialize(uin, bytes);
      const before = this.#quantityOf(pet.pet_id, cid);
      if (count > 0) this.economy.grant(uin, bytes, [{cid, count}]);
      else this.economy.revoke(uin, bytes, {cid, count: -count});
      const after = this.#quantityOf(pet.pet_id, cid);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'inventory-adjust', targetUin: uin,
        detail: {cid, before, after, count, reason: String(reason).slice(0, 80)}});
      return Object.freeze({uin, petId: pet.pet_id, cid, before, after});
    });
  }
  #quantityOf(petId, cid) {
    const row = this.database.prepare('SELECT state_json FROM pet_care_economy_v1 WHERE pet_id=?').get(petId);
    if (!row) return 0;
    const owned = JSON.parse(row.state_json).inventory.find((entry) => entry.cid === cid);
    return owned ? owned.quantity : 0;
  }
  itemDetail(cid) {
    const item = this.economy.itemSummary(cid);
    if (!item) throw new AccountError('INVALID_ITEM', '没有这个商品');
    return item;
  }
  searchItems(query) {return this.economy.searchItems({query});}
  // A consistent copy of the live database, taken while the service runs: VACUUM INTO writes a
  // complete snapshot rather than a byte copy of a file that may be mid-transaction.
  backupNow({actorUin = null, reason = ''} = {}) {
    if (this.backupsRoot === null) throw new AccountError('BACKUP_UNAVAILABLE', '当前装配没有配置备份目录');
    const stamp = new Date(this.clock()).toISOString().replace(/[:.]/gu, '-');
    const target = path.join(this.backupsRoot, `accounts-${stamp}.sqlite`);
    mkdirSync(this.backupsRoot, {recursive: true});
    this.database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    const bytes = statSync(target).size;
    const digest = createHash('sha256').update(readFileSync(target)).digest('hex');
    this.accounts.audit({actorUin, actorScope: 'admin', action: 'backup', targetUin: null,
      detail: {bytes, reason: String(reason).slice(0, 80)}});
    return Object.freeze({file: path.basename(target), bytes, sha256: digest});
  }
  backupRoot() {return this.backupsRoot;}
  // The fields an operator may change on a catalogue item, and the commit arrangement a change
  // passes. One staged generation at a time:
  //
  //   1. a durable intent row ('pending') and the audit entry go in first, in one database
  //      transaction, while nothing on disk has moved — an audit failure therefore changes no
  //      file at all, which is exactly what the direct write ordering could not guarantee;
  //   2. the next catalogue and the extended transition chain are materialized as `.staged`
  //      files beside the live ones, never over them;
  //   3. activation renames the transition chain first and the catalogue second — a crash
  //      between the two leaves the old catalogue with a spare declared hop, which every pet
  //      can still walk, never a catalogue no save can open;
  //   4. the intent row is marked 'activated' with its own audit entry, and any crash before
  //      that is completed by completePendingStaging() at the next assembly.
  //
  // The declared hops accumulate, so a pet that stayed offline across several staged
  // generations walks A→B→C at its next entry instead of failing on a missing A→C pair.
  static ITEM_POLICY_FIELDS = Object.freeze(['name', 'class', 'subkind', 'hunger', 'cleanliness',
    'mood', 'charm', 'intelligence', 'strength', 'minLevel', 'maxLevel', 'price', 'desc']);
  stageItemPolicy({cid, fields = {}, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM', '商品编号无效');
    if (!this.careProfileFile) throw new AccountError('POLICY_STAGING_UNAVAILABLE', '这个装配没有配置可维护的商品目录文件。');
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new AccountError('INVALID_ITEM_FIELDS', '没有可应用的字段。');
    const keys = Object.keys(fields).filter((key) => fields[key] !== undefined && fields[key] !== '');
    if (keys.length === 0) throw new AccountError('INVALID_ITEM_FIELDS', '没有可应用的字段。');
    for (const key of keys) if (!AccountEconomyAdmin.ITEM_POLICY_FIELDS.includes(key))
      throw new AccountError('INVALID_ITEM_FIELDS', `字段 ${key} 不在可维护范围内。`);
    const profilePath = path.resolve(this.careProfileFile);
    const upgradesPath = path.join(path.dirname(profilePath), 'care-economy-upgrades.json');
    const document = JSON.parse(readFileSync(profilePath, 'utf8'));
    if (!document || typeof document.policy !== 'object') throw new AccountError('INVALID_CARE_CONFIGURATION');
    const current = validateCareEconomyPolicy(document.policy);
    const from = policyDigest(current);
    // The on-disk catalogue has to be reachable from the running one through declared hops:
    // the operator may stage the next generation on top of a previous staged one that has not
    // been restarted into yet, but a file that moved by undeclared means is still refused.
    const transitions = this.#upgradesFile(upgradesPath).transitions;
    declaredPath(this.economy.digest, from, transitions);
    const item = current.items.find((entry) => entry.cid === cid);
    if (!item) throw new AccountError('INVALID_ITEM', '没有这个商品');
    const edited = {...current, items: current.items.map((entry) => entry.cid === cid
      ? {...entry, ...Object.fromEntries(keys.map((key) => [key, Number.isInteger(entry[key]) ? Number(fields[key]) : fields[key]]))}
      : entry)};
    let next;
    try { next = validateCareEconomyPolicy(edited); }
    catch (error) { throw new AccountError('INVALID_ITEM_FIELDS', '修改后的目录不满足商品合同：' + (error?.message ?? '校验失败')); }
    const to = policyDigest(next);
    if (to === from) throw new AccountError('POLICY_UNCHANGED', '修改没有产生目录变化。');
    // Phase 1: durable intent and audit in one transaction, before any file moves.
    const stagingId = this.accounts.runTransaction(() => {
      this.#cancelPendingStaging(actorUin, 'new-staging');
      const info = this.database.prepare(
        'INSERT INTO catalogue_staging_v1(created_at,from_digest,to_digest,status) VALUES(?,?,?,?)')
        .run(this.clock(), from, to, 'pending');
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'item-policy-stage', targetUin: null,
        detail: {cid, from, to, fields: keys, reason: String(reason).slice(0, 80), stagingId: info.lastInsertRowid}});
      return Number(info.lastInsertRowid);
    });
    try {
      // Phase 2: materialize the staged pair beside the live files.
      const upgradesFile = this.#upgradesFile(upgradesPath);
      if (!upgradesFile.transitions.some((t) => t.from === from && t.to === to))
        upgradesFile.transitions.push({from, to});
      this.#atomicWrite(upgradesPath + '.staged', JSON.stringify(upgradesFile, null, 2) + '\n');
      document.policy = next;
      this.#atomicWrite(profilePath + '.staged', JSON.stringify(document, null, 2) + '\n');
      // Phase 3: activation — chain first, catalogue second.
      renameSync(upgradesPath + '.staged', upgradesPath);
      renameSync(profilePath + '.staged', profilePath);
    } catch (error) {
      // The pending intent stays and completePendingStaging() reconciles it; the active files
      // are either both old or (after the first rename) old catalogue with a spare hop.
      throw new AccountError('POLICY_ACTIVATION_FAILED', '暂存已记录但发布未完成：' + (error?.code ?? error?.message ?? '写文件失败'));
    }
    // Phase 4: the published state gets its own closure row.
    this.accounts.runTransaction(() => {
      this.database.prepare("UPDATE catalogue_staging_v1 SET status='activated',activated_at=? WHERE id=?")
        .run(this.clock(), stagingId);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'item-policy-activated', targetUin: null,
        detail: {cid, from, to, stagingId}});
    });
    return Object.freeze({cid, from, to, fields: keys, stagingId,
      note: '目录迁移已发布；新目录在下次服务启动时生效，宠物目录随后按声明的迁移链自动过渡。'});
  }
  // The recovery half of the arrangement, run at assembly: finish whatever a crash left in
  // 'pending'. Idempotent — an already-activated generation is left alone, a staged pair that
  // matches its intent is published, and an intent whose files never materialized is closed as
  // failed for the operator to re-stage.
  completePendingStaging() {
    if (!this.careProfileFile) return Object.freeze({completed: 0, failed: 0});
    const profilePath = path.resolve(this.careProfileFile);
    const upgradesPath = path.join(path.dirname(profilePath), 'care-economy-upgrades.json');
    const pending = this.database.prepare(
      "SELECT id,from_digest,to_digest FROM catalogue_staging_v1 WHERE status='pending' ORDER BY id").all();
    let completed = 0, failed = 0;
    for (const row of pending) {
      const stagedCatalogue = profilePath + '.staged', stagedUpgrades = upgradesPath + '.staged';
      try {
        if (existsSync(stagedCatalogue) && existsSync(stagedUpgrades)) {
          const staged = validateCareEconomyPolicy(JSON.parse(readFileSync(stagedCatalogue, 'utf8')).policy);
          if (policyDigest(staged) !== row.to_digest) throw new Error('STAGED_DIGEST_MISMATCH');
          renameSync(stagedUpgrades, upgradesPath);
          renameSync(stagedCatalogue, profilePath);
        } else if (!existsSync(stagedCatalogue) && !existsSync(stagedUpgrades)
            && policyDigest(validateCareEconomyPolicy(JSON.parse(readFileSync(profilePath, 'utf8')).policy)) === row.to_digest) {
          // The renames finished but the process died before the closure row: just close it.
        } else {
          throw new Error('STAGED_FILES_MISSING');
        }
        this.accounts.runTransaction(() => {
          this.database.prepare("UPDATE catalogue_staging_v1 SET status='activated',activated_at=? WHERE id=?")
            .run(this.clock(), row.id);
          this.accounts.audit({actorScope: 'local-recovery', action: 'item-policy-activated', targetUin: null,
            detail: {from: row.from_digest, to: row.to_digest, stagingId: row.id, recovered: true}});
        });
        completed += 1;
      } catch {
        this.accounts.runTransaction(() => {
          this.database.prepare("UPDATE catalogue_staging_v1 SET status='failed',activated_at=? WHERE id=?")
            .run(this.clock(), row.id);
          this.accounts.audit({actorScope: 'local-recovery', action: 'item-policy-stage-failed', targetUin: null,
            detail: {from: row.from_digest, to: row.to_digest, stagingId: row.id}});
        });
        failed += 1;
      }
    }
    return Object.freeze({completed, failed});
  }
  #upgradesFile(upgradesPath) {
    try {
      const document = JSON.parse(readFileSync(upgradesPath, 'utf8'));
      if (!document || !Array.isArray(document.transitions)) throw new Error('shape');
      return document;
    } catch (error) {
      if (error?.code === 'ENOENT') return {schemaVersion: 1, transitions: []};
      throw new AccountError('INVALID_CARE_UPGRADE_CONFIGURATION');
    }
  }
  // Exactly one staged generation at a time: an intent that was superseded before its files
  // were published is closed as failed, with its own audit entry.
  #cancelPendingStaging(actorUin, cause) {
    const pending = this.database.prepare(
      "SELECT id,from_digest,to_digest FROM catalogue_staging_v1 WHERE status='pending'").all();
    for (const row of pending) {
      this.database.prepare("UPDATE catalogue_staging_v1 SET status='failed',activated_at=? WHERE id=?")
        .run(this.clock(), row.id);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'item-policy-stage-cancelled', targetUin: null,
        detail: {from: row.from_digest, to: row.to_digest, stagingId: row.id, cause}});
    }
  }
  #atomicWrite(target, content) {
    const temporary = target + '.stage-' + process.pid + '.tmp';
    writeFileSync(temporary, content, 'utf8');
    try { renameSync(temporary, target); }
    catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
  }
}

// Local price overrides. A row means "this build sells this item for this price"; its absence means
// the catalogue's own price stands. Zero is the explicit "recorded but not sellable" value.
export class ItemPriceOverrides {
  constructor({accounts, database, clock = Date.now, tickets = null, sessions = null} = {}) {
    if (typeof accounts?.audit !== 'function' || accounts.database !== database)
      throw new TypeError('INVALID_PRICE_OVERRIDES');
    this.accounts = accounts;
    this.database = database;
    this.clock = clock;
    // The ticket issuer and the live game connections are what an outstanding credential still
    // reaches, so a disable has to close them too, not only the account row.
    if (tickets !== null && typeof tickets.revokeUin !== 'function') throw new TypeError('INVALID_TICKET_REVOCATION');
    if (sessions !== null && typeof sessions.closeUin !== 'function') throw new TypeError('INVALID_SESSION_CLOSURE');
    this.tickets = tickets; this.sessions = sessions;
    database.exec(`CREATE TABLE IF NOT EXISTS local_item_price_v1 (
      cid INTEGER PRIMARY KEY CHECK(cid > 0),
      price INTEGER NOT NULL CHECK(price BETWEEN 0 AND 1000000),
      reason TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL) STRICT;`);
    this.select = database.prepare('SELECT cid,price,reason,updated_at FROM local_item_price_v1 WHERE cid=?');
    this.all = database.prepare('SELECT cid,price FROM local_item_price_v1');
  }
  // The only way the economy asks about a price: the override when there is one, the catalogue's
  // own value otherwise.
  price(cid, fallback) {
    const row = this.select.get(cid);
    return row ? row.price : fallback;
  }
  priceOf(cid, fallback) {return this.price(cid, fallback);}
  snapshot() {return new Map(this.all.all().map((row) => [row.cid, row.price]));}
  setLocalPrice({cid, price, reason = '', actorUin = null} = {}) {
    if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM', '商品编号无效');
    if (!Number.isInteger(price) || price < 0 || price > 1000000)
      throw new AccountError('INVALID_PRICE', '价格需为 0 到 1000000 之间的整数');
    return this.accounts.runTransaction(() => {
      const before = this.select.get(cid);
      const now = this.clock();
      this.database.prepare(`INSERT INTO local_item_price_v1(cid,price,reason,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(cid) DO UPDATE SET price=excluded.price,reason=excluded.reason,updated_at=excluded.updated_at`)
        .run(cid, price, String(reason).slice(0, 80), now);
      this.accounts.audit({actorUin, actorScope: 'admin', action: 'item-price', targetUin: null,
        detail: {cid, before: before ? before.price : null, after: price, reason: String(reason).slice(0, 80)}});
      return Object.freeze({cid, before: before ? before.price : null, after: price});
    });
  }
}
