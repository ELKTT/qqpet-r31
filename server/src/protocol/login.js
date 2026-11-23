const LOGIN_REQUEST_FIXED_LENGTH = 24;
const LOGIN_REQUEST_FIXED_TAIL_LENGTH = 23;
const LOGIN_CREDENTIAL_MAX_LENGTH = 1024;
const LOGIN_FIXED_TEXT_LENGTH = 16;
const LOGIN_SUCCESS_LENGTH = 108;

export class LoginProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LoginProtocolError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new LoginProtocolError("INVALID_ARGUMENT", `${name} must be a Buffer`);
  }
}

function requireUInt(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new LoginProtocolError("INVALID_ARGUMENT", `${name} is outside its unsigned range`);
  }
}

function requireFixedBytes(value, name) {
  requireBuffer(value, name);
  if (value.length !== LOGIN_FIXED_TEXT_LENGTH) {
    throw new LoginProtocolError(
      "INVALID_ARGUMENT",
      `${name} must contain exactly ${LOGIN_FIXED_TEXT_LENGTH} bytes`,
    );
  }
}

function visibleByteLength(value) {
  const terminator = value.indexOf(0);
  return terminator === -1 ? value.length : terminator;
}

export function decodeLoginRequest(body) {
  requireBuffer(body, "body");
  if (body.length < LOGIN_REQUEST_FIXED_LENGTH) {
    throw new LoginProtocolError(
      "LOGIN_REQUEST_TOO_SHORT",
      "Login request cannot contain its fixed fields",
      { actualLength: body.length, minimumLength: LOGIN_REQUEST_FIXED_LENGTH },
    );
  }
  const credentialLength = body.length - LOGIN_REQUEST_FIXED_LENGTH;
  if (credentialLength > LOGIN_CREDENTIAL_MAX_LENGTH) {
    throw new LoginProtocolError(
      "LOGIN_REQUEST_TOO_LARGE",
      "Login credential exceeds the authoritative client buffer bound",
      { actualLength: body.length, maximumCredentialLength: LOGIN_CREDENTIAL_MAX_LENGTH },
    );
  }

  let offset = 0;
  const credentialModeOrLength = body[offset];
  offset += 1;
  const credential = Buffer.from(body.subarray(offset, offset + credentialLength));
  offset += credentialLength;
  const clientFlag = body[offset];
  offset += 1;
  const unknown_0x42 = body.readUInt16BE(offset);
  offset += 2;
  const nickname = Buffer.from(body.subarray(offset, offset + LOGIN_FIXED_TEXT_LENGTH));
  offset += LOGIN_FIXED_TEXT_LENGTH;
  const unknown_0x54 = body.readUInt32BE(offset);

  return {
    type: "LoginRequest",
    credentialModeOrLength,
    credential,
    clientFlag,
    unknown_0x42,
    nickname,
    unknown_0x54,
  };
}

export function encodeLoginRequest(request) {
  if (!request || request.type !== "LoginRequest") {
    throw new LoginProtocolError("INVALID_ARGUMENT", "request must be a LoginRequest");
  }
  requireUInt(request.credentialModeOrLength, 0xff, "credentialModeOrLength");
  requireBuffer(request.credential, "credential");
  if (request.credential.length > LOGIN_CREDENTIAL_MAX_LENGTH) {
    throw new LoginProtocolError(
      "LOGIN_REQUEST_TOO_LARGE",
      "Login credential exceeds the authoritative client buffer bound",
    );
  }
  requireUInt(request.clientFlag, 0xff, "clientFlag");
  requireUInt(request.unknown_0x42, 0xffff, "unknown_0x42");
  requireFixedBytes(request.nickname, "nickname");
  requireUInt(request.unknown_0x54, 0xffffffff, "unknown_0x54");

  const body = Buffer.allocUnsafe(LOGIN_REQUEST_FIXED_LENGTH + request.credential.length);
  let offset = 0;
  body[offset] = request.credentialModeOrLength;
  offset += 1;
  request.credential.copy(body, offset);
  offset += request.credential.length;
  body[offset] = request.clientFlag;
  offset += 1;
  body.writeUInt16BE(request.unknown_0x42, offset);
  offset += 2;
  request.nickname.copy(body, offset);
  offset += LOGIN_FIXED_TEXT_LENGTH;
  body.writeUInt32BE(request.unknown_0x54, offset);
  return body;
}

export function summarizeLoginRequest(request) {
  if (!request || request.type !== "LoginRequest") {
    throw new LoginProtocolError("INVALID_ARGUMENT", "request must be a LoginRequest");
  }
  requireBuffer(request.credential, "credential");
  requireFixedBytes(request.nickname, "nickname");
  return {
    type: request.type,
    credentialModeOrLength: request.credentialModeOrLength,
    credentialLength: request.credential.length,
    clientFlag: request.clientFlag,
    nicknameLength: visibleByteLength(request.nickname),
  };
}

export function decodeLoginSuccess(body) {
  requireBuffer(body, "body");
  if (body.length !== LOGIN_SUCCESS_LENGTH) {
    throw new LoginProtocolError(
      "LOGIN_SUCCESS_LENGTH",
      "Login success body has an unexpected length",
      { actualLength: body.length, expectedLength: LOGIN_SUCCESS_LENGTH },
    );
  }

  let offset = 0;
  const readUInt8 = () => body[offset++];
  const readUInt16 = () => {
    const value = body.readUInt16BE(offset);
    offset += 2;
    return value;
  };
  const readUInt32 = () => {
    const value = body.readUInt32BE(offset);
    offset += 4;
    return value;
  };
  const readFixedBytes = () => {
    const value = Buffer.from(body.subarray(offset, offset + LOGIN_FIXED_TEXT_LENGTH));
    offset += LOGIN_FIXED_TEXT_LENGTH;
    return value;
  };

  const result = body.readInt16BE(offset);
  offset += 2;
  if (result !== 0) {
    throw new LoginProtocolError(
      "LOGIN_RESPONSE_NOT_SUCCESS",
      "decodeLoginSuccess only accepts the statically confirmed success layout",
      { result },
    );
  }

  return {
    type: "LoginSuccess",
    result,
    unknown_0x02_echo: readUInt16(),
    petName: readFixedBytes(),
    masterName: readFixedBytes(),
    autoFeedFlag: readUInt16(),
    vipFlag: readUInt8(),
    statusId: readUInt16(),
    statusDescription: readFixedBytes(),
    statusTime: readUInt32(),
    levelValue: readUInt16(),
    unknown_0x3f: readUInt32(),
    unknown_0x43: readUInt32(),
    unknown_0x47: readUInt16(),
    unknown_0x49: readUInt16(),
    unknown_0x4b: readUInt16(),
    unknown_0x4d: readUInt8(),
    unknown_0x4e: readUInt16(),
    bubbleId: readUInt32(),
    vehicleId: readUInt32(),
    decorationStamp: readUInt16(),
    configVersion: readUInt32(),
    avatarVersion: readUInt16(),
    usePhaseFlag: readUInt8(),
    unknown_0x61: readUInt32(),
    unknown_0x65: readUInt8(),
    unknown_0x66: readUInt8(),
    unknown_0x67: readUInt32(),
    unknown_0x6b: readUInt8(),
  };
}

const LOGIN_SUCCESS_UINT8_FIELDS = [
  "vipFlag",
  "unknown_0x4d",
  "usePhaseFlag",
  "unknown_0x65",
  "unknown_0x66",
  "unknown_0x6b",
];
const LOGIN_SUCCESS_UINT16_FIELDS = [
  "unknown_0x02_echo",
  "autoFeedFlag",
  "statusId",
  "levelValue",
  "unknown_0x47",
  "unknown_0x49",
  "unknown_0x4b",
  "unknown_0x4e",
  "decorationStamp",
  "avatarVersion",
];
const LOGIN_SUCCESS_UINT32_FIELDS = [
  "statusTime",
  "unknown_0x3f",
  "unknown_0x43",
  "bubbleId",
  "vehicleId",
  "configVersion",
  "unknown_0x61",
  "unknown_0x67",
];

export function encodeLoginSuccess(response) {
  if (!response || response.type !== "LoginSuccess" || response.result !== 0) {
    throw new LoginProtocolError("INVALID_ARGUMENT", "response must be a successful LoginSuccess");
  }
  requireFixedBytes(response.petName, "petName");
  requireFixedBytes(response.masterName, "masterName");
  requireFixedBytes(response.statusDescription, "statusDescription");
  for (const field of LOGIN_SUCCESS_UINT8_FIELDS) requireUInt(response[field], 0xff, field);
  for (const field of LOGIN_SUCCESS_UINT16_FIELDS) requireUInt(response[field], 0xffff, field);
  for (const field of LOGIN_SUCCESS_UINT32_FIELDS) requireUInt(response[field], 0xffffffff, field);

  const body = Buffer.allocUnsafe(LOGIN_SUCCESS_LENGTH);
  let offset = 0;
  const writeUInt8 = (value) => {
    body[offset] = value;
    offset += 1;
  };
  const writeUInt16 = (value) => {
    body.writeUInt16BE(value, offset);
    offset += 2;
  };
  const writeUInt32 = (value) => {
    body.writeUInt32BE(value, offset);
    offset += 4;
  };
  const writeFixedBytes = (value) => {
    value.copy(body, offset);
    offset += LOGIN_FIXED_TEXT_LENGTH;
  };

  body.writeInt16BE(0, offset);
  offset += 2;
  writeUInt16(response.unknown_0x02_echo);
  writeFixedBytes(response.petName);
  writeFixedBytes(response.masterName);
  writeUInt16(response.autoFeedFlag);
  writeUInt8(response.vipFlag);
  writeUInt16(response.statusId);
  writeFixedBytes(response.statusDescription);
  writeUInt32(response.statusTime);
  writeUInt16(response.levelValue);
  writeUInt32(response.unknown_0x3f);
  writeUInt32(response.unknown_0x43);
  writeUInt16(response.unknown_0x47);
  writeUInt16(response.unknown_0x49);
  writeUInt16(response.unknown_0x4b);
  writeUInt8(response.unknown_0x4d);
  writeUInt16(response.unknown_0x4e);
  writeUInt32(response.bubbleId);
  writeUInt32(response.vehicleId);
  writeUInt16(response.decorationStamp);
  writeUInt32(response.configVersion);
  writeUInt16(response.avatarVersion);
  writeUInt8(response.usePhaseFlag);
  writeUInt32(response.unknown_0x61);
  writeUInt8(response.unknown_0x65);
  writeUInt8(response.unknown_0x66);
  writeUInt32(response.unknown_0x67);
  writeUInt8(response.unknown_0x6b);
  return body;
}

export function createLocalLoginSuccess(request, { petName, masterName, levelValue = 0 }) {
  if (!request || request.type !== "LoginRequest") {
    throw new LoginProtocolError("INVALID_ARGUMENT", "request must be a LoginRequest");
  }
  requireFixedBytes(petName, "petName");
  requireFixedBytes(masterName, "masterName");
  requireUInt(levelValue, 0xffff, "levelValue");
  return {
    type: "LoginSuccess",
    result: 0,
    unknown_0x02_echo: request.unknown_0x42,
    petName: Buffer.from(petName),
    masterName: Buffer.from(masterName),
    autoFeedFlag: 0,
    vipFlag: 0,
    statusId: 0,
    statusDescription: Buffer.alloc(LOGIN_FIXED_TEXT_LENGTH),
    statusTime: 0,
    levelValue,
    unknown_0x3f: 0,
    unknown_0x43: 0,
    unknown_0x47: 0,
    unknown_0x49: 0,
    unknown_0x4b: 0,
    unknown_0x4d: 0,
    unknown_0x4e: 0,
    bubbleId: 0,
    vehicleId: 0,
    decorationStamp: 0,
    configVersion: 0,
    avatarVersion: 0,
    usePhaseFlag: 0,
    unknown_0x61: 0,
    unknown_0x65: 0,
    unknown_0x66: 0,
    unknown_0x67: 0,
    unknown_0x6b: 0,
  };
}

export const LOGIN_LAYOUT = Object.freeze({
  requestFixedTailLength: LOGIN_REQUEST_FIXED_TAIL_LENGTH,
  maximumCredentialLength: LOGIN_CREDENTIAL_MAX_LENGTH,
  fixedTextLength: LOGIN_FIXED_TEXT_LENGTH,
  successLength: LOGIN_SUCCESS_LENGTH,
});
