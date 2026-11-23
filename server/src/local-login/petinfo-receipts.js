// Versioned request receipts for the rename panel (/fcgi-bin/babyinfo cmd=11/cmd=12).
//
// One row answers one submission the client actually sent. A retransmission of that submission
// must be answered from its row — never by running the rename again — while a deliberate later
// request carries a fresh cache-buster and runs normally.
//
// Two key formulas have existed in this project:
//   * the superseded one hashed the session ticket: sha256(operation, petId, name, sha256(sign), nonce)
//   * the current one hashes the submitting account:  sha256(operation, petId, name, uin, nonce)
// A 64-hex key looks identical under both, so the version can never be read off the key. Rows
// therefore carry an explicit `key_version`, and rows that predate versioning are marked 0
// ("formula unrecorded") instead of being mistaken for current ones.
//
// Why the legacy rows cannot be matched or migrated exactly: the only thing the old row stores
// that identifies the request is the digest itself. Recomputing it needs sha256(sign) of the
// ticket that has already been revoked, and the row stores neither the target name nor the
// cache-buster, so no function of (stored row, incoming request) decides whether an incoming
// rename repeats a legacy transaction. A request that cannot be proven new must not be executed:
// doing so is what rolls a newer committed name back and burns another card. Such a request is
// refused, recorded, and stays refused until an operator closes the legacy epoch for it — the
// explicit, auditable decision this module exposes through closeEpoch(). Because that decision is
// database-wide and irreversible for the history it covers, the module also exposes inspect():
// a read-only statement of which epoch state a database is in, so the tool that performs the
// closure can refuse a missing, foreign or un-upgraded target without writing anything to it.
import {createHash} from 'node:crypto';

export const RECEIPT_KEY_VERSION_CURRENT = 1;
// 0 is not a formula: it marks a row written before versioning existed, whose key cannot be
// reproduced from anything the database still holds.
export const RECEIPT_KEY_VERSION_UNRECORDED = 0;

const CURRENT_FORMULA = 'sha256(operation \0 petId \0 target name \0 submitting account \0 cache-buster)';

const RECEIPT_TABLE = 'petinfo_receipt_v1';
const META_TABLE = 'petinfo_receipt_meta_v1';
// The columns the versioning upgrade adds. Their absence is what makes a table the historical
// six-column one, whose rows cannot be matched or migrated (see the header).
const VERSION_COLUMNS = Object.freeze(['key_version', 'name', 'nonce']);
const DEFAULT_CLOSE_REASON = 'operator confirmed no replayed request is outstanding';

export class PetinfoReceiptError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'PetinfoReceiptError';
    this.code = code;
  }
}

// The separators are NUL, matching the formula this key version has always used: a change here
// would orphan every row the running implementation already wrote.
export function currentRequestKey({operation, petId, name, uin, nonce}) {
  return createHash('sha256')
    .update(`${operation}\x00${petId}\x00${name}\x00${uin}\x00${nonce}`).digest('hex');
}

export class PetinfoReceipts {
  constructor({database, clock = Date.now, accountService = null}) {
    if (!database || typeof database.prepare !== 'function') throw new TypeError('INVALID_RECEIPT_DATABASE');
    this.database = database;
    this.clock = clock;
    this.accountService = accountService;
  }

  // Explicit and atomic: the table is created with the versioned columns, or an existing table
  // is extended once and every row it already held is stamped as unrecorded. The boundary is
  // written to the meta row in the same transaction, so "how many rows have an unrecorded
  // formula" is a recorded fact rather than a guess made later from the keys.
  upgrade() {
    const now = this.clock();
    PetinfoReceipts.ensureMetaTable(this.database);
    this.database.exec(`CREATE TABLE IF NOT EXISTS petinfo_receipt_v1 (
      request_key TEXT PRIMARY KEY CHECK(length(request_key)=64),
      pet_id TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('rename','master-rename')),
      result_code INTEGER NOT NULL,
      msg TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL) STRICT;`);
    const columns = new Set(this.database.prepare('PRAGMA table_info(petinfo_receipt_v1)').all().map((c) => c.name));
    const additive = [
      ['key_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['name', 'TEXT'],
      ['nonce', 'TEXT'],
    ].filter(([name]) => !columns.has(name));
    if (additive.length) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        for (const [name, type] of additive) {
          this.database.exec(`ALTER TABLE petinfo_receipt_v1 ADD COLUMN ${name} ${type}`);
        }
        const unrecorded = this.database.prepare(
          'SELECT count(*) AS n FROM petinfo_receipt_v1 WHERE key_version=0').get().n;
        this.database.prepare(`INSERT INTO petinfo_receipt_meta_v1(id,upgraded_at,unrecorded_receipts,formula)
          VALUES(1,?,?,?) ON CONFLICT(id) DO NOTHING`).run(now, unrecorded, CURRENT_FORMULA);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
    return this.describe();
  }

  // What this incoming request is, decided only from recorded facts.
  //
  //   'receipt'  — the submission already has an answer (by key, or by its business identity on
  //                a versioned row); answer from the row and run nothing.
  //   'refused'  — the pet carries receipts whose formula is unrecorded and the epoch is open, so
  //                the request cannot be proven new. Nothing is written and no card is touched.
  //   'new'      — no recorded submission matches; the caller may run the rename.
  classify({operation, petIdText, name, nonce, key, sameName}) {
    const byKey = this.database.prepare(
      'SELECT result_code AS code,msg,key_version AS version FROM petinfo_receipt_v1 WHERE request_key=?').get(key);
    if (byKey) return {kind: 'receipt', code: byKey.code, msg: byKey.msg, version: byKey.version};
    // The business identity is matched independently of the key formula, so a future formula
    // change cannot orphan the rows this version writes.
    const byIdentity = this.database.prepare(`SELECT result_code AS code,msg FROM petinfo_receipt_v1
      WHERE pet_id=? AND operation=? AND name=? AND nonce=? AND key_version>=? LIMIT 1`)
      .get(petIdText, operation, name, nonce, RECEIPT_KEY_VERSION_CURRENT);
    if (byIdentity) return {kind: 'receipt', code: byIdentity.code, msg: byIdentity.msg, version: RECEIPT_KEY_VERSION_CURRENT};
    const unrecorded = this.database.prepare(
      'SELECT count(*) AS n FROM petinfo_receipt_v1 WHERE pet_id=? AND key_version=?')
      .get(petIdText, RECEIPT_KEY_VERSION_UNRECORDED).n;
    if (unrecorded === 0) return {kind: 'new'};
    // A no-op changes nothing, so repeating it cannot roll anything back: it stays allowed and is
    // recorded. Only a request that would change the name is refused.
    if (sameName) return {kind: 'new', legacyUnrecorded: unrecorded};
    const epoch = this.database.prepare(
      'SELECT epoch_closed_at FROM petinfo_receipt_meta_v1 WHERE id=1').get()?.epoch_closed_at ?? null;
    if (epoch !== null) return {kind: 'new', legacyUnrecorded: unrecorded, epochClosedAt: epoch};
    return {kind: 'refused', legacyUnrecorded: unrecorded};
  }

  // The one row per submission, written inside the caller's transaction so the receipt, the card
  // deduction and the name change commit together.
  record({key, petIdText, operation, name, nonce}) {
    this.database.prepare(`INSERT OR IGNORE INTO petinfo_receipt_v1
      (request_key,pet_id,operation,result_code,msg,created_at,key_version,name,nonce)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(key, petIdText, operation, 0, '', this.clock(), RECEIPT_KEY_VERSION_CURRENT, name, nonce);
  }

  // The explicit operator decision the refusal waits for: "the receipts with an unrecorded formula
  // are history; renames from now on are trusted." Idempotent, audited, and it leaves every row in
  // place — no history is deleted and no card or name is touched.
  //
  // Transaction ownership: the audit sink owns the boundary. `accountService.runTransaction` joins
  // a transaction that is already open and otherwise opens exactly one, so the state update and the
  // audit row below commit together or not at all — a failing audit insert, state update or COMMIT
  // rolls the closure back, and there is no state in which the command reports failure while the
  // protection is already closed. closeEpoch never opens a transaction of its own (that would nest
  // one) and never writes the audit after the commit. A sink that cannot provide the boundary is
  // refused outright: closing the epoch without its audit row is the failure this guards against.
  closeEpoch({actorUin = null, actorScope = 'local', reason = DEFAULT_CLOSE_REASON} = {}) {
    const sink = this.accountService;
    if (!sink || typeof sink.runTransaction !== 'function' || typeof sink.audit !== 'function') {
      throw new PetinfoReceiptError('AUDIT_SINK_REQUIRED',
        'closing the epoch requires an audit sink that provides runTransaction and audit');
    }
    return sink.runTransaction(() => {
      const state = PetinfoReceipts.inspect(this.database);
      if (state.state !== 'upgraded') {
        throw new PetinfoReceiptError('EPOCH_SCHEMA_NOT_UPGRADED',
          `the receipt epoch schema is not upgraded: ${state.state}`);
      }
      // The boundary row is where the decision is recorded; without it the UPDATE below would
      // match nothing and the command would report a closure that never happened.
      if (!state.metaRowPresent) {
        throw new PetinfoReceiptError('EPOCH_BOUNDARY_ROW_MISSING',
          'the receipt epoch boundary row is missing');
      }
      // Already closed: a no-op. The timestamp stays and no second closure is audited — the
      // condition is on the row itself, so a repeated run cannot rewrite the decision.
      if (state.epochClosedAt !== null) {
        return {...this.describe(), closure: 'already-closed', auditWritten: false};
      }
      const now = this.clock();
      const updated = this.database.prepare(
        `UPDATE ${META_TABLE} SET epoch_closed_at=? WHERE id=1 AND epoch_closed_at IS NULL`).run(now);
      if (updated.changes !== 1) {
        throw new PetinfoReceiptError('EPOCH_BOUNDARY_NOT_UPDATED',
          'the epoch boundary row was not updated');
      }
      // Inside the same transaction, on purpose: the closure and the record of who decided it are
      // one fact. Only counts and the operator's reason are recorded — no credential, ticket or
      // account-identifying payload reaches the row or the tool's output.
      sink.audit({actorUin, actorScope, action: 'pet-rename-epoch-closed', targetUin: actorUin,
        detail: {reason, scope: 'database-wide', unrecordedReceipts: state.unrecordedReceipts,
          affectedPets: state.petsWithUnrecordedReceipts, totalReceipts: state.totalReceipts}});
      return {...this.describe(), closure: 'closed', auditWritten: true};
    });
  }

  // Where this database stands, decided by reading only. It touches sqlite_master, the receipt
  // table and the meta row and creates nothing — no table, no column, no row, no migration — so a
  // caller can learn the epoch state of a database it is not yet allowed to write. The states are
  // distinct because the answers are: 'receipt-table-missing' is a database this feature has never
  // run against, 'version-columns-missing' is the historical six-column table whose rows cannot be
  // matched (the refusal exists for it; it must be upgraded by the server, never by a dry run),
  // and only 'upgraded' can carry an epoch boundary.
  static inspect(database) {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all().map((row) => String(row.name)));
    if (!tables.has(RECEIPT_TABLE)) return {state: 'receipt-table-missing'};
    const columns = new Set(database.prepare(`PRAGMA table_info(${RECEIPT_TABLE})`)
      .all().map((column) => String(column.name)));
    const missingColumns = VERSION_COLUMNS.filter((name) => !columns.has(name));
    if (missingColumns.length) return {state: 'version-columns-missing', missingColumns};
    if (!tables.has(META_TABLE)) return {state: 'meta-table-missing'};
    // A row is not the same as a table: the table is created empty by the upgrade path, and only
    // the meta row is the recorded boundary.
    const meta = database.prepare(`SELECT upgraded_at AS upgradedAt,formula AS formula,
      epoch_closed_at AS epochClosedAt FROM ${META_TABLE} WHERE id=1`).get() ?? null;
    const counts = PetinfoReceipts.#counts(database);
    return {
      state: 'upgraded',
      metaRowPresent: meta !== null,
      formula: meta?.formula ?? CURRENT_FORMULA,
      upgradedAt: meta?.upgradedAt ?? null,
      epochClosedAt: meta?.epochClosedAt ?? null,
      ...counts,
    };
  }

  // The counts that state the real scope of the decision: every pet in the database hangs on the
  // same boundary, so the caller reports how many pets and rows it covers, not "one pet".
  static #counts(database) {
    const counts = database.prepare(`SELECT
      sum(CASE WHEN key_version=? THEN 1 ELSE 0 END) AS unrecorded,
      sum(CASE WHEN key_version>=? THEN 1 ELSE 0 END) AS versioned,
      count(*) AS total,
      count(DISTINCT CASE WHEN key_version=? THEN pet_id END) AS unrecordedPets
      FROM ${RECEIPT_TABLE}`)
      .get(RECEIPT_KEY_VERSION_UNRECORDED, RECEIPT_KEY_VERSION_CURRENT, RECEIPT_KEY_VERSION_UNRECORDED);
    return {
      unrecordedReceipts: Number(counts.unrecorded ?? 0),
      versionedReceipts: Number(counts.versioned ?? 0),
      totalReceipts: Number(counts.total ?? 0),
      petsWithUnrecordedReceipts: Number(counts.unrecordedPets ?? 0),
    };
  }

  describe() {
    const state = PetinfoReceipts.inspect(this.database);
    if (state.state !== 'upgraded') {
      throw new PetinfoReceiptError('EPOCH_SCHEMA_NOT_UPGRADED',
        `the receipt epoch schema is not upgraded: ${state.state}`);
    }
    return {
      keyVersion: RECEIPT_KEY_VERSION_CURRENT,
      formula: state.formula,
      upgradedAt: state.upgradedAt,
      epochClosedAt: state.epochClosedAt,
      unrecordedReceipts: state.unrecordedReceipts,
      versionedReceipts: state.versionedReceipts,
      totalReceipts: state.totalReceipts,
    };
  }

  static ensureMetaTable(database) {
    database.exec(`CREATE TABLE IF NOT EXISTS petinfo_receipt_meta_v1 (
      id INTEGER PRIMARY KEY CHECK(id=1),
      upgraded_at INTEGER NOT NULL,
      unrecorded_receipts INTEGER NOT NULL DEFAULT 0,
      epoch_closed_at INTEGER,
      formula TEXT NOT NULL) STRICT;`);
  }
}
