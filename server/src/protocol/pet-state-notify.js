import {encodeLoginSuccess} from './login.js';

// E-105 BasicProtocol 1150/189B0 and BODU 1F90/20D0. No synthetic fields
// replace known Login values; the unconsumed leading byte is explicit policy.
export function encodeAttributeChangeNotify(login,unknownByte) {
  if(!Number.isInteger(unknownByte)||unknownByte<0||unknownByte>255)throw new TypeError('INVALID_NOTIFY_BYTE');
  const b=encodeLoginSuccess(login),out=Buffer.alloc(24);out[0]=unknownByte;
  b.copy(out,1,61,63); // level
  b.copy(out,3,67,80); // age, hunger, clean, health, size, mood
  b.copy(out,16,97,101); // growth
  b.copy(out,20,103,107); // yuanbao
  return out;
}
export function encodeStatusChangeNotify(login,unknownByte) {
  const b=encodeLoginSuccess(login),attributes=encodeAttributeChangeNotify(login,unknownByte),out=Buffer.alloc(42);
  out[0]=unknownByte;
  b.copy(out,1,39,63); // status, 16 byte description, time, level
  attributes.copy(out,25,3,20); // age through growth
  return out;
}
// The original rename push. BasicProtocol CNickNameChangeNotify::OnReceivePackage (module
// BasicProtocol_20130829_103456.dll, protocol id 0x0552 read at `66 81 7c 24 44 52 05` in RVA
// 0x10016FCF) decodes two fixed strings of sixteen wire bytes each into two 17-byte buffers, and
// BasicOnlineDataUpdate 0x10002220 (INickNameChangeNotifyEvent sink, vtable offset 0x4C) writes
// them to DCN_STR_PETNICKNAME (17) and DCN_STR_PETMASTERNICKNAME (a3+17, 17). The bytes are the
// same GBK fields LoginSuccess carries, so the body is exactly those two fields in that order:
// 32 bytes and no result word.
export function encodeNickNameChangeNotify(profile) {
  const b=encodeLoginSuccess(profile.login),out=Buffer.alloc(32);
  b.copy(out,0,4,20); // petName
  b.copy(out,16,20,36); // masterName
  return out;
}
export function decodeEnterNormalStatus(body) {
  if(!Buffer.isBuffer(body)||body.length!==2)throw new TypeError('NORMAL_STATUS_LENGTH');
  const status=body.readUInt16BE();
  // BasicProtocol 7800 writes a BE16 word. StateSystem 32E7/351F forwards
  // its current native status, including idle and non-work states. Whether
  // that state can be stopped belongs to the domain response, not framing.
  return {status};
}
export function encodeEnterNormalStatusResult(success) {
  // BasicProtocol 7560: success BE16 zero; failure code + BE16 text length.
  return success?Buffer.from([0,0]):Buffer.from([0,1,0,0]);
}
