// PetCommunity_20110324_142640: 10A00/10AD0, 18D80/18E30,
// 1B190/1B240, 33220/333C0 and 119B0/11A80. Raw64 remains opaque.
const word=v=>{if(!Number.isInteger(v)||v<0||v>65535)throw new TypeError('INVALID_LEGACY_COMMUNITY_WIRE');const b=Buffer.alloc(2);b.writeUInt16BE(v);return b;};
export function decodeLegacyCommunityRequest(command,body){
  if(!Buffer.isBuffer(body))throw new TypeError('INVALID_LEGACY_COMMUNITY_WIRE');
  if([0x1102,0x1103,0x110a].includes(command)&&body.length===2)return {value:body.readUInt16BE()};
  if(command===0x1108&&body.length===1)return {reason:body[0]};
  if(command===0x1104&&body.length>=13&&body[12]<=10&&body.length===13+4*body[12])
    return {x:body.readUInt16BE(),y:body.readUInt16BE(2),opaque:body.subarray(4,12),
      path:Array.from({length:body[12]},(_,i)=>({x:body.readUInt16BE(13+4*i),y:body.readUInt16BE(15+4*i)}))};
  throw new TypeError('INVALID_LEGACY_COMMUNITY_WIRE');
}
export function encodeLegacyCommunityResult(command,{code=0,message=Buffer.alloc(0),zone=0,area=0,scene=0,direction=0,x=0,y=0}={}){
  if(!Number.isInteger(code)||code<0||code>0xffffffff||!Buffer.isBuffer(message)||message.length>1024)
    throw new TypeError('INVALID_LEGACY_COMMUNITY_WIRE');
  const result=Buffer.alloc(4);result.writeUInt32BE(code);
  const parts=[result,word(message.length),message,word(0)];
  if(code===0&&command===0x1102)parts.push(...[zone,area,scene,direction,x,y].map(word));
  else if(code===0&&[0x1103,0x110a].includes(command))parts.push(...[scene,direction,x,y].map(word));
  else if(![0x1102,0x1103,0x110a,0x1104,0x1108].includes(command))throw new TypeError('INVALID_LEGACY_COMMUNITY_WIRE');
  return Buffer.concat(parts);
}
