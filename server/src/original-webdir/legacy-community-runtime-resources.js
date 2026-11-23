import {readFile,stat,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateLegacyDirectoryPolicy} from '../protocol/legacy-directory.js';
import {validateLegacyCommunityPolicy} from '../original-data/legacy-community-state.js';
import {validateLegacyHomePolicy} from '../original-data/legacy-home-state.js';

const sha=b=>createHash('sha256').update(b).digest('hex');
const bad=()=>{throw new TypeError('INVALID_LEGACY_COMMUNITY_PROFILE');};
export async function loadLegacyCommunityRuntimeProfile(filename){
  if((await stat(filename)).size>4*1024*1024)bad();
  const p=JSON.parse(await readFile(filename,'utf8'));
  if(p?.kind!=='qqpet-legacy-community-home-compatibility'||p.schemaVersion!==1
    ||p.originalFunctionComplete!==false||!Array.isArray(p.resources)||!p.resources.length||p.resources.length>16384)bad();
  const policy=validateLegacyHomePolicy(p.home),directoryPolicy=validateLegacyDirectoryPolicy(p.directory),community=validateLegacyCommunityPolicy(p.community);
  if(community.zone!==directoryPolicy.zone||community.area!==directoryPolicy.area)bad();
  const directory=path.dirname(path.resolve(filename)),resources=new Map(),windowsFiles=new Map(),bodies=new Map();
  for(const entry of p.resources){
    if(!entry||!['resource.pet.qq.com','client.pet.qq.com','127.0.0.1',directoryPolicy.resourceDomain].includes(entry.authority)
      ||typeof entry.target!=='string'||!/^\/(?:NewQQPet\/)?[A-Za-z0-9_./ -]+\.(?:zip|swf|xml|png|gif|jpg|js|css|mp3)$/.test(entry.target)
      ||entry.target.split('/').some(x=>x==='.'||x==='..')
      ||typeof entry.file!=='string'||path.isAbsolute(entry.file)||entry.file.includes('..')
      ||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.size)||entry.size<1||entry.size>32*1024*1024
      ||!['application/zip','application/x-shockwave-flash','text/xml','image/png','image/gif','image/jpeg','text/javascript','text/css','audio/mpeg'].includes(entry.contentType))bad();
    // Only declared scene music may use the new audio type. It remains a finite,
    // hash-pinned resource; no filename or URL is resolved from a request.
    if(entry.target.endsWith('.mp3')!== (entry.contentType==='audio/mpeg')
      ||(entry.contentType==='audio/mpeg'&&!/^\/(?:NewQQPet\/)?common\/petsoc\/Data\/Music\/[A-Za-z0-9_-]+\.mp3$/.test(entry.target)))bad();
    const file=path.resolve(directory,entry.file),relative=path.relative(directory,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))bad();
    let check=file;
    while(check!==directory){const s=await lstat(check);if(s.isSymbolicLink())bad();check=path.dirname(check);}
    if(await realpath(file)!==file)bad();
    const info=await stat(file);if(!info.isFile()||info.size!==entry.size)bad();
    let body=bodies.get(file);
    if(!body){body=await readFile(file);if(sha(body)!==entry.sha256)throw new Error('LEGACY_COMMUNITY_RESOURCE_CHANGED');bodies.set(file,body);}
    else if(sha(body)!==entry.sha256)bad();
    const key=entry.authority+entry.target;if(resources.has(key))bad();
    const resource={body,contentType:entry.contentType};resources.set(key,resource);
    if(!entry.target.endsWith('.zip')&&/^\/(?:NewQQPet\/)?common\/petsoc\//.test(entry.target)){
      // Native Type 8 uses the ordinary file name. The client's Windows
      // lookup treats slash spelling and ASCII case alike. Match only this
      // finite, hash-verified catalog; no URL or filesystem path is resolved.
      const alias=key.toLowerCase(),existing=windowsFiles.get(alias);
      if(existing&&(existing.contentType!==resource.contentType||!existing.body.equals(body)))bad();
      windowsFiles.set(alias,resource);
    }
  }
  const scene=resources.get('resource.pet.qq.com/common/'+policy.resourceId+'.zip');
  if(!scene||sha(scene.body)!==p.sceneZipSha256)throw new Error('LEGACY_HOME_SCENE_PACKAGE_MISSING');
  for(const background of policy.backgrounds??[])if(!resources.has('resource.pet.qq.com/common/'+background.resourceId+'.zip'))
    throw new Error('LEGACY_HOME_BACKGROUND_PACKAGE_MISSING');
  // HomeSystem 2EA10 submits NewQQPet + common/<id>.zip. ResourceProvider
  // 1930/1A4D/1B1D maps that partition to QQPenguin/ReleaseA, just as for
  // wardrobe files. Bind only the validated home catalogue to those bytes.
  for(const id of [policy.resourceId,...(policy.backgrounds??[]).map(b=>b.resourceId)]){
    const resource=resources.get('resource.pet.qq.com/common/'+id+'.zip');
    const key=directoryPolicy.resourceDomain+'/QQPenguin/ReleaseA/common/'+id+'.zip';
    const existing=resources.get(key);
    if(existing&&!existing.body.equals(resource.body))bad();
    resources.set(key,resource);
  }
  // CommunityResourceProvider RVA 09520 keeps the XML's literal parent path;
  // KernelTenio RVA 221A8 copies that URI unchanged. Bind this one verified
  // download spelling to its pinned bytes without resolving filesystem paths.
  const config=resources.get(directoryPolicy.resourceDomain+'/NewQQPet/common/petsoc/PetCommunityRes_1069.xml');
  const market=resources.get(directoryPolicy.resourceDomain+'/NewQQPetZIP/common_market1068.zip');
  if(config&&market&&sha(config.body)==='c39c3385583c29f913ec674a91ab3a2e54b1a9dfb3f43538391e315f9c511e08'){
    resources.set(directoryPolicy.resourceDomain+'/NewQQPetZIP/common/petsoc/..\\..\\common_market1068.zip',market);
  }
  // world_1051 WholeWorldMapView 7220 requests this image-authority XML.
  // Its 7222 handler assigns each senceNID from MouseOverInfo/@id; without
  // the response all five int slots stay zero. The installed older XML
  // supplies the five button identifiers but omits their destination ids.
  // Project only the pinned complete-baseline document into the server
  // response; leave the installed bytes and native scene validation intact.
  const mapSource=resources.get(directoryPolicy.resourceDomain+'/NewQQPet/common/petsoc/Data/WorldMap/WorldMapHotInfo.xml');
  let worldMap;
  // Every profile resource has already passed its declared size and SHA-256.
  // A previous hard-coded hash silently disabled this route after the three
  // default bubbles were removed, leaving every bubble's embedded sample text.
  if(mapSource){
    if(mapSource.body.length>16384)bad();
    let count=0;const destinations=new Set();
    const labels={'ASSD|ASDD|ADSAS':'风语广场','qweqwe|qweq|1231231':'夏帕海岸','zzzz|yyyy|xxxx':'粉钻雪山'};
    let bubbles=0;
    const text=mapSource.body.toString('utf8').replace(/content="([^"]*)"/g,(attribute,value)=>{
      if(!Object.hasOwn(labels,value))return attribute;
      bubbles++;return 'content="'+labels[value]+'"';
    }).replace(/<MouseOverInfo\s+sence\s*=\s*"([13456])"\s*>/g,(_,id)=>{
      if(destinations.has(id))bad();destinations.add(id);
      count++;return '<MouseOverInfo sence="'+id+'" id="'+id+'">';
    });
    if(count!==5||![0,3].includes(bubbles))bad();
    worldMap={body:Buffer.from(text),contentType:'text/xml; charset=utf-8'};
  }
  return {policy,directory:directoryPolicy,community,resources:{resolve:(host,target)=>{
    const exact=resources.get(host+target);if(exact)return exact;
    if(typeof target!=='string'||target.length>1024)return null;
    // Only the original fixed path and its bounded Math.random cache key.
    if(worldMap&&host==='img.pet.qq.com'
      &&/^\/WorldMapHotInfo\.xml(?:\?rnd=(?:0(?:\.[0-9]{1,20})?|[1-9](?:\.[0-9]{1,20})?e-[1-9][0-9]?))?$/.test(target))return worldMap;
    return windowsFiles.get(host+target.replaceAll('\\','/').toLowerCase())??null;
  }}};
}
