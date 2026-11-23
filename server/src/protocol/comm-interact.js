// BasicProtocol 4320/4060 and ActionPlayer method376 (E-089/E-090).
export const COMM_INTERACT_COMMAND_ID = 0x053c;
export function decodeCommInteractRequest(body) {
  if (!Buffer.isBuffer(body) || body.length < 5 || body.length !== 5 + body[4] * 2) {
    throw Object.assign(new Error('COMM_INTERACT_REQUEST_LENGTH'), {code:'COMM_INTERACT_REQUEST_LENGTH'});
  }
  return {sequence:body.readUInt32BE(0),items:Array.from({length:body[4]},(_,i)=>({type:body[5+i*2],times:body[6+i*2]}))};
}
export function encodeCommInteractFailure(result) {
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new TypeError('INVALID_INTERACTION_FAILURE');
  const body=Buffer.alloc(2);body.writeUInt16BE(result);return body;
}
// E-102: key 1 is the awarded mood delta; key 2 remains an explicit opaque value.
export function encodeCommInteractSuccess(sequence,moodDelta,unknownKey2) {
  if(!Number.isInteger(sequence)||sequence<0||sequence>0xffffffff
      ||!Number.isInteger(moodDelta)||moodDelta<0||moodDelta>1000
      ||!Number.isInteger(unknownKey2)||unknownKey2<0||unknownKey2>0xffffffff)
    throw new TypeError('INVALID_INTERACTION_SUCCESS');
  const body=Buffer.alloc(17);body.writeUInt32BE(sequence,2);body[6]=2;
  body[7]=1;body.writeUInt32BE(moodDelta,8);body[12]=2;body.writeUInt32BE(unknownKey2,13);return body;
}
