import {gameIpv4SAddr} from '../deployment/endpoints.js';

const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;
const UINT64_MAX = (1n << 64n) - 1n;

export class OriginalWebdirProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OriginalWebdirProfileError";
    this.code = code;
  }
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a" : "a nonempty"} string`);
  }
  if (value.includes("\0")) throw new TypeError(`${label} must not contain NUL`);
  return value;
}

function requireUint(value, maximum, label, { nonzero = false } = {}) {
  if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > maximum) {
    throw new TypeError(`${label} must be an unsigned integer in range`);
  }
  return value;
}

function requireJsonInt(value, label) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new TypeError(`${label} must be a signed 32-bit JSON integer`);
  }
  return value;
}

function requireDecimalU64(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${label} must be a canonical unsigned 64-bit decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > UINT64_MAX) {
    throw new TypeError(`${label} must be a nonzero unsigned 64-bit value`);
  }
  return value;
}

// The petid of an account that has no pet. The client's own reader decides "has pet" from this
// one field, so it is the only value a petless answer may change; a configured record keeps
// refusing it (requireDecimalU64 above) and only the petless builder below opts into it.
export const PETLESS_PET_ID_DECIMAL = "0";

function requireZeroOrDecimalU64(value, label) {
  if (value === PETLESS_PET_ID_DECIMAL) return value;
  return requireDecimalU64(value, label);
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlAttribute(value) {
  return escapeXml(String(value));
}

function xmlGameIp(unsigned) {
  // PetDir 0x100040DB and OnlineManager 0x10010D0B use atoi, then store EAX
  // unchanged. inet_ntoa at 0x1000AC10 consumes those bits. The payload has
  // already been checked as uint32: emit an in-range signed decimal, never an
  // overflowing positive decimal or a truncated address.
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function normalizeVersions(value) {
  if (!value || typeof value !== "object") throw new TypeError("versions must be an object");
  return Object.freeze({
    upgradetype: requireJsonInt(value.upgradetype, "versions.upgradetype"),
    loadver: requireJsonInt(value.loadver, "versions.loadver"),
    updatever: requireJsonInt(value.updatever, "versions.updatever"),
    kernelver: requireJsonInt(value.kernelver, "versions.kernelver"),
    kernelinfo: requireString(value.kernelinfo, "versions.kernelinfo", { allowEmpty: true }),
  });
}

function normalizeQqPenguinPayload(value, {allowZeroPetId = false} = {}) {
  const petIdDecimal = allowZeroPetId
    ? requireZeroOrDecimalU64(value?.petIdDecimal, "payload.petIdDecimal")
    : requireDecimalU64(value?.petIdDecimal, "payload.petIdDecimal");
  const petName = requireString(value.petName, "payload.petName", { allowEmpty: true });
  const hideMode = requireUint(value.hideMode, UINT32_MAX, "payload.hideMode");
  const lastZone = value.lastZone;
  const zone = value.zone;
  if (!lastZone || !zone) throw new TypeError("payload.lastZone and payload.zone are required");
  return Object.freeze({
    kind: "QQPenguin",
    petIdDecimal,
    petName,
    hideMode,
    lastZone: Object.freeze({
      id: requireUint(lastZone.id, UINT32_MAX, "payload.lastZone.id"),
      ip: requireUint(lastZone.ip, UINT32_MAX, "payload.lastZone.ip"),
      area: requireUint(lastZone.area, UINT32_MAX, "payload.lastZone.area"),
      port: requireUint(lastZone.port, UINT16_MAX, "payload.lastZone.port", { nonzero: true }),
    }),
    resourceDomain: requireString(value.resourceDomain, "payload.resourceDomain"),
    zone: Object.freeze({
      id: requireUint(zone.id, UINT32_MAX, "payload.zone.id"),
      ip: requireUint(zone.ip, UINT32_MAX, "payload.zone.ip"),
      port: requireUint(zone.port, UINT16_MAX, "payload.zone.port", { nonzero: true }),
    }),
  });
}

function normalizeRole(value, index) {
  const prefix = `payload.roles[${index}]`;
  return Object.freeze({
    id: requireDecimalU64(value?.id, `${prefix}.id`),
    name: requireString(value.name, `${prefix}.name`, { allowEmpty: true }),
    level: requireString(value.level, `${prefix}.level`, { allowEmpty: true }),
    gender: requireString(value.gender, `${prefix}.gender`, { allowEmpty: true }),
    icon2: requireString(value.icon2, `${prefix}.icon2`, { allowEmpty: true }),
    discharge: requireString(value.discharge, `${prefix}.discharge`, { allowEmpty: true }),
    tips: requireString(value.tips, `${prefix}.tips`, { allowEmpty: true }),
    tipstext: requireString(value.tipstext, `${prefix}.tipstext`, { allowEmpty: true }),
  });
}

function normalizeQqPetAgentPayload(value) {
  if (!Array.isArray(value?.roles) || value.roles.length === 0) {
    throw new TypeError("payload.roles must be a nonempty array");
  }
  return Object.freeze({
    kind: "QQPetAgent",
    type: requireString(value.type, "payload.type", { allowEmpty: true }),
    product: requireString(value.product, "payload.product"),
    title: requireString(value.title, "payload.title", { allowEmpty: true }),
    reg: requireString(value.reg, "payload.reg", { allowEmpty: true }),
    version: requireString(value.version, "payload.version", { allowEmpty: true }),
    roles: Object.freeze(value.roles.map(normalizeRole)),
  });
}

function normalizePreloginPayload(value) {
  if (value?.kind !== "Prelogin") throw new TypeError("prelogin payload kind is invalid");
  return Object.freeze({ kind: "Prelogin" });
}

function normalizeRecord(value) {
  const productName = requireString(value?.productName, "profile.productName");
  const versions = normalizeVersions(value.versions);
  const kind = value.payload?.kind;
  const uin = requireUint(value.uin, UINT32_MAX, "profile.uin", { nonzero: kind !== "Prelogin" });
  const payload = kind === "QQPenguin"
    ? normalizeQqPenguinPayload(value.payload)
    : kind === "QQPetAgent"
      ? normalizeQqPetAgentPayload(value.payload)
      : kind === "Prelogin" && uin === 0
        ? normalizePreloginPayload(value.payload)
        : (() => { throw new TypeError("payload.kind must be QQPenguin, QQPetAgent, or UIN-0 Prelogin"); })();
  return Object.freeze({ productName, uin, versions, payload });
}

// The start parameters of an account that has no pet yet. The element set is the one
// buildQqPenguinStartParam already emits, byte for byte, and the answer differs exactly in the
// (at most) two values a pet that does not exist cannot have: petid, which is the client's own
// "has pet" flag and is written as the explicit zero the parser reads, and petname, which is
// empty because there is no pet to name. Everything else - versions, last zone, resource
// domain, advised zone - is the endpoint this server owns, and no new field is invented.
export function buildPetlessQqPenguinStartParam(payload) {
  return buildQqPenguinStartParam({...payload, petIdDecimal: PETLESS_PET_ID_DECIMAL, petName: ""},
    {allowZeroPetId: true});
}

export function buildQqPenguinStartParam(payload, { allowZeroPetId = false, protocolOwnsPetName = false } = {}) {
  const value = normalizeQqPenguinPayload(payload, { allowZeroPetId });
  // PetLogin 23A2..23CB copies the XML attribute's bytes directly to the narrow
  // DataCenter key. Our JSON/XML transport is UTF-8; Login/0532/0552 own its GBK
  // value. An absent attribute is explicitly a no-write branch in that consumer.
  const petNameAttribute = protocolOwnsPetName ? "" : ` petname="${xmlAttribute(value.petName)}"`;
  return `<StartParam><Common petid="${value.petIdDecimal}"${petNameAttribute} hidemode="${value.hideMode}"/><PetDir><LastZone id="${value.lastZone.id}" ip="${xmlGameIp(value.lastZone.ip)}" area="${value.lastZone.area}" port="${value.lastZone.port}"/><Resource domain="${xmlAttribute(value.resourceDomain)}"/><AdviseZoneList><Zone id="${value.zone.id}" ip="${xmlGameIp(value.zone.ip)}" port="${value.zone.port}"/></AdviseZoneList></PetDir></StartParam>`;
}

export function buildQqPetAgentStartParam(payload) {
  const value = normalizeQqPetAgentPayload(payload);
  const roles = value.roles.map((role) => `<Role id="${role.id}" name="${xmlAttribute(role.name)}" level="${xmlAttribute(role.level)}" gender="${xmlAttribute(role.gender)}" icon2="${xmlAttribute(role.icon2)}" discharge="${xmlAttribute(role.discharge)}" tips="${xmlAttribute(role.tips)}" tipstext="${xmlAttribute(role.tipstext)}"/>`).join("");
  return `<StartParam><Pet type="${xmlAttribute(value.type)}" product="${xmlAttribute(value.product)}" title="${xmlAttribute(value.title)}" reg="${xmlAttribute(value.reg)}" version="${xmlAttribute(value.version)}">${roles}</Pet></StartParam>`;
}

function buildVersionInfo(record, protocolOwnsPetName=false) {
  const xmlinfo = record.payload.kind === "QQPenguin"
    ? buildQqPenguinStartParam(record.payload,{protocolOwnsPetName})
    : record.payload.kind === "QQPetAgent"
      ? buildQqPetAgentStartParam(record.payload)
      : "";
  return Object.freeze({ ...record.versions, xmlinfo });
}

export class OriginalWebdirProfileDirectory {
  constructor(records,{protocolOwnsPetName=false}={}) {
    if(typeof protocolOwnsPetName!=='boolean')throw new TypeError('INVALID_PET_NAME_OWNER');
    this.protocolOwnsPetName=protocolOwnsPetName;
    // An empty document is a fresh install: it declares no account yet, and the accounts come from
    // the store. Every record it does carry is still checked one by one.
    if (!Array.isArray(records)) {
      throw new TypeError("webdir profiles must be an array");
    }
    this.records = new Map();
    this.recordCount = 0;
    for (const input of records) {
      const record = normalizeRecord(input);
      const key = `${record.productName}\0${record.uin}`;
      if (this.records.has(key)) {
        throw new TypeError("webdir profiles must contain unique productName and UIN pairs");
      }
      this.records.set(key, record);
      this.recordCount += 1;
    }
  }

  get size() {
    return this.recordCount;
  }

  // Project only routing fields from an explicit deployment; validated identities, versions,
  // resource domains and the caller's name-ownership policy remain unchanged. Input is read-only.
  withGameEndpoint({ipv4, port}) {
    const ip = gameIpv4SAddr(ipv4);
    requireUint(port, UINT16_MAX, 'deployment.game.port', {nonzero: true});
    return new OriginalWebdirProfileDirectory([...this.records.values()].map((record) =>
      record.payload.kind !== 'QQPenguin' ? record : {...record, payload: {...record.payload,
        zone: {...record.payload.zone, ip, port}, lastZone: {...record.payload.lastZone, ip, port}}}),
    {protocolOwnsPetName: this.protocolOwnsPetName});
  }

  withResourceHost(host) {
    const match=typeof host==='string'&&/^([0-9.]+)(?::([1-9][0-9]{0,4}))?$/.exec(host);
    try{if(!match||match[2]&&Number(match[2])>65535)throw Error();gameIpv4SAddr(match[1]);}
    catch{throw new TypeError('INVALID_RESOURCE_HOST');}
    return new OriginalWebdirProfileDirectory([...this.records.values()].map(record=>
      record.payload.kind!=='QQPenguin'?record:{...record,payload:{...record.payload,resourceDomain:host}}),
    {protocolOwnsPetName:this.protocolOwnsPetName});
  }

  resolve(productName, uin) {
    requireString(productName, "productName");
    requireUint(uin, UINT32_MAX, "uin");
    const record = this.records.get(`${productName}\0${uin}`);
    if (record === undefined) {
      throw new OriginalWebdirProfileError(
        "PROFILE_NOT_FOUND",
        "no original webdir profile matches the requested product and UIN",
      );
    }
    return Object.freeze({ versioninfo: buildVersionInfo(record,this.protocolOwnsPetName) });
  }
}

export function parseOriginalWebdirProfileDocument(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) {
    throw new TypeError("webdir profile document schemaVersion must be 1");
  }
  if (!Array.isArray(value.profiles)) {
    throw new TypeError("webdir profile document requires a profiles array");
  }
  const directory = new OriginalWebdirProfileDirectory(value.profiles);
  return Object.freeze({
    schemaVersion: 1,
    profiles: Object.freeze(value.profiles.map((profile) => Object.freeze({ ...profile }))),
    profileCount: directory.size,
  });
}
