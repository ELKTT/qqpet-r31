// Public entry contracts observed in the desktop task/game and toolbar cache.
// Authentication is still handled separately; these values confer no authority.
const tags=new Set(['ieg.qqpenguin.desktop','ied.client.penguin.toolbar','ied.client.penguin.notice']);
export function parseCommunityEntry(search) {
  if(typeof search!=='string' || search.length>512 || /[\x00-\x20\\#]/.test(search))return null;
  if(search==='')return {};
  if(!search.startsWith('?'))return null;
  const query=new URLSearchParams(search),keys=[...query.keys()];
  if(!keys.length || keys.some(k=>!['ADTAG','cmd','sid','npcid'].includes(k) || query.getAll(k).length!==1))return null;
  if(query.has('ADTAG') && !tags.has(query.get('ADTAG')))return null;
  if(keys.length===1 && query.has('ADTAG'))return {};
  if(query.get('cmd')!=='npc' || !['sid','npcid'].every(k=>/^[1-9][0-9]{0,4}$/.test(query.get(k)) && Number(query.get(k))<=65535))return null;
  return {sceneId:Number(query.get('sid')),npcId:Number(query.get('npcid'))};
}
