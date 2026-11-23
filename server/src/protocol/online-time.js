// E-089: FeedLogic 12810 -> 8410 -> D480, BaseComponent DecodeInt32 2370.
// Wire contract only. No server clock, account policy, or implicit state defaults.
export const ONLINE_TIME_COMMAND_ID = 0x2216;
export const ONLINE_TIME_RESPONSE_LENGTH = 12;

export class OnlineTimeProtocolError extends Error {
  constructor(code) {
    super(code);
    this.name = "OnlineTimeProtocolError";
    this.code = code;
  }
}

function requireBody(body, length, code) {
  if (!Buffer.isBuffer(body) || body.length !== length) throw new OnlineTimeProtocolError(code);
}

function requireSeconds(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new OnlineTimeProtocolError("INVALID_ONLINE_TIME_RESPONSE");
  }
}

export function decodeOnlineTimeRequest(body) {
  requireBody(body, 0, "ONLINE_TIME_REQUEST_LENGTH");
  return { type: "OnlineTimeRequest" };
}

export function encodeOnlineTimeResponse(message) {
  if (message?.type !== "OnlineTimeResponse") throw new OnlineTimeProtocolError("INVALID_ONLINE_TIME_RESPONSE");
  requireSeconds(message.dayClockUnixSeconds);
  requireSeconds(message.onlineSeconds);
  requireBody(message.unknown_0x04, 4, "INVALID_ONLINE_TIME_RESPONSE");
  const body = Buffer.alloc(ONLINE_TIME_RESPONSE_LENGTH);
  body.writeUInt32BE(message.dayClockUnixSeconds, 0);
  message.unknown_0x04.copy(body, 4);
  body.writeUInt32BE(message.onlineSeconds, 8);
  return body;
}

export function decodeOnlineTimeResponse(body) {
  requireBody(body, ONLINE_TIME_RESPONSE_LENGTH, "ONLINE_TIME_RESPONSE_LENGTH");
  return {
    type: "OnlineTimeResponse",
    dayClockUnixSeconds: body.readUInt32BE(0),
    unknown_0x04: Buffer.from(body.subarray(4, 8)),
    onlineSeconds: body.readUInt32BE(8),
  };
}
