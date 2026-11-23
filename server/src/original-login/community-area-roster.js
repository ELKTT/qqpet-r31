import {COMMUNITY_AREA_COMMAND,MAX_AREA_PLAYERS,encodeCommunityArea} from '../protocol/community-area.js';
import {AVATAR_INFO_COMMAND_ID} from '../protocol/community-avatar.js';

// Area membership is independent of the current map. Unchanged groups reuse
// their last published views; no per-recipient comparison runs on idle ticks.
export class CommunityAreaRoster {
 constructor(){this.groups=new Map();this.views=new Map();}
 synchronize(current,area,send){
  const members=new Map();for(const [channel,p]of current)if(p.kind==='community')members.set(p.id,{channel,petId:p.profile.petIdBytes,version:p.version});
  const old=this.groups.get(area);
  const changed=!old||old.size!==members.size||[...members].some(([id,p])=>old.get(id)?.version!==p.version||old.get(id)?.channel!==p.channel);
  for(const [channel,previous]of this.views)if(!current.has(channel)||current.get(channel).kind!=='community'){
   // Clear the native receiver too, before dropping our delivery view. A later
   // re-entry must not keep peers that departed while this player was home.
   if(previous.size&&!channel.closed&&!channel.logoutCount)
    send(channel,COMMUNITY_AREA_COMMAND,encodeCommunityArea({leaves:[...previous.values()].map(q=>q.petId)}));
   this.views.delete(channel);
  }
  if(changed){
   const ordered=[...members.values()].sort((a,b)=>Buffer.compare(a.petId,b.petId));
   for(const [id,p]of members){
    // Keep the real self record even when alone. The original Flash model
    // explicitly skips its ID when adding peers, so self is displayed once.
    const selected=[p,...ordered.filter(q=>q!==p).slice(0,MAX_AREA_PLAYERS-1)];
    const next=new Map(selected.map(q=>[q.petId.toString('hex'),q]));
    const previous=this.views.get(p.channel)??new Map();
    const leaves=[...previous].filter(([key])=>!next.has(key)).map(([,q])=>q.petId);
    const enters=[...next].filter(([key,q])=>previous.get(key)?.version!==q.version).map(([,q])=>({petId:q.petId,version:q.version}));
    if(leaves.length||enters.length){
     send(p.channel,COMMUNITY_AREA_COMMAND,encodeCommunityArea({leaves,enters}));
     // Native cached/removal-only deltas do not publish immediately. A genuine
     // self profile snapshot takes PetInfoSystem -> 209F0 -> 27750, refreshing
     // the updated list without synthetic versions or Flash callbacks.
     const wardrobe=p.channel.postEntryState?.wardrobe;
     if(wardrobe)send(p.channel,AVATAR_INFO_COMMAND_ID,wardrobe.infoResponse([p.petId]));
    }
    this.views.set(p.channel,next);
   }
  }
  this.groups.clear();if(members.size)this.groups.set(area,members);
 }
}
