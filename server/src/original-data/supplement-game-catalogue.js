import {readFileSync,existsSync} from 'node:fs';
const file=new URL('../../config/supplement-games.json',import.meta.url);
let cached;
export function supplementGameCatalogue(){
 if(cached)return cached;
 if(!existsSync(file))return [];
 const data=JSON.parse(readFileSync(file,'utf8')),ids=new Set();
 if(data.version!==1||!Array.isArray(data.entries)||data.entries.length>100)throw Error('INVALID_GAME_CATALOGUE');
 for(const e of data.entries){
  if(!/^[a-z0-9-]{1,40}$/.test(e.id)||ids.has(e.id)||typeof e.title!=='string'||e.title.length>40
    ||!['desktop','carnival','adventure','room','blocks','plates','taekwondo','other'].includes(e.group)
    ||![1,10].includes(e.minLevel)||![null,0,1].includes(e.sex)||!Array.isArray(e.files)||!e.files.length
    ||e.unavailable!==undefined&&(typeof e.unavailable!=='string'||!e.unavailable.length||e.unavailable.length>100))throw Error('INVALID_GAME_ENTRY');
  ids.add(e.id);const names=new Set();for(const f of e.files){
   if(!/^[a-zA-Z0-9_().-]+\.(swf|xml)$/.test(f.name)||! /^[a-zA-Z0-9_().-]+\.(swf|xml)$/.test(f.file)||names.has(f.name)
     ||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<1||f.size>16*1024*1024)throw Error('INVALID_GAME_FILE');names.add(f.name);
  }
 }
 cached=Object.freeze(data.entries.map(e=>Object.freeze(e)));return cached;
}
