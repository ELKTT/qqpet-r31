import { decodeLoginSuccess, encodeLoginSuccess } from "../protocol/login.js";
export class QqPenguinProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QqPenguinProfileError";
    this.code = code;
  }
}

function requireUin(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new TypeError("profile uin must be a nonzero unsigned 32-bit integer");
  }
}

function requirePetIdBytes(value) {
  if (!Buffer.isBuffer(value) || value.length !== 8) {
    throw new TypeError("profile petIdBytes must contain the exact 8-byte Root pet id");
  }
}

function requireHelloFields(value) {
  if (!value || !Number.isInteger(value.interval) || value.interval < 0 || value.interval > 0xff) {
    throw new TypeError("profile hello.interval must be an unsigned byte");
  }
  if (
    !Number.isInteger(value.unknown_0x1b) ||
    value.unknown_0x1b < 0 ||
    value.unknown_0x1b > 0xffffffff
  ) {
    throw new TypeError("profile hello.unknown_0x1b must be an unsigned 32-bit integer");
  }
}

function normalizeRecord(record) {
  requireUin(record?.uin);
  requirePetIdBytes(record.petIdBytes);
  requireHelloFields(record.hello);
  const loginSuccess = {
    ...record.login,
    type: "LoginSuccess",
    result: 0,
    unknown_0x02_echo: 0,
  };
  const normalizedLogin = decodeLoginSuccess(encodeLoginSuccess(loginSuccess));
  return Object.freeze({
    uin: record.uin,
    petIdBytes: Buffer.from(record.petIdBytes),
    login: Object.freeze(normalizedLogin),
    hello: Object.freeze({
      interval: record.hello.interval,
      unknown_0x1b: record.hello.unknown_0x1b,
    }),
  });
}

function cloneRecord(record) {
  return Object.freeze({
    uin: record.uin,
    petIdBytes: Buffer.from(record.petIdBytes),
    login: Object.freeze({
      ...record.login,
      petName: Buffer.from(record.login.petName),
      masterName: Buffer.from(record.login.masterName),
      statusDescription: Buffer.from(record.login.statusDescription),
    }),
    hello: Object.freeze({ ...record.hello }),
  });
}

export class QqPenguinProfileDirectory {
  constructor(records) {
    // An empty set is legal: every account may be registered and still petless.
    if (!Array.isArray(records)) {
      throw new TypeError("profiles must be an array");
    }
    this.records = new Map();
    this.recordCount = 0;
    for (const input of records) {
      const record = normalizeRecord(input);
      let byPetId = this.records.get(record.uin);
      if (byPetId === undefined) {
        byPetId = new Map();
        this.records.set(record.uin, byPetId);
      }
      const petIdKey = record.petIdBytes.toString("hex");
      if (byPetId.has(petIdKey)) {
        throw new TypeError("profiles must contain unique UIN and pet id pairs");
      }
      byPetId.set(petIdKey, record);
      this.recordCount += 1;
    }
  }

  get size() {
    return this.recordCount;
  }

  resolve(uin, petIdBytes) {
    requireUin(uin);
    requirePetIdBytes(petIdBytes);
    const byPetId = this.records.get(uin);
    if (byPetId === undefined) {
      throw new QqPenguinProfileError("PROFILE_NOT_FOUND", "no QQPenguin profile is bound to the ticket UIN");
    }
    const record = byPetId.get(petIdBytes.toString("hex"));
    if (record === undefined) {
      throw new QqPenguinProfileError(
        "PET_ID_MISMATCH",
        "Root pet id is not bound to the authenticated ticket UIN",
      );
    }
    return cloneRecord(record);
  }

  createLoginSuccess(loginRequest, record) {
    return Object.freeze({
      ...record.login,
      petName: Buffer.from(record.login.petName),
      masterName: Buffer.from(record.login.masterName),
      statusDescription: Buffer.from(record.login.statusDescription),
      unknown_0x02_echo: loginRequest.unknown_0x42,
    });
  }

  createHelloSuccess(record) {
    const login = record.login;
    return Object.freeze({
      type: "HelloSuccess",
      result: 0,
      interval: record.hello.interval,
      liveStatus: login.statusId,
      statusDescription: Buffer.from(login.statusDescription),
      statusTime: login.statusTime,
      levelValue: login.levelValue,
      unknown_0x1b: record.hello.unknown_0x1b,
      onlineTimeValue: login.unknown_0x43,
      hungerValue: login.unknown_0x47,
      cleanlinessValue: login.unknown_0x49,
      healthValue: login.unknown_0x4b,
      petSizeValue: login.unknown_0x4d,
      moodValue: login.unknown_0x4e,
      growthValue: login.unknown_0x61,
    });
  }
}
