// HomeSystem 39c4e8e8: 21A10 sends A04, 21D80 consumes A23.
// PetCommunity b0d0c4a8: 42B60 sends 1105, 41360 consumes 1122.
const fail=()=>{throw new TypeError('INVALID_SPATIAL_CHAT');};
const id=b=>{if(!Buffer.isBuffer(b)||b.length!==8)fail();return b;};
const text=b=>{if(!Buffer.isBuffer(b)||b.length<1||b.length>1024||b.some(v=>v<32||v===127))fail();return b;};
const size=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
export const SPATIAL_CHAT=Object.freeze({homeSend:0xa04,homeReceive:0xa23,communitySend:0x1105,communityReceive:0x1122});
export function decodeSpatialChat(command,body){
 const home=command===SPATIAL_CHAT.homeSend;if(!home&&command!==SPATIAL_CHAT.communitySend)fail();
 const offset=home?8:0;
 if(!Buffer.isBuffer(body)||body.length<offset+12||body.length>offset+1035)fail();
 const type=body[offset],target=Buffer.from(body.subarray(offset+1,offset+9)),n=body.readUInt16BE(offset+9);
 if(![0,1].includes(type)||body.length!==offset+11+n)fail();
 return {kind:home?'home':'community',host:home?Buffer.from(body.subarray(0,8)):null,type,target,text:Buffer.from(text(body.subarray(offset+11)))};
}
export function encodeSpatialChat(message,speaker){
 const {kind,type,target}=message,body=text(message.text);id(speaker);id(target);if(![0,1].includes(type))fail();
 if(kind==='home')return Buffer.concat([id(message.host),Buffer.from([type]),speaker,size(body.length),body]);
 if(kind==='community')return Buffer.concat([Buffer.from([type]),speaker,size(body.length),body,target,Buffer.from([0])]);
 fail();
}
