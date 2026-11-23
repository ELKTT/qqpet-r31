// PetCommunity b0d0c4a8: 34B60 (1121), 32610 (1120), 20190→26410;
// 231A0 consumes six WORDs as level/state/version/direction/x/y. Identifiers
// and the 1101 time domain are copied raw, the coordinate WORDs are big endian.
export const COMMUNITY_PRESENCE=Object.freeze({region:0x1121,path:0x1120});
const word=n=>{if(!Number.isInteger(n)||n<0||n>65535)throw new TypeError('INVALID_COMMUNITY_PRESENCE');const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const raw=(b,n)=>{if(!Buffer.isBuffer(b)||b.length!==n)throw new TypeError('INVALID_COMMUNITY_PRESENCE');return b;};
const points=p=>{if(!Array.isArray(p)||p.length>10)throw new TypeError('INVALID_COMMUNITY_PATH');return Buffer.concat([Buffer.from([p.length]),...p.flatMap(p=>[word(p.x),word(p.y)])]);};
const stamp=n=>{if(!Number.isSafeInteger(n)||n<0)throw new TypeError('INVALID_COMMUNITY_TIME');const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
export function encodeCommunityRegion({leaves=[],enters=[]}={}) {
  if(!Array.isArray(leaves)||!Array.isArray(enters)||leaves.length>50||enters.length>50)throw new TypeError('INVALID_COMMUNITY_REGION');
  return Buffer.concat([Buffer.from([leaves.length]),...leaves.map(p=>raw(p,8)),Buffer.from([enters.length]),
    ...enters.flatMap(p=>[raw(p.petId,8),...[p.level,p.state??0,p.version??0,p.direction??0,p.x,p.y].map(word),stamp(p.time??0),points(p.path??[])])]);
}
export function encodeCommunityPath({petId,time,x,y,path}) {
  return Buffer.concat([raw(petId,8),stamp(time),word(x),word(y),points(path)]);
}
