import {deflateSync} from 'node:zlib';
import {swfStructure} from './swf-strings.js';
const need=x=>{if(!x)throw Error('AVM1_LAYOUT_INVALID');};
const u16=n=>{need(n>=0&&n<=65535);const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const cend=(b,p)=>{const n=b.indexOf(0,p);need(n>=p);return n+1;};
const cstring=(b,p,rewrite)=>{const end=cend(b,p);return {end,body:Buffer.from(rewrite(b.toString('utf8',p,end-1))+'\0')};};
// Bounded AVM1 constant edits. Branches are relocated to original instruction
// boundaries; nested functions, buttons, sprites and clip actions retain structure.
export function rewriteAvm1Actions(b,rewrite,depth=0){
 need(depth<32);const records=[];let p=0;
 while(p<b.length){const start=p,op=b[p++];let data=Buffer.alloc(0),prefix=0;
  if(op>=128){need(p+2<=b.length);const n=b.readUInt16LE(p);p+=2;need(p+n<=b.length);data=b.subarray(p,p+n);p+=n;prefix=3;}
  let value=data;
  if(op===0x88){need(data.length>=2);let at=2;const pieces=[data.subarray(0,2)];for(let n=0;n<data.readUInt16LE(0);n++){const s=cstring(data,at,rewrite);at=s.end;pieces.push(s.body);}need(at===data.length);value=Buffer.concat(pieces);}
  else if(op===0x83){const a=cstring(data,0,rewrite),c=cstring(data,a.end,rewrite);need(c.end===data.length);value=Buffer.concat([a.body,c.body]);}
  else if(op===0x96){let at=0;const pieces=[];while(at<data.length){const t=data[at++];pieces.push(Buffer.from([t]));if(t===0){const s=cstring(data,at,rewrite);at=s.end;pieces.push(s.body);}else{const n=({1:4,2:0,3:0,4:1,5:1,6:8,7:4,8:1,9:2})[t];need(n!==undefined&&at+n<=data.length);pieces.push(data.subarray(at,at+n));at+=n;}}value=Buffer.concat(pieces);}
  else if(op===0x9b||op===0x8e||op===0x94){
   let at=0;if(op!==0x94){at=cend(data,0);need(at+2<=data.length);const count=data.readUInt16LE(at);at+=2;if(op===0x8e)at+=3;for(let i=0;i<count;i++){if(op===0x8e)at++;at=cend(data,at);}}
   need(at+2<=data.length);const n=data.readUInt16LE(at);at+=2;
   // Most assemblers count only the definition header in ActionLength.
   const inside=data.length-at===n;need(inside||data.length===at);need(inside||p+n<=b.length);
   const code=rewriteAvm1Actions(inside?data.subarray(at):b.subarray(p,p+n),rewrite,depth+1);
   value=Buffer.concat([data.subarray(0,at-2),u16(code.length),inside?code:Buffer.alloc(0)]);
   if(!inside){p+=n;records.push({start,end:p,op,value,tail:code,prefix});continue;}
  }
  records.push({start,end:p,op,value,prefix});
 }
 const offsets=new Map();let length=0;for(const r of records){offsets.set(r.start,length);length+=r.prefix?r.prefix+r.value.length+(r.tail?.length??0):1;}offsets.set(b.length,length);
 const out=[];for(const r of records){let value=r.value;if(r.op===0x99||r.op===0x9d){need(value.length===2);const target=r.end+value.readInt16LE(),mapped=offsets.get(target);need(mapped!==undefined);const delta=mapped-(offsets.get(r.start)+5);need(delta>=-32768&&delta<=32767);value=Buffer.alloc(2);value.writeInt16LE(delta);}
  out.push(Buffer.from([r.op]),...(r.prefix?[u16(value.length),value]:[]),...(r.tail?[r.tail]:[]));}
 return Buffer.concat(out);
}
function bitsEnd(b,p,kind){let bit=p*8;const get=n=>{need(bit+n<=b.length*8);let v=0;while(n--)v=v*2+((b[bit>>>3]>>>(7-(bit++&7)))&1);return v;};
 if(kind==='matrix'){if(get(1)){const n=get(5);bit+=n*2;}if(get(1)){const n=get(5);bit+=n*2;}const n=get(5);bit+=n*2;}
 else {const add=get(1),mul=get(1),n=get(4);bit+=(add+mul)*n*4;}need(bit<=b.length*8);return Math.ceil(bit/8);}
function clipActions(b,p,rewrite,version){const n=version>=6?4:2;need(p+2+n<=b.length);const chunks=[b.subarray(0,p+2+n)];p+=2+n;
 while(p<b.length){need(p+n<=b.length);const flags=n===4?b.readUInt32LE(p):b.readUInt16LE(p),head=b.subarray(p,p+n);p+=n;if(!flags){chunks.push(head);need(p===b.length);break;}need(p+4<=b.length);const length=b.readUInt32LE(p);p+=4;need(p+length<=b.length);const key=flags&0x20000?1:0,code=rewriteAvm1Actions(b.subarray(p+key,p+length),rewrite);chunks.push(head,u32(code.length+key),b.subarray(p,p+key),code);p+=length;}
 return Buffer.concat(chunks);}
export function projectAvm1Movie(raw,rewrite){
 const {body}=swfStructure(raw),version=raw[3],start=Math.ceil((5+4*(body[0]>>>3))/8)+4;
 function tags(b,depth=0){need(depth<32);let p=0;const result=[];while(p<b.length){need(p+2<=b.length);const h=b.readUInt16LE(p);p+=2;let n=h&63,code=h>>>6;if(n===63){need(p+4<=b.length);n=b.readUInt32LE(p);p+=4;}need(p+n<=b.length);let v=b.subarray(p,p+n);p+=n;
   if(code===12)v=rewriteAvm1Actions(v,rewrite);else if(code===59)v=Buffer.concat([v.subarray(0,2),rewriteAvm1Actions(v.subarray(2),rewrite)]);
   else if(code===39)v=Buffer.concat([v.subarray(0,4),tags(v.subarray(4),depth+1)]);
   else if(code===37){
    // DefineEditText may contain clickable HTML links outside action pools.
    need(v.length>=5);let at=2+Math.ceil((5+4*(v[2]>>>3))/8);need(at+2<=v.length);
    const first=v[at++],second=v[at++];if(first&1)at+=2;if(second&128)at=cend(v,at);
    if(first&1||second&128)at+=2;if(first&4)at+=4;if(first&2)at+=2;if(second&32)at+=9;
    at=cend(v,at);if(first&128){const s=cstring(v,at,rewrite);need(s.end===v.length);v=Buffer.concat([v.subarray(0,at),s.body]);}
   }
   else if(code===34){need(v.length>=5);const offset=v.readUInt16LE(3);if(offset){let at=3+offset;need(at<=v.length);const parts=[v.subarray(0,at)];while(at<v.length){need(at+4<=v.length);const size=v.readUInt16LE(at),end=size?at+size:v.length;need(end<=v.length);const a=rewriteAvm1Actions(v.subarray(at+4,end),rewrite);parts.push(u16(size?a.length+4:0),v.subarray(at+2,at+4),a);at=end;}v=Buffer.concat(parts);}}
   else if(code===26||code===70){const flags=v[0],extra=code===70?v[1]:0;let at=code===70?4:3;if(flags&128){if((extra&8)||((extra&16)&&(flags&2)))at=cend(v,at);if(flags&2)at+=2;if(flags&4)at=bitsEnd(v,at,'matrix');if(flags&8)at=bitsEnd(v,at,'color');if(flags&16)at+=2;if(flags&32)at=cend(v,at);if(flags&64)at+=2;need(!(extra&1));if(extra&2)at++;if(extra&4)at++;v=clipActions(v,at,rewrite,version);}}
   result.push(u16((code<<6)|63),u32(v.length),v);if(code===0){result.push(b.subarray(p));break;}
  }return Buffer.concat(result);}
 const rewritten=Buffer.concat([body.subarray(0,start),tags(body.subarray(start))]);const header=Buffer.from(raw.subarray(0,8));header.write('CWS');header.writeUInt32LE(rewritten.length+8,4);return Buffer.concat([header,deflateSync(rewritten)]);
}
