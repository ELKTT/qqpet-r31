import {createHash} from 'node:crypto';

// FriendList c4925d2f…: C5A0/C300 (0701), 121A0/11F40 (0950),
// 12EE0 (0951 push), 11280/110F0 (0955). QWORDs are raw little-endian;
// DWORDs and WORDs use BaseComponent's network-order scalar methods.
export const COMMUNITY_FRIEND_COMMANDS=Object.freeze([0x0701,0x0950,0x0952,0x0954,0x0955,0x0956,0x0957]);
const bad=()=>{throw new TypeError('INVALID_COMMUNITY_FRIEND_WIRE');};
const word=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const dword=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
export function decodeCommunityFriendRequest(command,body,actorId) {
  if(!Buffer.isBuffer(body)||!Buffer.isBuffer(actorId)||actorId.length!==8||actorId.readBigUInt64LE()===0n)bad();
  if(command===0x0701&&body.length===16&&body.subarray(0,8).equals(actorId)&&body.subarray(8).equals(actorId))return {};
  if(command===0x0950&&body.length===4)return {revision:body.readUInt32BE()};
  if(command===0x0955&&body.length===0)return {};
  if(command===0x0952&&body.length===4)return {uin:body.readUInt32BE()};
  if([0x0954,0x0956].includes(command)&&body.length===8)return {target:Buffer.from(body)};
  if(command===0x0957&&body.length===10&&[1,2,3].includes(body.readUInt16BE()))return {decision:body.readUInt16BE(),target:Buffer.from(body.subarray(2))};
  bad();
}
export function projectCommunityFriends(command,request,actorId,rows) {
  if(!COMMUNITY_FRIEND_COMMANDS.includes(command)||!Buffer.isBuffer(actorId)||actorId.length!==8
    ||!Array.isArray(rows)||rows.length>500)bad();
  const ids=new Set();
  for(const r of rows) {
    if(!Number.isInteger(r.uin)||r.uin<1||r.uin>0xffffffff||!Buffer.isBuffer(r.id)||r.id.length!==8
      ||r.id.readBigUInt64LE()===0n||r.id.equals(actorId)||ids.has(r.id.toString('hex'))
      ||!['petName','ownerName'].every(k=>Buffer.isBuffer(r[k])&&r[k].length===16)
      ||typeof r.online!=='boolean'||!Number.isInteger(r.vip)||r.vip<0||r.vip>255
      ||!Number.isInteger(r.level)||r.level<0||r.level>65535)bad();
    ids.add(r.id.toString('hex'));
  }
  const details=rows.map(r=>Buffer.concat([r.id,r.petName,r.ownerName,word(r.vip),dword(r.level)]));
  const revision=createHash('sha256').update(Buffer.concat(rows.map((r,i)=>Buffer.concat([
    dword(r.uin),details[i],Buffer.from([Number(r.online)])])))).digest().readUInt32BE()||1;
  if(command===0x0955)return [{command,body:Buffer.concat([word(0),dword(300)])}];
  if(command===0x0701) {
    // This older QQ-contact view has a 12-byte nickname field. Do not split a
    // multibyte name: its original narrow converter accepts a zero terminator.
    const nickname=r=>{const b=Buffer.from(r.ownerName.subarray(0,12));
      try{new TextDecoder('gb18030',{fatal:true}).decode(b);}catch{b[11]=0;}return b;};
    return [{command,body:Buffer.concat([actorId,word(rows.length),...rows.map(r=>Buffer.concat([
      dword(r.uin),r.id,Buffer.from([Number(r.online),r.vip]),nickname(r),Buffer.from([0])]))])}];
  }
  if(!Number.isInteger(request?.revision)||request.revision<0||request.revision>0xffffffff)bad();
  // An unchanged 0950 updates the cache but does not complete an open native
  // friend dialog. Always send both complete 0951 groups, including empty ones.
  const list=request.revision===revision
    ? Buffer.concat([word(0),dword(revision),word(0xffff)])
    : Buffer.concat([word(0),dword(revision),word(rows.length*8),...rows.map(r=>r.id)]);
  return [{command,body:list},
    ...[false,true].map(online=>({command:0x0951,body:Buffer.concat([word(0),dword(revision),word(1),word(0),
      Buffer.from([Number(online)]),word(rows.filter(r=>r.online===online).length),
      ...details.filter((_,i)=>rows[i].online===online)])}))];
}
