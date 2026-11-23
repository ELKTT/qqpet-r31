export const HELLO_COMMAND_ID = 0x0536;
export const HELLO_DESCRIPTION_LENGTH = 16;
export const HELLO_REQUEST_MAX_LENGTH = 424;
export const HELLO_SUCCESS_LENGTH = 48;

export class HelloProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "HelloProtocolError";
    this.code = code;
    this.details = details;
  }
}

function requireUInt(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      `${name} is outside its unsigned range`,
    );
  }
}

function requireDescription(value) {
  if (!Buffer.isBuffer(value) || value.length !== HELLO_DESCRIPTION_LENGTH) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      `statusDescription must contain exactly ${HELLO_DESCRIPTION_LENGTH} bytes`,
    );
  }
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new HelloProtocolError("INVALID_ARGUMENT", `${name} must be a Buffer`);
  }
}

function requireHelloRequest(request) {
  if (!request || request.type !== "HelloRequest") {
    throw new HelloProtocolError("INVALID_ARGUMENT", "request must be a HelloRequest");
  }
  requireUInt(request.mode, 1, "mode");
  if (!Array.isArray(request.byteUpdates) || request.byteUpdates.length > 3) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      "byteUpdates must contain at most the three authoritative slots",
    );
  }
  if (!Array.isArray(request.wordUpdates) || request.wordUpdates.length > 255) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      "wordUpdates must contain at most 255 authoritative slots",
    );
  }
  for (const update of request.byteUpdates) {
    requireUInt(update?.index, 3, "byteUpdates.index");
    if (update.index === 0) {
      throw new HelloProtocolError("INVALID_ARGUMENT", "byteUpdates.index must be 1..3");
    }
    requireUInt(update.value, 0xff, "byteUpdates.value");
  }
  for (const update of request.wordUpdates) {
    requireUInt(update?.index, 0xfe, "wordUpdates.index");
    requireUInt(update.value, 0xffff, "wordUpdates.value");
  }
}

export function decodeHelloRequest(body) {
  requireBuffer(body, "body");
  if (body.length < 4) {
    throw new HelloProtocolError("HELLO_REQUEST_TOO_SHORT", "Hello request is shorter than four bytes");
  }
  if (body.length > HELLO_REQUEST_MAX_LENGTH) {
    throw new HelloProtocolError(
      "HELLO_REQUEST_TOO_LARGE",
      "Hello request exceeds the authoritative encoder buffer",
    );
  }
  let offset = 0;
  const mode = body.readUInt16BE(offset);
  offset += 2;
  if (mode > 1) {
    throw new HelloProtocolError("HELLO_REQUEST_MODE", "Hello mode is outside the confirmed 0/1 range");
  }
  const byteCount = body[offset++];
  if (byteCount > 3) {
    throw new HelloProtocolError(
      "HELLO_BYTE_UPDATE_COUNT",
      "Hello byte update count exceeds the three authoritative slots",
    );
  }
  if (offset + byteCount * 2 + 1 > body.length) {
    throw new HelloProtocolError("HELLO_REQUEST_TRUNCATED", "Hello byte updates are truncated");
  }
  const byteUpdates = [];
  for (let index = 0; index < byteCount; index += 1) {
    const slot = body[offset++];
    const value = body[offset++];
    if (slot < 1 || slot > 3) {
      throw new HelloProtocolError("HELLO_BYTE_UPDATE_INDEX", "Hello byte update index must be 1..3");
    }
    byteUpdates.push(Object.freeze({ index: slot, value }));
  }
  const wordCount = body[offset++];
  if (offset + wordCount * 3 !== body.length) {
    throw new HelloProtocolError(
      offset + wordCount * 3 > body.length ? "HELLO_REQUEST_TRUNCATED" : "HELLO_REQUEST_TRAILING_DATA",
      "Hello word updates do not consume the request exactly",
    );
  }
  const wordUpdates = [];
  for (let index = 0; index < wordCount; index += 1) {
    const slot = body[offset++];
    if (slot === 0xff) {
      throw new HelloProtocolError("HELLO_WORD_UPDATE_INDEX", "Hello word update index must be 0..254");
    }
    const value = body.readUInt16BE(offset);
    offset += 2;
    wordUpdates.push(Object.freeze({ index: slot, value }));
  }
  return Object.freeze({
    type: "HelloRequest",
    mode,
    byteUpdates: Object.freeze(byteUpdates),
    wordUpdates: Object.freeze(wordUpdates),
  });
}

export function encodeHelloRequest(request) {
  requireHelloRequest(request);
  const length = 4 + request.byteUpdates.length * 2 + request.wordUpdates.length * 3;
  if (length > HELLO_REQUEST_MAX_LENGTH) {
    throw new HelloProtocolError(
      "HELLO_REQUEST_TOO_LARGE",
      "Hello request exceeds the authoritative encoder buffer",
    );
  }
  const body = Buffer.allocUnsafe(length);
  let offset = 0;
  body.writeUInt16BE(request.mode, offset);
  offset += 2;
  body[offset++] = request.byteUpdates.length;
  for (const update of request.byteUpdates) {
    body[offset++] = update.index;
    body[offset++] = update.value;
  }
  body[offset++] = request.wordUpdates.length;
  for (const update of request.wordUpdates) {
    body[offset++] = update.index;
    body.writeUInt16BE(update.value, offset);
    offset += 2;
  }
  return body;
}

const UINT8_FIELDS = ["interval", "petSizeValue"];
const UINT16_FIELDS = [
  "liveStatus",
  "levelValue",
  "hungerValue",
  "cleanlinessValue",
  "healthValue",
  "moodValue",
];
const UINT32_FIELDS = [
  "statusTime",
  "unknown_0x1b",
  "onlineTimeValue",
  "growthValue",
];

export function createLocalHelloSuccess() {
  return {
    type: "HelloSuccess",
    result: 0,
    interval: 0,
    liveStatus: 0,
    statusDescription: Buffer.alloc(HELLO_DESCRIPTION_LENGTH),
    statusTime: 0,
    levelValue: 0,
    unknown_0x1b: 0,
    onlineTimeValue: 0,
    hungerValue: 0,
    cleanlinessValue: 0,
    healthValue: 0,
    petSizeValue: 0,
    moodValue: 0,
    growthValue: 0,
  };
}

export function createLocalHelloSuccessFromLogin(loginSuccess) {
  if (!loginSuccess || loginSuccess.type !== "LoginSuccess" || loginSuccess.result !== 0) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      "loginSuccess must be a successful LoginSuccess",
    );
  }
  requireDescription(loginSuccess.statusDescription);
  const response = createLocalHelloSuccess();
  response.liveStatus = loginSuccess.statusId;
  response.statusDescription = Buffer.from(loginSuccess.statusDescription);
  response.statusTime = loginSuccess.statusTime;
  response.levelValue = loginSuccess.levelValue;
  response.onlineTimeValue = loginSuccess.unknown_0x43;
  response.hungerValue = loginSuccess.unknown_0x47;
  response.cleanlinessValue = loginSuccess.unknown_0x49;
  response.healthValue = loginSuccess.unknown_0x4b;
  response.petSizeValue = loginSuccess.unknown_0x4d;
  response.moodValue = loginSuccess.unknown_0x4e;
  response.growthValue = loginSuccess.unknown_0x61;
  return response;
}

export function encodeHelloSuccess(response) {
  if (!response || response.type !== "HelloSuccess" || response.result !== 0) {
    throw new HelloProtocolError(
      "INVALID_ARGUMENT",
      "response must be a successful HelloSuccess",
    );
  }
  requireDescription(response.statusDescription);
  for (const field of UINT8_FIELDS) requireUInt(response[field], 0xff, field);
  for (const field of UINT16_FIELDS) requireUInt(response[field], 0xffff, field);
  for (const field of UINT32_FIELDS) requireUInt(response[field], 0xffffffff, field);

  const body = Buffer.allocUnsafe(HELLO_SUCCESS_LENGTH);
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

  body.writeInt16BE(0, offset);
  offset += 2;
  writeUInt8(response.interval);
  writeUInt16(response.liveStatus);
  response.statusDescription.copy(body, offset);
  offset += HELLO_DESCRIPTION_LENGTH;
  writeUInt32(response.statusTime);
  writeUInt16(response.levelValue);
  writeUInt32(response.unknown_0x1b);
  writeUInt32(response.onlineTimeValue);
  writeUInt16(response.hungerValue);
  writeUInt16(response.cleanlinessValue);
  writeUInt16(response.healthValue);
  writeUInt8(response.petSizeValue);
  writeUInt16(response.moodValue);
  writeUInt32(response.growthValue);
  return body;
}

export function decodeHelloSuccess(body) {
  if (!Buffer.isBuffer(body) || body.length !== HELLO_SUCCESS_LENGTH) {
    throw new HelloProtocolError(
      "HELLO_SUCCESS_LENGTH",
      "Hello success body has an unexpected length",
      { actualLength: Buffer.isBuffer(body) ? body.length : null },
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
  const result = body.readInt16BE(offset);
  offset += 2;
  if (result !== 0) {
    throw new HelloProtocolError(
      "HELLO_RESPONSE_NOT_SUCCESS",
      "decodeHelloSuccess only accepts the statically confirmed success layout",
      { result },
    );
  }
  const interval = readUInt8();
  const liveStatus = readUInt16();
  const statusDescription = Buffer.from(
    body.subarray(offset, offset + HELLO_DESCRIPTION_LENGTH),
  );
  offset += HELLO_DESCRIPTION_LENGTH;
  return {
    type: "HelloSuccess",
    result,
    interval,
    liveStatus,
    statusDescription,
    statusTime: readUInt32(),
    levelValue: readUInt16(),
    unknown_0x1b: readUInt32(),
    onlineTimeValue: readUInt32(),
    hungerValue: readUInt16(),
    cleanlinessValue: readUInt16(),
    healthValue: readUInt16(),
    petSizeValue: readUInt8(),
    moodValue: readUInt16(),
    growthValue: readUInt32(),
  };
}
