// E-102: FlashAPI 4330/9A10/9B50, fish/farm ProtocolData and ProtocolHead.
export const FLASH_BUSINESS_COMMAND_ID=0x0332;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(v,list)=>object(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k));
const uint=(v,max)=>Number.isSafeInteger(v)&&v>=0&&v<=max;
const fail=()=>{throw new Error('INVALID_FLASH_BUSINESS_REQUEST');};

export function decodeFlashBusinessRequest(body) {
  // PET.SendData always emits an empty extension; do not guess other adapters.
  if(!Buffer.isBuffer(body)||body.length<4||body.length>32770||body.readUInt16BE(0)!==0)fail();
  let packet;
  try {packet=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(2)));}catch{fail();}
  if(!keys(packet,['head','data'])||!keys(packet.head,['ver','game','svr','key','cmd'])||!object(packet.data))fail();
  const h=packet.head;
  if(h.ver!==1||!uint(h.game,65535)||!uint(h.svr,65535)||!uint(h.cmd,65535)
      ||typeof h.key!=='string'||!/^[A-Za-z0-9_-]{0,64}$/.test(h.key))fail();
  if([6,9].includes(h.game)&&[9,10].includes(h.cmd)) {
    const id=packet.data.ullPetID;
    if(!keys(packet.data,['ullPetID'])||typeof id!=='string'||! /^[1-9][0-9]{0,19}$/.test(id)
        ||BigInt(id)>0xffffffffffffffffn)fail();
    return packet;
  }
  if(![6,9].includes(h.game)||![1,2,3,4,5,6,7,8].includes(h.cmd))return packet;
  if(h.cmd===2&&!keys(packet.data,h.game===6?['petid','id','sign']:['petid','idx','sign']))fail();
  if(h.cmd===7&&!(keys(packet.data,['petid'])||keys(packet.data,['petid','id','sign'])))fail();
  if(h.cmd===6&&!keys(packet.data,h.game===6?['petid']:['petid','idx']))fail();
  if(h.cmd===8&&!keys(packet.data,h.game===6?['petid','id']:['petid','idx']))fail();
  // Do not apply one operation's field schema to unsupported business operations.
  if(Object.keys(packet.data).length>8)fail();
  // Transport may carry sign, but it is neither logged, echoed nor persisted.
  for(const [key,value] of Object.entries(packet.data)) {
    if(!['petid','sign','page','fryid','paytype','idx','id'].includes(key))fail();
    if(key==='petid') {if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>0xffffffffffffffffn)fail();}
    else if(key==='sign') {if(typeof value!=='string'||value.length>2048||! /^[\x20-\x7e]*$/.test(value))fail();}
    else if(!uint(value,0x7fffffff))fail();
  }
  if([6,8].includes(h.cmd)&&h.game===9&&!uint(packet.data.idx,8))fail();
  return packet;
}

export function encodeFlashBusinessResponse(head,data) {
  if(!keys(head,['ver','game','svr','key','cmd'])||!object(data))throw new TypeError('INVALID_FLASH_BUSINESS_RESPONSE');
  // ASCII JSON avoids relying on the native bridge's narrow-string code page.
  const json=JSON.stringify({head,back:0,data}).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  if(json.includes(']]>')||json.length>32767)throw new Error('FLASH_BUSINESS_RESPONSE_TOO_LARGE');
  return Buffer.concat([Buffer.alloc(2),Buffer.from(json,'ascii')]);
}
