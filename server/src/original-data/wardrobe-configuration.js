import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateWardrobeConfiguration} from './pet-wardrobe.js';

export async function loadWardrobeConfiguration(filename,{resources,authority}={}) {
  if((await stat(filename)).size>2*1024*1024)throw new TypeError('WARDROBE_PROFILE_TOO_LARGE');
  const configuration=validateWardrobeConfiguration(JSON.parse(await readFile(filename,'utf8')));
  if(typeof resources?.resolve!=='function')throw new TypeError('WARDROBE_REQUIRES_ORIGINAL_RESOURCES');
  for(const item of configuration.items) {
    const resource=resources.resolve(authority,item.sequenceTarget),body=resource?.body;
    if(!Buffer.isBuffer(body)||body.length<33||resource.contentType!=='image/png'
      ||body.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||body.readUInt32BE(16)!==720||body.readUInt32BE(20)!==960
      ||createHash('sha256').update(body).digest('hex')!==item.sha256)throw new TypeError('WARDROBE_RESOURCE_MISMATCH');
  }
  return configuration;
}
