// E-098: BasicProtocol 13AC0 / 136E0, OnlineManager 8120 / D420.
export const LOGOUT_COMMAND_ID = 0x0531;
// OnlineManager 7C80/7CE0 PauseGrowth; type0 is the terminal Logout path.
export const PAUSE_GROWTH_LOGOUT_REASON = 1;

export function decodeLogoutRequest(body) {
  if (!Buffer.isBuffer(body) || body.length !== 2) throw new TypeError('INVALID_LOGOUT_REQUEST');
  return { type: 'LogoutRequest', reason: body.readUInt16BE(0) };
}

// Native empty-speech/empty-URL branch. The legacy configuration spelling stays
// compatible. Static follow-up: this word reaches ActionInfo MAIN (+8), with
// local 202 in SUB (+0x244). Root may replace it with a catalogued exit action.
export function encodeLogoutSuccess(reason, profile) {
  if (!Number.isInteger(reason) || reason < 0 || reason > 0xffff) throw new TypeError('INVALID_LOGOUT_REASON');
  if (!profile || Object.keys(profile).length !== 1 || !/^[0-9a-f]{8}$/i.test(profile.unknownWordHex ?? '')) {
    throw new TypeError('INVALID_LOGOUT_PROFILE');
  }
  const body = Buffer.alloc(12);
  body.writeUInt16BE(reason, 2);
  Buffer.from(profile.unknownWordHex, 'hex').copy(body, 8);
  return body;
}
