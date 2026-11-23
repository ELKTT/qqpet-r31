import {existsSync,lstatSync,mkdirSync,readFileSync,openSync,closeSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export const CLIENT='runtime/client/txsso-12529-login-acceptance-20260906';
export const MANOR=CLIENT+'/res/Plugins/Interact/PetManorSNS.swf';
export const LOGIN='runtime/tools/remote-login';
export const CONFIG='server/config/deployment-endpoints.json';
export const PROFILES=['original-post-entry','original-play-menu','online-vitals','pet-business','pet-membership','care-economy','care-economy-upgrades','webdir-zone-template'];
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export function need(value,code){if(!value)throw Error(code);}
export function safe(root,relative,{missing=false}={}){
  need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.includes('\\')&&relative.split('/').every(p=>p&&p!=='.'&&p!=='..'),'PACKAGE_PATH_INVALID');
  let current=path.resolve(root);need(existsSync(current)&&lstatSync(current).isDirectory()&&!lstatSync(current).isSymbolicLink(),'PACKAGE_ROOT_INVALID');
  for(const p of relative.split('/')){current=path.join(current,p);if(existsSync(current))need(!lstatSync(current).isSymbolicLink(),'PACKAGE_LINK_REFUSED');}
  need(missing||existsSync(current),'PACKAGE_FILE_MISSING');return current;
}
export function atomic(root,relative,bytes){
  const target=safe(root,relative,{missing:true});mkdirSync(path.dirname(target),{recursive:true});
  const temporary=target+'.pending-'+randomUUID();let fd,owned=false;
  try{fd=openSync(temporary,'wx');owned=true;writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,target);owned=false;}
  finally{if(fd!==undefined)closeSync(fd);if(owned)unlinkSync(temporary);}
}
export const readJson=(root,relative)=>JSON.parse(readFileSync(safe(root,relative),'utf8'));
export function verifyState(root,{client=false}={}){
  const state=readJson(root,'package-state.json');need(state.kind==='qqpet-windows-package'&&state.schemaVersion===1&&state.status==='ready'&&state.part===(client?'client':'server'),'PACKAGE_NOT_READY');
  need(Array.isArray(state.files)&&state.files.length===(client?48:3),'PACKAGE_STATE_INVALID');
  const seen=new Set();
  for(const f of state.files){need(!seen.has(f.path)&&/^[a-f0-9]{64}$/.test(f.sha256),'PACKAGE_STATE_INVALID');seen.add(f.path);need(sha(readFileSync(safe(root,f.path)))===f.sha256,'PACKAGE_FILE_CHANGED');}
  return state;
}
