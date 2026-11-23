import {readFileSync,existsSync,lstatSync,mkdirSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const PARTS=['client','windows-server','linux-server'];
export const sha=body=>createHash('sha256').update(body).digest('hex');
export const md5=body=>createHash('md5').update(body).digest('hex').toUpperCase();
export const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
export function need(ok,code){if(!ok)throw Error(code);}
export function relative(name){
  need(typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!name.includes('\\')&&!name.includes(':')
    &&name.split('/').every(p=>p&&p!=='.'&&p!=='..'),'COMPLETE_PATH_INVALID');return name;
}
export function safe(root,name,{missing=false}={}){
  relative(name);let file=path.resolve(root);
  need(existsSync(file)&&lstatSync(file).isDirectory()&&!lstatSync(file).isSymbolicLink(),'COMPLETE_ROOT_INVALID');
  for(const component of name.split('/')){file=path.join(file,component);if(existsSync(file))need(!lstatSync(file).isSymbolicLink(),'COMPLETE_LINK_REFUSED');}
  need(missing||existsSync(file),'COMPLETE_FILE_MISSING');return file;
}
export function atomic(root,name,body){
  const target=safe(root,name,{missing:true});mkdirSync(path.dirname(target),{recursive:true});
  const temporary=target+'.pending-'+randomUUID(),fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,target);
}
export const readJson=(root,name)=>JSON.parse(readFileSync(safe(root,name),'utf8'));
export function baseline(root=ROOT){
  const registry=readJson(root,'server/config/development-baseline.json');
  need(registry.kind==='qqpet-development-baseline'&&registry.isolatedTestsRequireCompleteBaseline===true,'COMPLETE_BASELINE_REQUIRED');
  const file=safe(root,registry.manifest),raw=readFileSync(file);need(sha(raw)===registry.manifestSha256,'COMPLETE_BASELINE_CHANGED');
  const manifest=JSON.parse(raw);need(manifest.kind==='qqpet-complete-feature-baseline'&&manifest.id===registry.id&&manifest.accountDataIncluded===false,'COMPLETE_BASELINE_REQUIRED');
  const isolated=registry.manifest==='analysis/manifests/isolated-complete.json';
  if(isolated)need(typeof manifest.parentBaseline==='string'&&/^[a-f0-9]{64}$/.test(manifest.parentManifestSha256),'COMPLETE_ISOLATED_PARENT_REQUIRED');
  return {registry,manifest,tree:isolated?root:path.join(path.dirname(file),'tree')};
}
export function verifyState(root,part,{allowPending=false}={}){
  need(allowPending||!existsSync(safe(root,'address-update.pending',{missing:true})),'ADDRESS_TRANSACTION_PENDING');
  const state=readJson(root,packageStateName(root,part));
  need(state.kind==='qqpet-complete-package'&&state.schemaVersion===1&&state.part===part&&state.status==='ready'
    &&Array.isArray(state.files)&&state.files.length>0,'COMPLETE_PACKAGE_NOT_READY');
  const seen=new Set();
  for(const row of state.files){
    need(!seen.has(relative(row.path))&&/^[a-f0-9]{64}$/.test(row.sha256),'COMPLETE_STATE_INVALID');seen.add(row.path);
    need(!row.path.startsWith('data/')&&!row.path.toLowerCase().startsWith('qqpetagent/state/'),'COMPLETE_STATE_CONTAINS_PRIVATE_DATA');
    if(part==='client'&&state.clientRoot&&row.path.startsWith(state.clientRoot+'/'))need(!/^\d+(?:\/|$)/.test(row.path.slice(state.clientRoot.length+1)),'COMPLETE_STATE_CONTAINS_PRIVATE_DATA');
    need(sha(readFileSync(safe(root,row.path)))===row.sha256,'COMPLETE_PACKAGE_FILE_CHANGED');
  }
  return state;
}
export function packageStateName(root,part){
  if(part==='client'&&existsSync(safe(root,'QQPetAgent/package-state.json',{missing:true}))){
    need(!existsSync(safe(root,'package-state.json',{missing:true})),'COMPLETE_PACKAGE_AMBIGUOUS');
    return 'QQPetAgent/package-state.json';
  }
  return 'package-state.json';
}
