import {inflateSync,deflateSync} from 'node:zlib';
const need=ok=>{if(!ok)throw Error('SWF_STRING_LAYOUT_INVALID');};
const encoded=n=>{const a=[];do{const b=n&127;n>>>=7;a.push(b|(n?128:0));}while(n);return Buffer.from(a);};

// Bounded structural edits of registered URL constants; executable ABC bytes stay unchanged.
export function swfStructure(raw){
  need(Buffer.isBuffer(raw)&&raw.length>=12&&['CWS','FWS'].includes(raw.toString('ascii',0,3)));
  const length=raw.readUInt32LE(4);need(length>=12&&length<=16*1024*1024);
  const body=raw.toString('ascii',0,3)==='CWS'?inflateSync(raw.subarray(8),{maxOutputLength:16*1024*1024}):raw.subarray(8);
  need(body.length===length-8);let p=Math.ceil((5+4*(body[0]>>>3))/8)+4;
  const tags=[];let ended=false;
  while(p<body.length){
    need(p+2<=body.length);const start=p,h=body.readUInt16LE(p);p+=2;let size=h&63;
    if(size===63){need(p+4<=body.length);size=body.readUInt32LE(p);p+=4;}
    need(p+size<=body.length);tags.push({code:h>>>6,start,payload:p,end:p+size});p+=size;
    if((h>>>6)===0){ended=true;break;}
  }
  need(ended);return {body,tags,abcs:tags.filter(t=>t.code===82)};
}
export function swfLayout(raw,{abcOrdinal}={}){
  const {body,tags,abcs}=swfStructure(raw);let p;
  need(abcs.length>0&& (abcOrdinal===undefined?abcs.length===1:Number.isInteger(abcOrdinal)&&abcOrdinal>=0&&abcOrdinal<abcs.length));
  const tag=abcs[abcOrdinal??0],zero=body.indexOf(0,tag.payload+4);need(zero>=tag.payload+4&&zero<tag.end);
  const abcStart=zero+1,abc=body.subarray(abcStart,tag.end);p=4;need(abc.length>=4);
  function variable(){let value=0;for(let i=0;i<5;i++){need(p<abc.length);const b=abc[p++];if(i===4)need(b<=15);value+=(b&127)*2**(7*i);if(!(b&128))return value;}need(false);}
  for(let pool=0;pool<2;pool++){const count=variable();need(count<=abc.length);for(let i=1;i<count;i++)variable();}
  const doubles=variable();p+=Math.max(0,doubles-1)*8;need(p<=abc.length);
  const count=variable();need(count<=abc.length);const strings=[];
  for(let index=1;index<count;index++){const start=p,n=variable();need(n<=abc.length-p);const bytes=abc.subarray(p,p+n);p+=n;strings.push({index,start,end:p,bytes});}
  return {body,tags,tag,abcStart,abc,strings,poolEnd:p,abcCount:abcs.length};
}
export function replaceSwfStrings(source,replacements,options={}){
  const a=swfLayout(source,options),changes=[];
  const chunks=[];let cursor=0;
  for(const s of a.strings){
    if(!replacements.has(s.index))continue;
    const {before,after}=replacements.get(s.index);need(s.bytes.equals(Buffer.from(before)));
    const bytes=Buffer.from(after);
    chunks.push(a.abc.subarray(cursor,s.start),encoded(bytes.length),bytes);cursor=s.end;
    changes.push({poolIndex:s.index,before,after,abcOffset:s.start});
  }
  need(changes.length===replacements.size);chunks.push(a.abc.subarray(cursor));const abc=Buffer.concat(chunks);
  const payload=Buffer.concat([a.body.subarray(a.tag.payload,a.abcStart),abc]);
  const tagHeader=Buffer.alloc(6);tagHeader.writeUInt16LE((82<<6)|63);tagHeader.writeUInt32LE(payload.length,2);
  const body=Buffer.concat([a.body.subarray(0,a.tag.start),tagHeader,payload,a.body.subarray(a.tag.end)]);
  const header=Buffer.from(source.subarray(0,8));header.write('CWS',0,'ascii');header.writeUInt32LE(body.length+8,4);
  const output=Buffer.concat([header,deflateSync(body)]),b=swfLayout(output,options);
  need(a.tags.length===b.tags.length&&a.strings.length===b.strings.length&&a.abc.subarray(a.poolEnd).equals(b.abc.subarray(b.poolEnd)));
  for(let i=0;i<a.strings.length;i++)if(!replacements.has(a.strings[i].index))need(a.strings[i].bytes.equals(b.strings[i].bytes));
  for(let i=0;i<a.tags.length;i++)if(a.tags[i]!==a.tag)need(a.body.subarray(a.tags[i].start,a.tags[i].end).equals(b.body.subarray(b.tags[i].start,b.tags[i].end)));
  return {output,changes};
}

