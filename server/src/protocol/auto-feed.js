// E-103: BasicProtocol17CB0/17A10, BODU2920, QuickFeed3030, PetInfo.SetBabyStatus.
export const AUTO_FEED_COMMAND_ID=0x0537;
export function decodeAutoFeedRequest(body) {
  if(!Buffer.isBuffer(body)||body.length!==2||body.readUInt16BE(0)>1)
    throw new TypeError('INVALID_AUTO_FEED_REQUEST');
  return {enabled:body.readUInt16BE(0)===1};
}
export function encodeAutoFeedSuccess(enabled) {
  if(typeof enabled!=='boolean')throw new TypeError('INVALID_AUTO_FEED_STATE');
  const body=Buffer.alloc(4);body.writeUInt16BE(Number(enabled),2);return body;
}
