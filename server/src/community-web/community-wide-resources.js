// Only the explicitly enabled community-web compatibility launcher uses this
// variant. The authority catalog and generic resource loader remain unchanged.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const WIDE_SOURCE_SHA256='e6b7d9a72fd333a036bb27d1a544743065f5247e26ba6edb82d3abf33453f7ea';
export const WIDE_SHA256='63b8398d52b009e57fe24209b3dd91fe534438e95be0fe4486368c0a0508b485';
const digest=body=>createHash('sha256').update(body).digest('hex');

export async function applyCommunityWideViewport(resources, body) {
  const original=resources.get('world_1089.swf');
  if(!original || resources.main!=='world_1089.swf' || digest(original.body)!==WIDE_SOURCE_SHA256)
    throw new Error('WIDE_VIEWPORT_SOURCE_CHANGED');
  body ??= await readFile(new URL('../../assets/community-web/world-wide.swf',import.meta.url));
  if(!Buffer.isBuffer(body) || digest(body)!==WIDE_SHA256)
    throw new Error('WIDE_VIEWPORT_RESOURCE_CHANGED');
  resources.files.set('world_1089.swf',{body:Buffer.from(body),contentType:original.contentType});
  return resources;
}
