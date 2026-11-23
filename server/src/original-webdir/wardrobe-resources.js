import {createHash} from 'node:crypto';
import {crc32,inflateSync,deflateSync} from 'node:zlib';
import {inspectImage} from './wearable-image.js';
import {readFileSync} from 'node:fs';

const fail=code=>{throw new TypeError('WARDROBE_'+code);};
const chunk=(type,data)=>{
  const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);
  out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;
};
const paeth=(a,b,c)=>{
  const p=a+b-c,x=Math.abs(p-a),y=Math.abs(p-b),z=Math.abs(p-c);
  return x<=y&&x<=z?a:y<=z?b:c;
};

// The approved local catalogue has no historical icon binding. Its equipment
// icon is the same first 120x120 sequence tile used by the market thumbnail.
// Decode only that tile, preserve palette/alpha, and never resize the sheet.
export function wardrobeFirstTile(source){
  if(inspectImage(source).type!=='image/png'||source.readUInt32BE(16)!==720||source.readUInt32BE(20)!==960
    ||source[28]!==0)fail('ICON_SOURCE_INVALID');
  const depth=source[24],colour=source[25],channels={0:1,2:3,3:1,4:2,6:4}[colour];
  const bits=depth*channels,stride=720*bits/8,tileStride=120*bits/8,bpp=Math.max(1,bits/8);
  if(!Number.isInteger(stride)||!Number.isInteger(tileStride)||!Number.isInteger(bpp))fail('ICON_DEPTH_INVALID');
  const idat=[],extras=[];let header;
  for(let p=8;p<source.length;){
    const length=source.readUInt32BE(p),type=source.toString('ascii',p+4,p+8),data=source.subarray(p+8,p+8+length);
    if(type==='IHDR')header=Buffer.from(data);
    else if(type==='IDAT')idat.push(data);
    else if(['PLTE','tRNS','gAMA','sRGB','cHRM'].includes(type))extras.push(chunk(type,data));
    p+=length+12;
  }
  const size=(stride+1)*960;
  const raw=inflateSync(Buffer.concat(idat),{maxOutputLength:size});
  if(raw.length!==size)fail('ICON_STREAM_INVALID');
  // Also reject an invalid filter in an unrendered row.
  for(let y=0;y<960;y++)if(raw[y*(stride+1)]>4)fail('ICON_FILTER_INVALID');
  const output=Buffer.alloc((tileStride+1)*120);let previous=Buffer.alloc(tileStride);
  for(let y=0;y<120;y++){
    const row=Buffer.alloc(tileStride),start=y*(stride+1),filter=raw[start];
    for(let x=0;x<tileStride;x++){
      const left=x>=bpp?row[x-bpp]:0,up=previous[x],corner=x>=bpp?previous[x-bpp]:0;
      const predictor=filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):paeth(left,up,corner);
      row[x]=(raw[start+x+1]+predictor)&255;
    }
    row.copy(output,y*(tileStride+1)+1);previous=row;
  }
  header.writeUInt32BE(120,0);header.writeUInt32BE(120,4);
  return Buffer.concat([source.subarray(0,8),chunk('IHDR',header),...extras,chunk('IDAT',deflateSync(output)),chunk('IEND',Buffer.alloc(0))]);
}

// Only enabled with the approved wardrobe catalogue. Native downloads use the
// installed ReleaseA address; the older preview uses /avatar/seat/id.png.
// Both are finite projections of already verified catalogue assets.
export function createWardrobeResources({configuration,resources,authority}){
  if(!Array.isArray(configuration?.items)||configuration.items.length>4096||typeof resources?.resolve!=='function'
    ||typeof authority!=='string')fail('RESOURCES_INVALID');
  const native=new Map(),icons=new Map(),preview=new Map(),portraits=new Map();
  for(const item of configuration.items){
    const source=resources.resolve(authority,item.sequenceTarget);
    if(source?.contentType!=='image/png'||!Buffer.isBuffer(source.body)
      ||createHash('sha256').update(source.body).digest('hex')!==item.sha256)fail('RESOURCE_MISMATCH');
    const seat=String(item.seat).padStart(3,'0'),rid=String(item.resourceId).padStart(5,'0');
    if(!Number.isInteger(item.seat)||item.seat<1||item.seat>9||!Number.isInteger(item.resourceId)||item.resourceId<1||item.resourceId>65535
      ||item.sequenceTarget!==`/NewQQPet/common/petsoc/Data/res/Avatar/${seat}/${seat}${rid}.png`)fail('RESOURCE_MISMATCH');
    const path=item.sequenceTarget.replace('/NewQQPet/','/QQPenguin/ReleaseA/').toLowerCase();
    const icon=`/avatar/${item.seat}/${item.resourceId}.png`;
    if(native.has(path)||icons.has(icon))fail('RESOURCE_DUPLICATE');
    let explicit=null;
    if(item.iconFile){const body=readFileSync(new URL('../../'+item.iconFile.slice('server/'.length),import.meta.url));
      if(inspectImage(body).type!=='image/png'||createHash('sha256').update(body).digest('hex')!==item.iconSha256)fail('ICON_MISMATCH');
      explicit={body,contentType:'image/png'};}
    native.set(path,source);icons.set(icon,{source,resource:explicit});
    portraits.set(`/petinfo-avatar/${item.seat}/${item.resourceId}.png`,{source,resource:null});
    preview.set(`/common/market/avatar/${item.seat}/${item.resourceId}.png`,source);
  }
  return {resolve(host,target){
    if(typeof target!=='string'||target.length>1024)return null;
    const existing=resources.resolve(host,target);if(existing)return existing;
    if(host==='web.pet.qq.com')return preview.get(target)??null;
    if(host===authority){const found=native.get(target.replaceAll('\\','/').toLowerCase());if(found)return found;}
    if(host!==authority&&host!=='img.pet.qq.com')return null;
    const icon=portraits.get(target)??icons.get(target);if(!icon)return null;
    icon.resource??={body:wardrobeFirstTile(icon.source.body),contentType:'image/png'};
    return icon.resource;
  }};
}
