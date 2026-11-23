// BasicProtocol SHA48ae0360..., RVA A940/A530; InteractSystem RVA 37C0/6540.
export const OTHER_PET_INFO_COMMAND_ID=0x053d;
const uint=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max;
export function decodeOtherPetInfoRequest(body) {
  if(!Buffer.isBuffer(body)||body.length!==10)throw new TypeError('OTHER_PET_INFO_REQUEST_LENGTH');
  const petId=body.readBigUInt64LE(),option=body.readUInt16BE(8);
  if(petId===0n||option!==1)throw new TypeError('OTHER_PET_INFO_REQUEST_INVALID');
  return {petId,option};
}
export function encodeOtherPetInfoFailure() {
  // A530 accepts result != 0 and a length-prefixed narrow message. No identity echoed.
  return Buffer.from([0,1,0,0]);
}
export function encodeOtherPetInfoSuccess(profile,love={value:0,level:0}) {
  const p=profile?.login;
  if(!Buffer.isBuffer(profile?.petIdBytes)||profile.petIdBytes.length!==8||profile.petIdBytes.readBigUInt64LE()===0n
      ||!p||!Buffer.isBuffer(p.petName)||p.petName.length!==16||!Buffer.isBuffer(p.masterName)||p.masterName.length!==16||!uint(p.levelValue,65535)
      ||!['unknown_0x47','unknown_0x49','unknown_0x4b','unknown_0x4e'].every(k=>uint(p[k],65535))
      ||!uint(p.vipFlag,255)||!uint(p.unknown_0x65,127)||!uint(p.unknown_0x66,255)
      ||!uint(love?.value,65535)||!uint(love?.level,65535))
    throw new TypeError('INVALID_OTHER_PET_INFO_RESPONSE');
  const body=Buffer.alloc(59);
  profile.petIdBytes.copy(body,2);body.writeUInt16BE(p.levelValue,10);
  // Keep the original pet nickname and owner title distinct.
  p.petName.copy(body,12);p.masterName.copy(body,28);
  ['unknown_0x47','unknown_0x49','unknown_0x4b','unknown_0x4e'].forEach((k,i)=>body.writeUInt16BE(p[k],44+i*2));
  body.writeUInt16BE(love.value,52);body.writeUInt16BE(love.level,54);
  body[56]=p.vipFlag;body[57]=p.unknown_0x65;body[58]=p.unknown_0x66;
  return body;
}
