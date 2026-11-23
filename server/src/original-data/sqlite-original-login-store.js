import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { QqPenguinProfileDirectory } from "../original-login/qqpenguin-profile-directory.js";
import { LocalAccountDirectory } from "../txsso/account-directory.js";

export const ORIGINAL_LOGIN_STORE_SCHEMA_VERSION = 1;

const SCHEMA_SQL = readFileSync(new URL("./schema-v1.sql", import.meta.url), "utf8");
const DOMAIN_TABLES = Object.freeze([
  "account",
  "account_auth",
  "pet",
  "pet_attribute",
  "item_catalog",
  "pet_inventory",
  "wearable_catalog",
  "title_catalog",
  "pet_title",
  "travel_destination",
  "pet_travel",
  "robot_state",
  "robot_equipment_catalog",
  "pet_robot_equipment",
  "titan_state",
  "titan_catalog",
  "pet_titan_inventory",
  "qqpenguin_login_profile",
]);

export class OriginalLoginStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OriginalLoginStoreError";
    this.code = code;
  }
}

function requireText(value, name, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

function requireUInt(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} is outside its unsigned range`);
  }
  return value;
}

function requireNonzeroUInt(value, maximum, name) {
  requireUInt(value, maximum, name);
  if (value === 0) throw new TypeError(`${name} must be nonzero`);
  return value;
}

function normalizePetId(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/u.test(value)) {
    throw new TypeError("petId must be a canonical unsigned decimal string");
  }
  const numeric = BigInt(value);
  if (numeric > 0xffffffffffffffffn) {
    throw new TypeError("petId exceeds the unsigned 64-bit Root field");
  }
  return value;
}

function encodeExtra(value) {
  if (value === undefined) return "{}";
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("extra must be a JSON object when provided");
  }
  return JSON.stringify(value);
}

function normalizePetRecord(value) {
  const generation =
    value?.generation === null || value?.generation === undefined
      ? null
      : String(value.generation);
  const sex = value?.sex === null || value?.sex === undefined ? null : String(value.sex);
  return Object.freeze({
    petId: normalizePetId(value?.petId),
    uin: requireNonzeroUInt(value?.uin, 0xffffffff, "pet.uin"),
    petName: requireText(value?.petName, "pet.petName"),
    masterName: requireText(value?.masterName, "pet.masterName"),
    birthday:
      value?.birthday === null || value?.birthday === undefined
        ? null
        : requireText(value.birthday, "pet.birthday"),
    level: requireUInt(value?.level, Number.MAX_SAFE_INTEGER, "pet.level"),
    ageHours: requireUInt(value?.ageHours, Number.MAX_SAFE_INTEGER, "pet.ageHours"),
    growth: requireUInt(value?.growth, Number.MAX_SAFE_INTEGER, "pet.growth"),
    generation,
    sex,
    vipLevel: requireUInt(value?.vipLevel, Number.MAX_SAFE_INTEGER, "pet.vipLevel"),
    vipYearFlag: requireUInt(value?.vipYearFlag, 1, "pet.vipYearFlag"),
    currentTitle:
      value?.currentTitle === null || value?.currentTitle === undefined
        ? null
        : requireText(value.currentTitle, "pet.currentTitle"),
    extraJson: encodeExtra(value?.extra),
  });
}

function normalizeBootstrap({ accounts, pets, profiles } = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new TypeError("accounts must be a nonempty array");
  }
  if (!Array.isArray(pets) || pets.length === 0) {
    throw new TypeError("pets must be a nonempty array");
  }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new TypeError("profiles must be a nonempty array");
  }
  const normalizedAccounts = accounts.map((value) => ({
    uin: value?.uin,
    qqName: requireText(value?.qqName, "account.qqName"),
    passwordMd5Hex: value?.passwordMd5Hex,
    extraJson: encodeExtra(value?.extra),
  }));
  new LocalAccountDirectory(
    normalizedAccounts.map((value) => ({
      account: String(value.uin),
      uin: value.uin,
      passwordMd5Hex: value.passwordMd5Hex,
    })),
  );
  const accountUins = new Set(normalizedAccounts.map((value) => value.uin));
  const normalizedPets = pets.map(normalizePetRecord);
  const petsById = new Map();
  for (const pet of normalizedPets) {
    if (!accountUins.has(pet.uin)) throw new TypeError("pet references an unknown account UIN");
    if (petsById.has(pet.petId)) throw new TypeError("pets must contain unique petId values");
    petsById.set(pet.petId, pet);
  }
  const normalizedProfiles = profiles.map((value) => ({
    ...value,
    petId: normalizePetId(value?.petId),
    extraJson: encodeExtra(value?.extra),
  }));
  new QqPenguinProfileDirectory(normalizedProfiles);
  const profilePetIds = new Set();
  for (const profile of normalizedProfiles) {
    const pet = petsById.get(profile.petId);
    if (pet === undefined || pet.uin !== profile.uin) {
      throw new TypeError("profile must reference a pet owned by the same UIN");
    }
    if (profilePetIds.has(profile.petId)) {
      throw new TypeError("profiles must contain unique petId values");
    }
    profilePetIds.add(profile.petId);
    if (profile.petIdBytes.readBigUInt64LE().toString() !== profile.petId) {
      throw new TypeError("profile petIdBytes must be the little-endian encoding of petId");
    }
  }
  return Object.freeze({
    accounts: Object.freeze(normalizedAccounts),
    pets: Object.freeze(normalizedPets),
    profiles: Object.freeze(normalizedProfiles),
  });
}

// The desktop size column, in the 1/140 units FeedLogic divides by 140.0, is replayed exactly.
//
// This database holds two kinds of row: the ones this build's own adoption transaction writes -
// which carry the normal size because the writer puts it there - and the ones an imported
// bootstrap document writes, which carry whatever that document said, a zero included. Because
// both go through this same store, a row being here is not evidence that the adoption writer
// produced it, so the reader cannot know that a stored zero is this build's own old default
// rather than an imported value. The client has a defined meaning for a zero (it clamps it to the
// smallest scale it draws), so it is replayed as stored.
//
// Consequence, recorded rather than papered over: a pet adopted by an earlier build of this
// project keeps the zero it was given and stays at the client's minimum scale. Repairing it would
// need a per-row provenance fact written in the same transaction as the profile row and
// invalidated by any import that overwrites the field; this store does not have one, and inventing
// it for existing rows would be guessing. No migration is performed and no user database is
// opened for this.

function profileParameters(profile) {
  const login = profile.login;
  return {
    pet_id: profile.petId,
    pet_id_bytes: profile.petIdBytes,
    pet_name_bytes: login.petName,
    master_name_bytes: login.masterName,
    auto_feed_flag: login.autoFeedFlag,
    vip_flag: login.vipFlag,
    status_id: login.statusId,
    status_description_bytes: login.statusDescription,
    status_time: login.statusTime,
    level_value: login.levelValue,
    unknown_0x3f: login.unknown_0x3f,
    unknown_0x43: login.unknown_0x43,
    unknown_0x47: login.unknown_0x47,
    unknown_0x49: login.unknown_0x49,
    unknown_0x4b: login.unknown_0x4b,
    unknown_0x4d: login.unknown_0x4d,
    unknown_0x4e: login.unknown_0x4e,
    bubble_id: login.bubbleId,
    vehicle_id: login.vehicleId,
    decoration_stamp: login.decorationStamp,
    config_version: login.configVersion,
    avatar_version: login.avatarVersion,
    use_phase_flag: login.usePhaseFlag,
    unknown_0x61: login.unknown_0x61,
    unknown_0x65: login.unknown_0x65,
    unknown_0x66: login.unknown_0x66,
    unknown_0x67: login.unknown_0x67,
    unknown_0x6b: login.unknown_0x6b,
    hello_interval: profile.hello.interval,
    hello_unknown_0x1b: profile.hello.unknown_0x1b,
    extra_json: profile.extraJson,
  };
}

const UPSERT_PROFILE_SQL = `
  INSERT INTO qqpenguin_login_profile (
    pet_id, pet_id_bytes, pet_name_bytes, master_name_bytes,
    auto_feed_flag, vip_flag, status_id, status_description_bytes,
    status_time, level_value, unknown_0x3f, unknown_0x43,
    unknown_0x47, unknown_0x49, unknown_0x4b, unknown_0x4d, unknown_0x4e,
    bubble_id, vehicle_id, decoration_stamp, config_version, avatar_version,
    use_phase_flag, unknown_0x61, unknown_0x65, unknown_0x66, unknown_0x67,
    unknown_0x6b, hello_interval, hello_unknown_0x1b, extra_json
  ) VALUES (
    @pet_id, @pet_id_bytes, @pet_name_bytes, @master_name_bytes,
    @auto_feed_flag, @vip_flag, @status_id, @status_description_bytes,
    @status_time, @level_value, @unknown_0x3f, @unknown_0x43,
    @unknown_0x47, @unknown_0x49, @unknown_0x4b, @unknown_0x4d, @unknown_0x4e,
    @bubble_id, @vehicle_id, @decoration_stamp, @config_version, @avatar_version,
    @use_phase_flag, @unknown_0x61, @unknown_0x65, @unknown_0x66, @unknown_0x67,
    @unknown_0x6b, @hello_interval, @hello_unknown_0x1b, @extra_json
  ) ON CONFLICT(pet_id) DO UPDATE SET
    pet_id_bytes = excluded.pet_id_bytes,
    pet_name_bytes = excluded.pet_name_bytes,
    master_name_bytes = excluded.master_name_bytes,
    auto_feed_flag = excluded.auto_feed_flag,
    vip_flag = excluded.vip_flag,
    status_id = excluded.status_id,
    status_description_bytes = excluded.status_description_bytes,
    status_time = excluded.status_time,
    level_value = excluded.level_value,
    unknown_0x3f = excluded.unknown_0x3f,
    unknown_0x43 = excluded.unknown_0x43,
    unknown_0x47 = excluded.unknown_0x47,
    unknown_0x49 = excluded.unknown_0x49,
    unknown_0x4b = excluded.unknown_0x4b,
    unknown_0x4d = excluded.unknown_0x4d,
    unknown_0x4e = excluded.unknown_0x4e,
    bubble_id = excluded.bubble_id,
    vehicle_id = excluded.vehicle_id,
    decoration_stamp = excluded.decoration_stamp,
    config_version = excluded.config_version,
    avatar_version = excluded.avatar_version,
    use_phase_flag = excluded.use_phase_flag,
    unknown_0x61 = excluded.unknown_0x61,
    unknown_0x65 = excluded.unknown_0x65,
    unknown_0x66 = excluded.unknown_0x66,
    unknown_0x67 = excluded.unknown_0x67,
    unknown_0x6b = excluded.unknown_0x6b,
    hello_interval = excluded.hello_interval,
    hello_unknown_0x1b = excluded.hello_unknown_0x1b,
    extra_json = excluded.extra_json
`;

export class SqliteOriginalLoginStore {
  constructor({ filePath } = {}) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new TypeError("filePath must be a nonempty string");
    }
    this.filePath = filePath === ":memory:" ? filePath : path.resolve(filePath);
    if (this.filePath !== ":memory:") mkdirSync(path.dirname(this.filePath), { recursive: true });
    try {
      this.database = new DatabaseSync(this.filePath);
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      const version = this.database.prepare("PRAGMA user_version").get().user_version;
      if (version > ORIGINAL_LOGIN_STORE_SCHEMA_VERSION) {
        throw new OriginalLoginStoreError(
          "SCHEMA_TOO_NEW",
          "original login database schema is newer than this server",
        );
      }
      this.#transaction(() => this.database.exec(SCHEMA_SQL));
    } catch (error) {
      try {
        this.database?.close();
      } catch {
        // The opening/migration failure remains the useful error.
      }
      if (error instanceof OriginalLoginStoreError) throw error;
      throw new OriginalLoginStoreError("OPEN_FAILED", "original login database could not be opened", {
        cause: error,
      });
    }
    this.closed = false;
  }

  #transaction(operation) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The original transaction error remains authoritative.
      }
      throw error;
    }
  }

  upsertLoginBootstrap(bootstrap) {
    if (this.closed) throw new OriginalLoginStoreError("STORE_CLOSED", "store is closed");
    const normalized = normalizeBootstrap(bootstrap);
    try {
      this.#transaction(() => {
        const upsertAccount = this.database.prepare(`
          INSERT INTO account (uin, qq_name, extra_json) VALUES (?, ?, ?)
          ON CONFLICT(uin) DO UPDATE SET qq_name = excluded.qq_name, extra_json = excluded.extra_json
        `);
        const upsertAuth = this.database.prepare(`
          INSERT INTO account_auth (uin, password_md5) VALUES (?, ?)
          ON CONFLICT(uin) DO UPDATE SET password_md5 = excluded.password_md5
        `);
        for (const account of normalized.accounts) {
          upsertAccount.run(account.uin, account.qqName, account.extraJson);
          upsertAuth.run(account.uin, Buffer.from(account.passwordMd5Hex, "hex"));
        }
        const selectPetOwner = this.database.prepare("SELECT uin FROM pet WHERE pet_id = ?");
        const upsertPet = this.database.prepare(`
          INSERT INTO pet (
            pet_id, uin, pet_name, master_name, birthday, level, age_hours, growth,
            generation, sex, vip_level, vip_year_flag, current_title, extra_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(pet_id) DO UPDATE SET
            pet_name = excluded.pet_name,
            master_name = excluded.master_name,
            birthday = excluded.birthday,
            level = excluded.level,
            age_hours = excluded.age_hours,
            growth = excluded.growth,
            generation = excluded.generation,
            sex = excluded.sex,
            vip_level = excluded.vip_level,
            vip_year_flag = excluded.vip_year_flag,
            current_title = excluded.current_title,
            extra_json = excluded.extra_json
        `);
        for (const pet of normalized.pets) {
          const existing = selectPetOwner.get(pet.petId);
          if (existing !== undefined && existing.uin !== pet.uin) {
            throw new OriginalLoginStoreError(
              "PET_OWNER_CONFLICT",
              "an existing pet cannot be reassigned to another UIN",
            );
          }
          upsertPet.run(
            pet.petId,
            pet.uin,
            pet.petName,
            pet.masterName,
            pet.birthday,
            pet.level,
            pet.ageHours,
            pet.growth,
            pet.generation,
            pet.sex,
            pet.vipLevel,
            pet.vipYearFlag,
            pet.currentTitle,
            pet.extraJson,
          );
        }
        const selectPetBytes = this.database.prepare(
          "SELECT pet_id_bytes FROM qqpenguin_login_profile WHERE pet_id = ?",
        );
        const upsertProfile = this.database.prepare(UPSERT_PROFILE_SQL);
        for (const profile of normalized.profiles) {
          const existing = selectPetBytes.get(profile.petId);
          if (
            existing !== undefined &&
            !Buffer.from(existing.pet_id_bytes).equals(profile.petIdBytes)
          ) {
            throw new OriginalLoginStoreError(
              "PET_WIRE_ID_CONFLICT",
              "an existing pet cannot change its Root wire id",
            );
          }
          upsertProfile.run(profileParameters(profile));
        }
      });
    } catch (error) {
      if (error instanceof OriginalLoginStoreError) throw error;
      throw new OriginalLoginStoreError(
        "BOOTSTRAP_WRITE_FAILED",
        "original login bootstrap transaction was rolled back",
        { cause: error },
      );
    }
    return this.summary();
  }

  // A live read of one account's adopted pet, in the same shape loadServerConfiguration
  // produces. The client server asks for it per authentication instead of holding a snapshot,
  // so an account that adopts while the server is running is visible without a restart.
  profileForUin(uin) {
    if (this.closed) throw new OriginalLoginStoreError("STORE_CLOSED", "store is closed");
    const rows = this.database
      .prepare(`
        SELECT pet.uin, profile.*
        FROM qqpenguin_login_profile AS profile
        JOIN pet USING (pet_id)
        WHERE pet.uin = ?
        ORDER BY profile.pet_id
      `)
      .all(uin);
    return rows.map((row) => ({
      uin: row.uin,
      petIdBytes: Buffer.from(row.pet_id_bytes),
      login: {
        petName: Buffer.from(row.pet_name_bytes),
        masterName: Buffer.from(row.master_name_bytes),
        autoFeedFlag: row.auto_feed_flag,
        vipFlag: row.vip_flag,
        statusId: row.status_id,
        statusDescription: Buffer.from(row.status_description_bytes),
        statusTime: row.status_time,
        levelValue: row.level_value,
        unknown_0x3f: row.unknown_0x3f,
        unknown_0x43: row.unknown_0x43,
        unknown_0x47: row.unknown_0x47,
        unknown_0x49: row.unknown_0x49,
        unknown_0x4b: row.unknown_0x4b,
        unknown_0x4d: row.unknown_0x4d,
        unknown_0x4e: row.unknown_0x4e,
        bubbleId: row.bubble_id,
        vehicleId: row.vehicle_id,
        decorationStamp: row.decoration_stamp,
        configVersion: row.config_version,
        avatarVersion: row.avatar_version,
        usePhaseFlag: row.use_phase_flag,
        unknown_0x61: row.unknown_0x61,
        unknown_0x65: row.unknown_0x65,
        unknown_0x66: row.unknown_0x66,
        unknown_0x67: row.unknown_0x67,
        unknown_0x6b: row.unknown_0x6b,
      },
      hello: { interval: row.hello_interval, unknown_0x1b: row.hello_unknown_0x1b },
    }));
  }
  #hasAccountServiceTables() {
    // Only a positive answer is kept: the account service may be initialised after the first
    // load, and caching "absent" would then hide every account it registers for the rest of the
    // process. A negative answer costs one sqlite_master lookup.
    if (this.accountServiceTables === true) return true;
    this.accountServiceTables = Boolean(
      this.database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='account_login_v1'").get(),
    );
    return this.accountServiceTables;
  }
  loadServerConfiguration() {
    if (this.closed) throw new OriginalLoginStoreError("STORE_CLOSED", "store is closed");
    try {
      // Accounts come from the account table, not from the legacy auth table: a registration
      // that used the salted scheme has no legacy digest. `credentialKind` tells the caller
      // which verifier to use. The two optional tables belong to the account service, and a
      // database written before that service existed simply does not have them, so the query
      // shape is chosen once from the schema instead of joining tables that may be absent.
      const accounts = (this.#hasAccountServiceTables()
        ? this.database.prepare(`
            SELECT account.uin, account_login_v1.login_name,
              account_auth.password_md5, account_credential_v1.algo AS credential_algo
            FROM account
            LEFT JOIN account_auth USING (uin)
            LEFT JOIN account_login_v1 USING (uin)
            LEFT JOIN account_credential_v1 USING (uin)
            ORDER BY account.uin
          `).all()
        : this.database.prepare(`
            SELECT account.uin, NULL AS login_name, account_auth.password_md5, NULL AS credential_algo
            FROM account JOIN account_auth USING (uin)
            ORDER BY account.uin
          `).all())
        .map((row) => ({
          account: row.login_name ?? String(row.uin),
          uin: row.uin,
          passwordMd5Hex: row.password_md5 === null ? null : Buffer.from(row.password_md5).toString("hex"),
          credentialKind: row.credential_algo === null || row.credential_algo === undefined ? "legacy-md5" : "salted",
        }));
      const profiles = this.database
        .prepare(`
          SELECT pet.uin, profile.*
          FROM qqpenguin_login_profile AS profile
          JOIN pet USING (pet_id)
          ORDER BY pet.uin, profile.pet_id
        `)
        .all()
        .map((row) => ({
          uin: row.uin,
          petIdBytes: Buffer.from(row.pet_id_bytes),
          login: {
            petName: Buffer.from(row.pet_name_bytes),
            masterName: Buffer.from(row.master_name_bytes),
            autoFeedFlag: row.auto_feed_flag,
            vipFlag: row.vip_flag,
            statusId: row.status_id,
            statusDescription: Buffer.from(row.status_description_bytes),
            statusTime: row.status_time,
            levelValue: row.level_value,
            unknown_0x3f: row.unknown_0x3f,
            unknown_0x43: row.unknown_0x43,
            unknown_0x47: row.unknown_0x47,
            unknown_0x49: row.unknown_0x49,
            unknown_0x4b: row.unknown_0x4b,
            unknown_0x4d: row.unknown_0x4d,
            unknown_0x4e: row.unknown_0x4e,
            bubbleId: row.bubble_id,
            vehicleId: row.vehicle_id,
            decorationStamp: row.decoration_stamp,
            configVersion: row.config_version,
            avatarVersion: row.avatar_version,
            usePhaseFlag: row.use_phase_flag,
            unknown_0x61: row.unknown_0x61,
            unknown_0x65: row.unknown_0x65,
            unknown_0x66: row.unknown_0x66,
            unknown_0x67: row.unknown_0x67,
            unknown_0x6b: row.unknown_0x6b,
          },
          hello: {
            interval: row.hello_interval,
            unknown_0x1b: row.hello_unknown_0x1b,
          },
        }));
      new LocalAccountDirectory(accounts);
      // An account with no pet is the state a newly registered account is in, so it is
      // reported as such instead of failing the whole assembly. The caller decides what an
      // account without a pet may do; it is not silently given one.
      const profileUins = new Set(profiles.map((profile) => profile.uin));
      const petless = accounts.filter((account) => !profileUins.has(account.uin)).map((account) => account.uin);
      if (profiles.length > 0) new QqPenguinProfileDirectory(profiles);
      return Object.freeze({
        accounts: Object.freeze(accounts.map((value) => Object.freeze({ ...value }))),
        profiles: Object.freeze(profiles),
        petlessUins: Object.freeze(petless),
      });
    } catch (error) {
      if (error instanceof OriginalLoginStoreError) throw error;
      throw new OriginalLoginStoreError(
        "CORRUPT_LOGIN_STATE",
        "original login database cannot produce a valid server configuration",
        { cause: error },
      );
    }
  }

  // Local derived mirror. From this change on, both columns track
  // floor(original_online_time_v1.online_ms / 3600000); neither is an
  // independent pet-age fact. Runs inside the caller's transaction and never
  // opens, commits or rolls back one of its own, so a failed mirror cannot
  // leave a partially advanced accumulator behind.
  writeDerivedAgeHours(uin, petIdBytes, ageHours) {
    if (this.closed) throw new OriginalLoginStoreError("STORE_CLOSED", "store is closed");
    requireNonzeroUInt(uin, 0xffffffff, "mirror uin");
    if (!Buffer.isBuffer(petIdBytes) || petIdBytes.length !== 8) {
      throw new TypeError("mirror petIdBytes must contain the exact 8-byte pet id");
    }
    requireUInt(ageHours, 0xffffffff, "mirror ageHours");
    // Without a caller transaction the first statement would autocommit and the
    // second could fail afterwards, leaving the two columns split. Refuse before
    // touching either row instead of opening a transaction of our own.
    if (this.database.isTransaction !== true) {
      throw new OriginalLoginStoreError(
        "AGE_HOURS_MIRROR_REQUIRES_TRANSACTION",
        "writeDerivedAgeHours must run inside the caller's transaction",
      );
    }
    // Ownership is enforced in both statements: a pet id that does not belong
    // to this uin matches zero rows instead of writing across accounts.
    const profile = this.database
      .prepare(`
        UPDATE qqpenguin_login_profile SET unknown_0x43 = ?
        WHERE pet_id_bytes = ?
          AND pet_id IN (SELECT pet_id FROM pet WHERE uin = ?)
      `)
      .run(ageHours, petIdBytes, uin);
    const pet = this.database
      .prepare(`
        UPDATE pet SET age_hours = ?
        WHERE uin = ?
          AND pet_id IN (SELECT pet_id FROM qqpenguin_login_profile WHERE pet_id_bytes = ?)
      `)
      .run(ageHours, uin, petIdBytes);
    // "SQL did not throw" is not proof of synchronisation; the caller checks both counts.
    return Object.freeze({ profileRows: profile.changes, petRows: pet.changes });
  }

  summary() {
    if (this.closed) {
      return Object.freeze({ ready: false, schemaVersion: ORIGINAL_LOGIN_STORE_SCHEMA_VERSION });
    }
    const counts = {};
    for (const table of DOMAIN_TABLES) {
      counts[table] = this.database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    }
    return Object.freeze({
      ready: true,
      schemaVersion: this.database.prepare("PRAGMA user_version").get().user_version,
      counts: Object.freeze(counts),
      privacy: Object.freeze({
        databasePathPresent: false,
        accountPresent: false,
        uinPresent: false,
        passwordDigestPresent: false,
        petIdPresent: false,
        profileBytesPresent: false,
      }),
    });
  }

  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}
