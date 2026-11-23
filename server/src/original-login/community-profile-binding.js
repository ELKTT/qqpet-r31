import {createHash} from 'node:crypto';

// Non-authorizing per-connection correlation. Never publish the underlying pet ID.
export function communityProfileBinding(generation,petIdBytes) {
  if(typeof generation!=='string'||!generation||generation.length>128
      ||!Buffer.isBuffer(petIdBytes)||petIdBytes.length!==8)throw TypeError('INVALID_COMMUNITY_BINDING');
  return createHash('sha256').update('community-profile-v1\0').update(generation)
    .update('\0').update(petIdBytes).digest('hex');
}
