import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {supplementGameCatalogue} from '../original-data/supplement-game-catalogue.js';
import {supplementGamePage} from './supplement-game-page.js';
import {BusinessAddresses,BUSINESS_AUTHORITIES} from '../deployment/business-addresses.js';
import {swfStructure,swfLayout,replaceSwfStrings} from '../deployment/swf-strings.js';
import {projectAvm1Movie} from '../deployment/avm1-addresses.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=new URL('../../resources/supplement-games/',import.meta.url);
const aliases={
 '/old_scene/pet_carnival.html':['carnival'], '/risk/main_xmxd.html':[null,'adventure'],
 '/oneonegame/dajimu.html':['blocks'],'/oneonegame/dg_tqd.html':['taekwondo'],
 '/oneonegame/qq_dpz.html':['plates'],'/oneonegame/Dish.html':['plates'],'/oneonegame/diepangzi.html':['plates'],
 '/oneonegame/qq_mstx.html':['room'],'/qq_mstx.html':['room'],'/mstx/index.html':['room'],
 '/n1.htm':['carnival'],
 '/guide/stf_index.html':[null],
 '/cgi-bin/showWorkyard':['carnival'],
};
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16LE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n>>>0);return b;};
function crc32(b){let crc=0xffffffff;for(const v of b){crc^=v;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zip(files){const parts=[],central=[];let offset=0;for(const [name,body] of files){const n=Buffer.from(name),crc=crc32(body),h=Buffer.concat([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(33),u32(crc),u32(body.length),u32(body.length),u16(n.length),u16(0),n]);parts.push(h,body);
 central.push(Buffer.concat([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(33),u32(crc),u32(body.length),u32(body.length),u16(n.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),n]));offset+=h.length+body.length;}
 const dir=Buffer.concat(central);return Buffer.concat([...parts,dir,u32(0x06054b50),u16(0),u16(0),u16(files.length),u16(files.length),u32(dir.length),u32(offset),u16(0)]);}
export class SupplementGames {
 constructor({deployment}={}){
  this.entries=supplementGameCatalogue();this.games=new Map(this.entries.map(e=>[e.id,e]));this.cache=new Map();
  this.addresses=deployment?new BusinessAddresses(deployment,{allowLoopback:true}):null;
  this.web=this.addresses?.base('web.pet.qq.com')??'http://web.pet.qq.com';
  const local=JSON.parse(readFileSync(new URL('../../config/local-desktop-games.json',import.meta.url)));
  if(local.version!==1||local.packs.length!==3)throw Error('LOCAL_GAME_CONFIG_INVALID');
  this.local=new Map();
  for(const pack of local.packs){
   if(!['fish','cannon','stars'].includes(pack.id)||this.local.has(pack.id)||pack.files.length!==4)throw Error('LOCAL_GAME_CONFIG_INVALID');
   const files=[];for(const f of pack.files){
    if(!/^(?:main|game)_(?:102|103)\.swf$/.test(f.name)||f.file!==pack.id+'-'+f.name||files.some(([name])=>name===f.name))throw Error('LOCAL_GAME_CONFIG_INVALID');
    const b=readFileSync(new URL('../../resources/local-desktop/'+f.file,import.meta.url));if(b.length!==f.size||sha(b)!==f.sha256)throw Error('LOCAL_GAME_ASSET_CHANGED');files.push([f.name,b]);
   }this.local.set(pack.id,files);
  }
  for(const e of this.entries)for(const f of e.files){const b=readFileSync(new URL(f.file,root));if(b.length!==f.size||sha(b)!==f.sha256)throw Error('GAME_ASSET_CHANGED');}
  const relive=JSON.parse(readFileSync(new URL('../../config/relive-desktop.json',import.meta.url))),movie=readFileSync(new URL('../../resources/local-desktop/relive-main.swf',import.meta.url));
  if(relive.version!==1||relive.resource!=='relivedesktop'||relive.file!=='relive-main.swf'||relive.size!==movie.length||relive.sha256!==sha(movie)||JSON.stringify(relive.phases)!=='[102,103,112,113,122,123]')throw Error('RELIVE_DESKTOP_CHANGED');
  this.reliveDesktop={phases:relive.phases,movie};
 }
 project(raw){
  const rewrite=s=>/^PET:\/\/\$B\$\[http:\/\/client\.pet\.qq\.com\/cgi-bin\/showWorkyard\?/.test(s)?"javascript:qqpetGameNavigate('carnival');//":/^fscommand:(?:quit|close)$/i.test(s)?'javascript:qqpetGameClose();':s==='http://imgcache.qq.com/pet/swf/n1.swf'?this.web+'/games/assets/carnival/main.swf':s==='http://client'?this.web:s.startsWith('.pet.qq.com/')?s.slice(11):s.replace(/https?:\/\/([a-z0-9.-]+)(?=[/?#\]\s"'<>]|$)/gi,(all,host)=>{
   if(/^http:\/\/(?:www\.)?adobe\.com\/(?:AS3\/2006\/builtin|2006\/flex\/mx\/internal|2006\/actionscript\/flash\/(?:proxy|objectproxy))$/.test(s))return all;
   return Object.values(BUSINESS_AUTHORITIES).includes(host)?this.addresses?.base(host)??all:this.web+'/games/unavailable/';
  });
  const structure=swfStructure(raw);let out=projectAvm1Movie(raw,rewrite);
  for(let n=0;n<structure.abcs.length;n++){const replacements=new Map();for(const s of swfLayout(out,{abcOrdinal:n}).strings){const before=s.bytes.toString(),after=rewrite(before);if(before!==after)replacements.set(s.index,{before,after});}
   if(replacements.size)out=replaceSwfStrings(out,replacements,{abcOrdinal:n}).output;}
  return out;
 }
 nativeResource(target){
  // TickleSystem 28E0 joins "NewQQPetZIP" with "common\\tickle2".
  // Admit only that fixed separator spelling, never general path normalization.
  const native=/^\/(?:NewQQPetZIP\/|NewQQPet\/)?common[\\/]tickle2\/(?:followup(?:fish|cannon|stars)13|relivedesktop)\.zip$/;
  return native.test(target??'')?this.resolve('resource.pet.qq.com',target.replace('common\\tickle2','common/tickle2')):null;
 }
 resolve(host,target){
  if(!Object.values(BUSINESS_AUTHORITIES).includes(host)||typeof target!=='string'||!target.startsWith('/')||target.length>2048||/\\|%2f|%5c|%2e/i.test(target)||target.split('?')[0].split('/').some(s=>s==='.'||s==='..'))return null;
  const u=new URL(target,'http://'+host);if(u.pathname.split('/').includes('..'))return null;
  if(/^\/(?:NewQQPetZIP\/|NewQQPet\/)?common\/tickle2\/relivedesktop\.zip$/.test(u.pathname)&&['resource.pet.qq.com','client.pet.qq.com','web.pet.qq.com'].includes(host)){
    if(!this.cache.has('relivedesktop'))this.cache.set('relivedesktop',zip(this.reliveDesktop.phases.map(p=>['relivedesktop/main_'+p+'.swf',this.project(this.reliveDesktop.movie)])));
    return {contentType:'application/zip',body:this.cache.get('relivedesktop')};
  }
  const pack=/^\/(?:NewQQPetZIP\/|NewQQPet\/)?common\/tickle2\/(followup(fish|cannon|stars)13)\.zip$/.exec(u.pathname);
  if(pack&&['resource.pet.qq.com','client.pet.qq.com','web.pet.qq.com'].includes(host)){
   const key=pack[1];if(!this.cache.has(key))this.cache.set(key,zip(this.local.get(pack[2]).map(([name,b])=>[key+'/'+name,b])));
   return {contentType:'application/zip',body:this.cache.get(key)};
  }
  if(u.pathname==='/gameplay/relive.swf'){const key='relive';if(!this.cache.has(key))this.cache.set(key,this.project(readFileSync(new URL('relive.swf',root))));return {contentType:'application/x-shockwave-flash',body:this.cache.get(key)};}
  if(u.pathname==='/gameplay/friend-messages.swf'){const key='friend-messages';if(!this.cache.has(key))this.cache.set(key,this.project(readFileSync(new URL('../../resources/static/common/petsoc/BrowseMsg.swf',import.meta.url))));return {contentType:'application/x-shockwave-flash',body:this.cache.get(key)};}
  if(u.pathname==='/swf/games/qq_mstx.swf')return this.resolve('web.pet.qq.com','/games/assets/room/qq_mstx.swf');
  if(u.pathname==='/swf/n1.swf')return this.resolve('web.pet.qq.com','/games/assets/carnival/main.swf');
  const a=/^\/games\/assets\/([a-z0-9-]+)\/([A-Za-z0-9_().-]+)$/.exec(u.pathname);
    if(a){const g=this.games.get(a[1]),f=g?.files.find(f=>f.name===a[2]);if(!f||g.group==='desktop'||g.id==='other-36')return null;const key=a[0];if(!this.cache.has(key)){let b=readFileSync(new URL(f.file,root));if(f.name.endsWith('.swf'))b=this.project(b);this.cache.set(key,b);}return {contentType:f.name.endsWith('.swf')?'application/x-shockwave-flash':'text/xml; charset=utf-8',body:this.cache.get(key)};}
  let selected,group,match=false,origin=u.searchParams.get('from')??'collection';
  if(!['community','collection'].includes(origin)||u.searchParams.getAll('from').length>1)return null;
    if(u.pathname==='/games/play.html'){selected=this.games.get(u.searchParams.get('id'));if(!selected||selected.group==='desktop'||selected.id==='other-36')return null;match=true;}
  if(u.pathname==='/games/index.html'){group=u.searchParams.get('group');match=true;}
  if(aliases[u.pathname]){const [id,g]=aliases[u.pathname];selected=this.games.get(id);group=g;match=true;origin='community';}
  const old=/^\/games\/(baseball|highjump|m9|rockcraft|swim|thegame)\.htm$/.exec(u.pathname);
  if(old){selected=this.entries.find(e=>e.group==='carnival'&&e.source.endsWith('/'+old[1]+'.swf'));match=true;origin='community';}
  if(!match)return null;
    return {contentType:'text/html; charset=utf-8',body:Buffer.from(supplementGamePage(this.entries.filter(e=>e.group!=='desktop'&&e.id!=='other-36'),selected,group,origin))};
 }
}
