import {inflateRawSync,deflateRawSync} from 'node:zlib';
import {need,relative} from './common.mjs';
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let value=0xffffffff;for(const b of bytes)value=table[(value^b)&255]^(value>>>8);return (value^0xffffffff)>>>0;}
export function readZip(bytes){
  need(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=256*1024*1024,'COMPLETE_ZIP_SIZE');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  need(end>=0&&bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0,'COMPLETE_ZIP_END');
  const count=bytes.readUInt16LE(end+10);need(count===bytes.readUInt16LE(end+8)&&count<=12000,'COMPLETE_ZIP_ENTRIES');
  let at=bytes.readUInt32LE(end+16),total=0;const limit=at+bytes.readUInt32LE(end+12),files=new Map();need(limit===end,'COMPLETE_ZIP_DIRECTORY');
  for(let i=0;i<count;i++){
    need(at+46<=limit&&bytes.readUInt32LE(at)===0x02014b50,'COMPLETE_ZIP_ENTRY');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),packed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24);
    const n=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
    need(at+46+n+extra+comment<=limit&&!(flags&1)&&[0,8].includes(method)&&size<=32*1024*1024,'COMPLETE_ZIP_ENTRY_SIZE');
    const nameBytes=bytes.subarray(at+46,at+46+n),name=nameBytes.toString(flags&0x800?'utf8':'latin1').replaceAll('\\','/');
    need((bytes.readUInt32LE(at+38)>>>16&0xf000)!==0xa000,'COMPLETE_ZIP_LINK');
    need(local+30<=end&&bytes.readUInt32LE(local)===0x04034b50,'COMPLETE_ZIP_LOCAL');
    const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),start=local+30+localName+localExtra;
    need(localName===n&&bytes.subarray(local+30,local+30+n).equals(nameBytes)&&start+packed<=bytes.readUInt32LE(end+16),'COMPLETE_ZIP_LOCAL_RANGE');
    at+=46+n+extra+comment;
    if(name.endsWith('/')){relative(name.slice(0,-1));continue;}
    relative(name);need(!files.has(name),'COMPLETE_ZIP_DUPLICATE');total+=size;need(total<=128*1024*1024,'COMPLETE_ZIP_TOTAL_SIZE');
    const compressed=bytes.subarray(start,start+packed),body=method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:32*1024*1024});
    need(body.length===size&&crc32(body)===crc,'COMPLETE_ZIP_CRC');files.set(name,body);
  }
  need(at===limit,'COMPLETE_ZIP_DIRECTORY_END');return files;
}
export function writeZip(files){
  const locals=[],central=[];let offset=0;
  for(const [name,body] of [...files].sort(([a],[b])=>a.localeCompare(b,'en'))){
    relative(name);const filename=Buffer.from(name),packed=deflateRawSync(body,{level:9}),crc=crc32(body);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x3c21,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(filename.length,26);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(8,10);directory.writeUInt16LE(0x3c21,14);
    directory.writeUInt32LE(crc,16);directory.writeUInt32LE(packed.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(filename.length,28);directory.writeUInt32LE(0x81a40000,38);directory.writeUInt32LE(offset,42);
    locals.push(header,filename,packed);central.push(directory,filename);offset+=header.length+filename.length+packed.length;
  }
  const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,dir,end]);
}
export function memberTarget(archive,member,names){
  const parent=archive.includes('/')?archive.slice(0,archive.lastIndexOf('/')+1):'';
  const choices=[...new Set([member,parent+member])].filter(n=>names.has(n));need(choices.length<=1,'COMPLETE_ZIP_TARGET_AMBIGUOUS');return choices[0]??null;
}
