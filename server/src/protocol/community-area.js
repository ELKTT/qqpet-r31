// PetCommunity b0d0c4a8: 30430 decodes 1124; 22A40 consumes the delta;
// 27750 publishes the native FriendLogic list. BaseComponent 23B0 copies
// raw 64-bit IDs; 23E0 reads network-order WORDs. No invented fields.
export const COMMUNITY_AREA_COMMAND=0x1124;
export const MAX_AREA_PLAYERS=500; // Native 27750 allocates 500 display records.
const fail=()=>{throw new TypeError('INVALID_COMMUNITY_AREA');};
const word=n=>{if(!Number.isInteger(n)||n<0||n>65535)fail();const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const id=b=>{if(!Buffer.isBuffer(b)||b.length!==8)fail();return b;};
export function encodeCommunityArea({leaves=[],enters=[]}={}){
 if(!Array.isArray(leaves)||!Array.isArray(enters)||leaves.length>MAX_AREA_PLAYERS||enters.length>MAX_AREA_PLAYERS)fail();
 return Buffer.concat([word(leaves.length),...leaves.map(id),word(enters.length),...enters.flatMap(p=>[id(p.petId),word(p.version)])]);
}
export function decodeCommunityArea(b){
 if(!Buffer.isBuffer(b)||b.length<4||b.length>4+18*MAX_AREA_PLAYERS)fail();let p=0;
 const take=n=>{if(p+n>b.length)fail();const v=Buffer.from(b.subarray(p,p+n));p+=n;return v;};
 const count=()=>{const n=take(2).readUInt16BE();if(n>MAX_AREA_PLAYERS)fail();return n;};
 const leaves=Array.from({length:count()},()=>take(8));
 const enters=Array.from({length:count()},()=>({petId:take(8),version:take(2).readUInt16BE()}));
 if(p!==b.length)fail();return {leaves,enters};
}
