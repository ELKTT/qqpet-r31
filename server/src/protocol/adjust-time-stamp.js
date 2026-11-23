export const ADJUST_TIME_STAMP_COMMAND_ID = 0x1101;
export const ADJUST_TIME_STAMP_REQUEST_LENGTH = 4;
export const ADJUST_TIME_STAMP_SUCCESS_LENGTH = 12;

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export class AdjustTimeStampProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdjustTimeStampProtocolError";
    this.code = code;
    this.details = details;
  }
}

function requireBody(body, expectedLength, code, label) {
  if (!Buffer.isBuffer(body) || body.length !== expectedLength) {
    throw new AdjustTimeStampProtocolError(
      code,
      `${label} body has an unexpected length`,
      { actualLength: Buffer.isBuffer(body) ? body.length : null, expectedLength },
    );
  }
}

function requireUInt32(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new AdjustTimeStampProtocolError(
      "INVALID_ARGUMENT",
      `${name} is outside its unsigned 32-bit range`,
    );
  }
}

function requireUInt64(value, name) {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new AdjustTimeStampProtocolError(
      "INVALID_ARGUMENT",
      `${name} is outside its unsigned 64-bit range`,
    );
  }
}

export function decodeAdjustTimeStampRequest(body) {
  requireBody(
    body,
    ADJUST_TIME_STAMP_REQUEST_LENGTH,
    "ADJUST_TIME_STAMP_REQUEST_LENGTH",
    "AdjustTimeStamp request",
  );
  return {
    type: "AdjustTimeStampRequest",
    sentClientTime: body.readUInt32BE(0),
  };
}

export function createLocalAdjustTimeStampSuccess({ sentClientTime, serverTime }) {
  requireUInt32(sentClientTime, "sentClientTime");
  requireUInt64(serverTime, "serverTime");
  return {
    type: "AdjustTimeStampSuccess",
    sentClientTime,
    serverTime,
  };
}

export function encodeAdjustTimeStampSuccess(message) {
  if (!message || message.type !== "AdjustTimeStampSuccess") {
    throw new AdjustTimeStampProtocolError(
      "INVALID_ARGUMENT",
      "message must be an AdjustTimeStampSuccess",
    );
  }
  requireUInt32(message.sentClientTime, "sentClientTime");
  requireUInt64(message.serverTime, "serverTime");

  const body = Buffer.allocUnsafe(ADJUST_TIME_STAMP_SUCCESS_LENGTH);
  body.writeUInt32BE(message.sentClientTime, 0);
  // BaseComponent's DecodeInt64 copies eight bytes without an endian swap.
  // The authoritative x86 client therefore consumes this field as little-endian.
  body.writeBigUInt64LE(message.serverTime, 4);
  return body;
}

export function decodeAdjustTimeStampSuccess(body) {
  requireBody(
    body,
    ADJUST_TIME_STAMP_SUCCESS_LENGTH,
    "ADJUST_TIME_STAMP_SUCCESS_LENGTH",
    "AdjustTimeStamp success",
  );
  return {
    type: "AdjustTimeStampSuccess",
    sentClientTime: body.readUInt32BE(0),
    serverTime: body.readBigUInt64LE(4),
  };
}
