// PetCommunity b0d0c4a8: PlayEmotion -> 439F0 (1106: BYTE, BE16),
// 42010 consumes 1123: raw pet64, BYTE, BE16 -> GuestPetPlayEmotion.
export const COMMUNITY_EMOTION=Object.freeze({send:0x1106,receive:0x1123});
export function decodeCommunityEmotion(body){
 if(!Buffer.isBuffer(body)||body.length!==3||body[0]!==0)throw new TypeError('INVALID_COMMUNITY_EMOTION');
 return {type:body[0],face:body.readUInt16BE(1)};
}
export function encodeCommunityEmotion(message,speaker){
 if(!Buffer.isBuffer(speaker)||speaker.length!==8||message?.type!==0||!Number.isInteger(message.face)||message.face<0||message.face>65535)
  throw new TypeError('INVALID_COMMUNITY_EMOTION');
 const b=Buffer.alloc(11);speaker.copy(b);b[8]=message.type;b.writeUInt16BE(message.face,9);return b;
}
