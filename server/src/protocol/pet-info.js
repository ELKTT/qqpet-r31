import {encodeLoginSuccess} from './login.js';

export const PET_INFO_COMMAND_ID=0x0532;
export const PET_INFO_SUCCESS_LENGTH=115;

export function decodePetInfoRequest(body) {
  if(!Buffer.isBuffer(body)||body.length!==8)throw new TypeError('PET_INFO_REQUEST_LENGTH');
  return {petId:body.readBigUInt64LE()};
}

// E-099: original 0532 response, with an explicit empty growth-description list.
// Shared fields retain the validated Login representation; no unknown word is invented.
export function encodePetInfoSuccess(profile,growthSpeed) {
  if(!Buffer.isBuffer(profile?.petIdBytes)||profile.petIdBytes.length!==8
      ||!Number.isInteger(growthSpeed)||growthSpeed<0||growthSpeed>0x7fffffff)throw new TypeError('INVALID_PET_INFO_RESPONSE');
  const login=encodeLoginSuccess(profile.login),body=Buffer.alloc(PET_INFO_SUCCESS_LENGTH);
  // BaseComponent 2FF0/23B0 copy Int64 unchanged; only 16/32-bit fields swap.
  profile.petIdBytes.copy(body,2);
  login.copy(body,10,4,94); // names through configVersion
  body.writeUInt32BE(growthSpeed,100);
  body[104]=0; // no optional growth modifiers configured
  login.copy(body,105,97,107); // growth, VIP level/year, yuanbao
  return body;
}
