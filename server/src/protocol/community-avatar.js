// BasicProtocol_20130829_103456 SHA 48ae0360...:
// 053A send DFC0 / receive DA40; 0559 receive 1F50.
// PetInfoSystem_20130913_172921 SHA 643a2d06...: 5E00 -> 6000 -> 22A0/2680.
// Codec only. No route, inventory, price, native registration or default opaque values.
export const AVATAR_INFO_COMMAND_ID=0x053a;
export const AVATAR_VERSION_COMMAND_ID=0x0559;
const invalid=()=>{throw new TypeError('AVATAR_INFO_INVALID_WIRE');};
const check=(ok,code='AVATAR_INFO_INVALID_VALUE')=>{if(!ok)throw new TypeError(code);};
const uint=(value,max)=>Number.isInteger(value)&&value>=0&&value<=max;
const bytes=(value,length)=>Buffer.isBuffer(value)&&value.length===length;
const word=value=>{check(uint(value,0xffff));const out=Buffer.alloc(2);out.writeUInt16BE(value);return out;};
function reader(body){
  if(!Buffer.isBuffer(body)||body.length>0xffff)invalid();
  let position=0;
  return {take(size){if(!uint(size,0xffff)||position+size>body.length)invalid();const value=Buffer.from(body.subarray(position,position+size));position+=size;return value;},
    word(){return this.take(2).readUInt16BE();},byte(){return this.take(1)[0];},
    get position(){return position;},end(){if(position!==body.length)invalid();}};
}
export function decodeAvatarInfoRequest(body){
  const input=reader(body),count=input.word();if(count>100||body.length!==2+8*count)invalid();
  return {petIds:Array.from({length:count},()=>input.take(8))};
}
export function encodeAvatarInfoRequest(petIds){
  check(Array.isArray(petIds)&&petIds.length<=100&&petIds.every(id=>bytes(id,8)));
  return Buffer.concat([word(petIds.length),...petIds]);
}
export function decodeAvatarVersion(body){
  if(!bytes(body,2))invalid();return {avatarVersion:body.readUInt16BE()};
}
export function encodeAvatarVersion(avatarVersion){return word(avatarVersion);}

export function decodeAvatarInfoResponse(body){
  const input=reader(body),result=input.word();
  if(result!==0){const length=input.word();if(length>257)invalid();const errorBytes=input.take(length);input.end();return {result,errorBytes};}
  const count=input.word();if(count>10)invalid();
  const records=[];
  for(let i=0;i<count;i++){
    const size=input.word(),end=input.position+size;
    if(size<49||end>body.length)invalid();
    const petIdBytes=input.take(8),petNickBytes=input.take(16),ownerNickBytes=input.take(16);
    const level=input.word(),vipFlag=input.byte(),avatarVersion=input.word(),avatarCount=input.word();
    if(avatarCount>20||size<49+3*avatarCount)invalid();
    const avatars=Array.from({length:avatarCount},()=>({seat:input.byte(),resourceId:input.word()}));
    const titleId=input.word(),recordExtension=input.take(end-input.position);
    records.push({petIdBytes,petNickBytes,ownerNickBytes,level,vipFlag,avatarVersion,avatars,titleId,recordExtension});
  }
  // DA40 reads two further bytes per record after ALL variable records.
  // PetInfoSystem 238E -> 2680/27C0/27D3: viplevel, vipyearflag.
  // Keep the raw-byte codec interface; membership values remain explicit inputs.
  for(const record of records)record.opaqueTailBytes=input.take(2);
  input.end();return {result,records};
}
export function encodeAvatarInfoSuccess(records){
  check(Array.isArray(records)&&records.length<=10);
  const bodies=records.map(record=>{
    check(record&&bytes(record.petIdBytes,8)&&bytes(record.petNickBytes,16)&&bytes(record.ownerNickBytes,16)
      &&uint(record.level,0xffff)&&uint(record.vipFlag,0xff)&&uint(record.avatarVersion,0xffff)&&uint(record.titleId,0xffff)
      &&Array.isArray(record.avatars)&&record.avatars.length<=20&&record.avatars.every(item=>item&&uint(item.seat,0xff)&&uint(item.resourceId,0xffff))
      &&Buffer.isBuffer(record.recordExtension)&&bytes(record.opaqueTailBytes,2),'AVATAR_INFO_RECORD_INVALID');
    const body=Buffer.concat([record.petIdBytes,record.petNickBytes,record.ownerNickBytes,word(record.level),Buffer.from([record.vipFlag]),
      word(record.avatarVersion),word(record.avatars.length),...record.avatars.flatMap(item=>[Buffer.from([item.seat]),word(item.resourceId)]),
      word(record.titleId),record.recordExtension]);
    check(body.length<=0xffff);return Buffer.concat([word(body.length),body]);
  });
  const body=Buffer.concat([word(0),word(records.length),...bodies,...records.map(record=>record.opaqueTailBytes)]);
  check(body.length<=0xffff);return body;
}
