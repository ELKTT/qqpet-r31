import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../resources/petinfo-portraits/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8'));
const images=new Map(),phases=new Map();
for(const row of manifest.images) {
  if(![102,103,112,113,122,123].includes(row.phase)||phases.has(row.phase)||
    !/^[a-f0-9]{64}$/.test(row.sha256))throw Error('PETINFO_ART_MANIFEST_INVALID');
  const body=readFileSync(new URL(row.sha256+'.png',root));
  if(body.length!==row.bytes||createHash('sha256').update(body).digest('hex')!==row.sha256)throw Error('PETINFO_ART_DRIFT');
  const route='/petinfo-image/'+row.sha256+'.png';images.set(route,body);phases.set(row.phase,route);
}
if(phases.size!==6)throw Error('PETINFO_ART_INCOMPLETE');
export function portraitImage(target) {
  const body=images.get(target);if(!body)throw new TypeError('PETINFO_IMAGE_UNKNOWN');
  return {contentType:'image/png',body:Buffer.from(body)};
}
export function portraitList({sex,level},avatars=[]) {
  if(!['male','female'].includes(sex)||!Number.isInteger(level)||level<0||level>65535)throw new TypeError('PETINFO_APPEARANCE_UNKNOWN');
  // PhaseLogic RVA 14B6 / 1751 / 1798: levels 0..4, 5..9, >=10.
  const phase=(level<5?110:level<10?120:100)+(sex==='male'?2:3);
  const url='http://web.pet.qq.com'+phases.get(phase);
  // avatarpreview.swf: DDOWN UpdateRow; PetInfo m109 sorts @z numerically.
  const z=[0,90,50,40,30,10,-95,100,100,1000],seats=new Set();
  if(!Array.isArray(avatars)||avatars.length>9)throw new TypeError('PETINFO_AVATAR_INVALID');
  const layers=avatars.map(a=>{
    if(!a||!Number.isInteger(a.seat)||a.seat<1||a.seat>9||seats.has(a.seat)
      ||!Number.isInteger(a.resourceId)||a.resourceId<1||a.resourceId>65535)throw new TypeError('PETINFO_AVATAR_INVALID');
    seats.add(a.seat);
    return '<item z="'+z[a.seat]+'" id="http://img.pet.qq.com/petinfo-avatar/'+a.seat+'/'+a.resourceId+'.png"/>';
  }).join('');
  return {contentType:'text/xml; charset=utf-8',body:Buffer.from('<?xml version="1.0" encoding="UTF-8"?><PetShow><item z="0" id="'+url+'"/>'+layers+'</PetShow>')};
}
