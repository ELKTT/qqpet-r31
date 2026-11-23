// HomeSystem SHA39c4e8e8..., RVAs 1FE70/200B0, 240F0/242F0,
// 24C20/24E40 and 253D0. BaseComponent SHAc1967ba8... uses BE16/32
// but copies the eight-byte identifiers verbatim (2FF0/23B0).
export const HOME_COMMANDS = Object.freeze({configure:0x0a01,current:0x0a02,move:0x0a03,visit:0x0a05,invite:0x0a06,invited:0x0a07,leave:0x0a08,kick:0x0a0a,scene:0x0a21,positions:0x0a22});
const uint=(v,max)=>Number.isInteger(v)&&v>=0&&v<=max;
const bad=()=>{throw new TypeError('LEGACY_HOME_INVALID_WIRE');};
function raw(v,n){if(!Buffer.isBuffer(v)||v.length!==n)bad();return v;}
function u16(v){if(!uint(v,65535))bad();const b=Buffer.alloc(2);b.writeUInt16BE(v);return b;}
function u32(v){if(!uint(v,0xffffffff))bad();const b=Buffer.alloc(4);b.writeUInt32BE(v);return b;}
function text(v=Buffer.alloc(0)){if(!Buffer.isBuffer(v)||v.length>1024)bad();return Buffer.concat([u16(v.length),v]);}
function result(code,message,desktop){return Buffer.concat([u32(code),text(message),text(desktop)]);}
export function decodeHomeRequest(command,body){
  if(!Buffer.isBuffer(body))bad();
  const length=[HOME_COMMANDS.current,HOME_COMMANDS.leave].includes(command)?8:command===HOME_COMMANDS.move?12:[HOME_COMMANDS.visit,HOME_COMMANDS.invite,HOME_COMMANDS.kick,HOME_COMMANDS.configure].includes(command)?16:0;
  if(length===0||body.length!==length)bad();
  if([HOME_COMMANDS.visit,HOME_COMMANDS.invite,HOME_COMMANDS.kick].includes(command))return {source:Buffer.from(body.subarray(0,8)),target:Buffer.from(body.subarray(8))};
  if(command===HOME_COMMANDS.configure)return {host:Buffer.from(body.subarray(0,8)),goods:Buffer.from(body.subarray(8))};
  if(command===HOME_COMMANDS.move)return {host:Buffer.from(body.subarray(0,8)),x:body.readUInt16BE(8),y:body.readUInt16BE(10)};
  return {[command===HOME_COMMANDS.leave?'host':'pet']:Buffer.from(body)};
}
export function encodeHomeVisit({code=0,message,desktop,opaque=Buffer.alloc(8)}={}){
  return Buffer.concat([result(code,message,desktop),raw(opaque,8)]);
}
export function encodeHomeCurrent({code=0,message,desktop}={}){return result(code,message,desktop);}
// HomeSystem 23B70 accepts A07/A25: raw inviter64 + two BE16 strings;
// A07 selects the game invitation dialog (2C420 -> 10960 -> 10720, type 4,
// original Accept/Reject buttons). A25 is a separately gated announcement.
export function encodeHomeInvitation({host,title,description}){
 return Buffer.concat([raw(host,8),text(title),text(description)]);
}
export function encodeHomeConfigure({code=0,message,desktop,goods=Buffer.alloc(8),resource=0,
  name=Buffer.alloc(32),level=0,maxPets=0,states=[]}={}){
  if(!Array.isArray(states)||states.length>32)bad();
  return Buffer.concat([result(code,message,desktop),raw(goods,8),u32(resource),raw(name,32),
    u32(level),u32(maxPets),u32(states.length),...states.flatMap(s=>[u16(s.id),raw(s.name,32),raw(s.description,32)])]);
}
export function encodeHomeScene({host=Buffer.alloc(8),name=Buffer.alloc(16),target=Buffer.alloc(8),resource=0,
  goods=Buffer.alloc(8),peers=[]}={}){
  if(!Array.isArray(peers)||peers.length>50)bad();
  // Decoder writes the first WORD to native peer+10 (level), then peer+8
  // (state), then peer+12 (information version); serializer 2A300 names them.
  // 253D0 places the first raw64 after name at scene+56 (configuration key),
  // and the raw64 after resource at scene+48 (target pet). 2A690 forwards
  // scene+56 to 2E500/A01; swapping these fields leaves the title uninitialized.
  return Buffer.concat([raw(host,8),raw(name,16),raw(goods,8),u32(resource),raw(target,8),u32(peers.length),
    ...peers.flatMap(p=>[raw(p.pet,8),u16(p.level),u16(p.state),u16(p.informationVersion),u16(p.x),u16(p.y)])]);
}
// 22450 is the active HOME.MoveTo sender; the separate ReportPos sender 21530
// has wider coordinates and is not registered by that Flash API. 22660 consumes
// A22, and 2AD90 updates the native scene list and the Flash layout event.
export function encodeHomePositions({host=Buffer.alloc(8),peers=[]}={}){
  if(!Array.isArray(peers)||peers.length>50)bad();
  return Buffer.concat([raw(host,8),u32(peers.length),...peers.flatMap(p=>[raw(p.pet,8),u16(p.x),u16(p.y)])]);
}
