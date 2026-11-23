// E-094: TickleSystem 1390 writes three chars via BaseComponent 2FC0.
// 11F0 reads a BE16 result; a nonzero result completes with no reward deltas.
export const SPECIAL_INTERACT_COMMAND_ID = 0x053b;
export function decodeSpecialInteractRequest(body) {
  if (!Buffer.isBuffer(body) || body.length !== 3 || body[0] !== 1) {
    throw Object.assign(new Error('SPECIAL_INTERACT_REQUEST_SHAPE'), {code:'SPECIAL_INTERACT_REQUEST_SHAPE'});
  }
  return {count:1,actionType:body[1],countByte:body[2]};
}
export function encodeSpecialInteractFailure(result) {
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new TypeError('INVALID_SPECIAL_INTERACTION_FAILURE');
  const body=Buffer.alloc(2);body.writeUInt16BE(result);return body;
}
// TickleSystem 12CC/12DE -> 8280: signed BE16 mood and BE32 currency delta.
export function encodeSpecialInteractSuccess(moodDelta,moneyDelta=0) {
  if(!Number.isInteger(moodDelta)||moodDelta< -32768||moodDelta>32767
    ||!Number.isInteger(moneyDelta)||moneyDelta<0||moneyDelta>0xffffffff)
    throw new TypeError('INVALID_SPECIAL_INTERACTION_SUCCESS');
  const body=Buffer.alloc(8);body.writeInt16BE(moodDelta,2);body.writeUInt32BE(moneyDelta,4);return body;
}
