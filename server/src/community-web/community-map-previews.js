import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function loadCommunityMapPreviews(resources,allScenes=false) {
  const root=new URL('../../assets/community-web/generated/'+(allScenes?'scene-maps/':''),import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
  if(manifest.kind!=='local-preview-from-authoritative-background-tiles' || !Array.isArray(manifest.outputs)
      || (allScenes?manifest.outputs.length<4 || manifest.outputs.length>130:manifest.outputs.length!==4))
    throw Error('INVALID_PREVIEW_MANIFEST');
  for(const [name,hash] of Object.entries(manifest.sources)) {
    const source=resources.get(name);
    if(!source || createHash('sha256').update(source.body).digest('hex')!==hash)throw Error('PREVIEW_SOURCE_CHANGED');
  }
  const result=new Map();
  for(const e of manifest.outputs) {
    const pattern=allScenes?/^generated\/scene-maps\/(?:[1-9][0-9]{0,4}-(?:mini|world)\.jpg|(?:mini|world)-map\.xml)$/:/^generated\/(?:town-(?:mini\.jpg|world\.png)|(?:mini|world)-map\.xml)$/;
    if(!pattern.test(e.name) || result.has(e.name))throw Error('INVALID_PREVIEW_PATH');
    const body=await readFile(new URL(e.name.slice(allScenes?21:10),root));
    if(body.length!==e.bytes || createHash('sha256').update(body).digest('hex')!==e.sha256)throw Error('PREVIEW_CHANGED');
    result.set(e.name,{body,contentType:e.name.endsWith('.xml')?'application/xml':e.name.endsWith('.png')?'image/png':'image/jpeg'});
  }
  if(allScenes)for(const kind of ['mini','world'])result.set('generated/'+kind+'-map.xml',result.get('generated/scene-maps/'+kind+'-map.xml'));
  return result;
}
