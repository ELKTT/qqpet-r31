import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {validateCareEconomyPolicy,normalizeUpgrades} from './pet-care-economy.js';
import {CareResources} from '../original-webdir/care-resources.js';

export async function loadCareEconomyConfiguration(file) {
  if((await stat(file)).size>2*1024*1024)throw new Error('CARE_CONFIGURATION_TOO_LARGE');
  const c=JSON.parse(await readFile(file,'utf8'));
  if(!c||Array.isArray(c)||Object.keys(c).length!==(Object.hasOwn(c,'functionalPrice')?4:3)||Object.keys(c).some(k=>!['enabled','policy','resources','functionalPrice'].includes(k))||(Object.hasOwn(c,'functionalPrice')&&c.functionalPrice!==10)||typeof c.enabled!=='boolean'
      ||!Array.isArray(c.resources)||c.resources.length>1200)throw new Error('INVALID_CARE_CONFIGURATION');
  // The declared upgrade chain is a sibling file so an operator can record a catalogue move
  // without touching the catalogue itself; a missing file means no transition is allowed.
  const upgrades=normalizeUpgrades(await readUpgrades(file));
  const policy=validateCareEconomyPolicy(c.policy),entries=[];
  for(const r of c.resources) {
    if(typeof r?.file!=='string'||! /^server\/assets\/care-economy\/[a-f0-9]{64}\.(gif|png)$/.test(r.file)
        ||!r.file.endsWith('/'+r.sha256+r.file.slice(-4)))throw new Error('INVALID_CARE_ASSET_PATH');
    // Resolve under server/, independent of the caller's working directory.
    const actual=new URL('../../'+r.file.slice('server/'.length),import.meta.url);
    if((await stat(actual)).size>1024*1024)throw new Error('CARE_ASSET_TOO_LARGE');
    entries.push({path:r.path,sha256:r.sha256,body:await readFile(actual)});
  }
  const resources=new CareResources(entries);
  for(const i of policy.items)if(!resources.resolve('img.pet.qq.com','/wp/'+i.pic+'.gif'))throw new Error('CARE_ITEM_ICON_MISSING');
  for(const [kind,items] of [['study',policy.courses],['work',policy.jobs]])for(const i of items)
    if(i.icon!==`/client/worudy_new/${kind}/${i.id}.png`||!resources.resolve('img.pet.qq.com',i.icon))throw new Error('CARE_ACTIVITY_ICON_MISSING');
  return {enabled:c.enabled,policy,resources,catalogueUpgrades:upgrades,functionalPrice:c.functionalPrice};
}

// The upgrade chain lives beside the catalogue it describes. It is optional: absent means the
// only acceptable digest for a save is the current one.
async function readUpgrades(catalogueFile) {
  const sibling=catalogueFile instanceof URL
    ? new URL('care-economy-upgrades.json',catalogueFile)
    : path.join(path.dirname(path.resolve(String(catalogueFile))),'care-economy-upgrades.json');
  try {
    if((await stat(sibling)).size>64*1024)throw new Error('CARE_UPGRADE_CONFIGURATION_TOO_LARGE');
    const document=JSON.parse(await readFile(sibling,'utf8'));
    if(!document||typeof document!=='object'||Array.isArray(document)
        ||Object.keys(document).some((key)=>!['schemaVersion','transitions'].includes(key))
        ||document.schemaVersion!==1||!Array.isArray(document.transitions))
      throw new Error('INVALID_CARE_UPGRADE_CONFIGURATION');
    return document.transitions;
  } catch(error) {
    if(error?.code==='ENOENT')return [];
    throw error;
  }
}
