import {decodeLegacyCommunityRequest,encodeLegacyCommunityResult} from '../protocol/legacy-community.js';
export function validateLegacyCommunityPolicy(p){
  const keys=p&&Object.keys(p).filter(k=>!['sceneAliases','entryPoints','roundTrip'].includes(k)).sort().join('|');
  if(!p||keys!=='area|direction|scene|scenes|version|x|y|zone'||p.version!==1
    ||![p.zone,p.area,p.scene].every(v=>Number.isInteger(v)&&v>0&&v<=65535)
    ||![p.direction,p.x,p.y].every(v=>Number.isInteger(v)&&v>=0&&v<=65535)
    ||!Array.isArray(p.scenes)||!p.scenes.length||p.scenes.length>256)throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
  const ids=new Set();
  for(const s of p.scenes){
    if(!s||Object.keys(s).sort().join('|')!=='height|id|width'||!Number.isInteger(s.id)||s.id<1||s.id>65535
      ||ids.has(s.id)||![s.width,s.height].every(v=>Number.isInteger(v)&&v>0&&v<=65535))throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
    ids.add(s.id);
  }
  const first=p.scenes.find(s=>s.id===p.scene);
  if(!first||p.x>=first.width||p.y>=first.height)throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
  if(p.sceneAliases!==undefined){
    if(!Array.isArray(p.sceneAliases)||!p.sceneAliases.length||p.sceneAliases.length>16)throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
    const aliases=new Set();
    for(const a of p.sceneAliases){
      if(!a||Object.keys(a).sort().join('|')!=='requested|scene'||!Number.isInteger(a.requested)||a.requested<1||a.requested>65535
        ||ids.has(a.requested)||aliases.has(a.requested)||!ids.has(a.scene))throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
      aliases.add(a.requested);
    }
  }
  if(p.entryPoints!==undefined){
    if(!Array.isArray(p.entryPoints)||!p.entryPoints.length||p.entryPoints.length>1024)throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
    const seen=new Set();
    for(const entry of p.entryPoints){
      const scene=p.scenes.find(s=>s.id===entry?.destination),key=entry?.source+':'+entry?.destination;
      if(!entry||Object.keys(entry).sort().join('|')!=='destination|source|x|y'
        ||!ids.has(entry.source)||!scene||seen.has(key)
        ||![entry.x,entry.y].every(v=>Number.isInteger(v)&&v>=0&&v<=65535)
        ||entry.x>=scene.width||entry.y>=scene.height)throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
      seen.add(key);
    }
  }
  if(p.roundTrip!==undefined){
    const r=p.roundTrip;
    if(!r||Object.keys(r).sort().join('|')!=='entrances|exit|interiors'
      ||![r.entrances,r.interiors].every(a=>Array.isArray(a)&&a.length>0&&a.length<=16
        &&new Set(a).size===a.length&&a.every(id=>ids.has(id)))
      ||r.entrances.some(id=>r.interiors.includes(id))||!r.entrances.includes(r.exit))
      throw new TypeError('INVALID_LEGACY_COMMUNITY_POLICY');
  }
  return structuredClone(p);
}
export class LegacyCommunityState{
  constructor({database,policy,beforeCommit=()=>{}}){
    this.policy=validateLegacyCommunityPolicy(policy);this.database=database;this.beforeCommit=beforeCommit;
    database.exec(`CREATE TABLE IF NOT EXISTS legacy_community_position_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      scene INTEGER NOT NULL,x INTEGER NOT NULL,y INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS legacy_community_return_v1 (
      pet_id TEXT PRIMARY KEY REFERENCES qqpenguin_login_profile(pet_id) ON DELETE CASCADE,
      scene INTEGER NOT NULL CHECK(scene BETWEEN 1 AND 65535)) STRICT;`);
  }
  accepts(command){return [0x1102,0x1103,0x110a,0x1104,0x1108].includes(command);}
  position(profile){return this.database.prepare('SELECT scene,x,y FROM legacy_community_position_v1 WHERE pet_id=?')
    .get(profile.petIdBytes.readBigUInt64LE().toString());}
  commit(profile,row,returnScene){
    const id=profile.petIdBytes.readBigUInt64LE().toString();
    this.database.exec('BEGIN IMMEDIATE');
    try{this.database.prepare('INSERT INTO legacy_community_position_v1 VALUES(?,?,?,?) ON CONFLICT(pet_id) DO UPDATE SET scene=excluded.scene,x=excluded.x,y=excluded.y')
      .run(id,row.scene,row.x,row.y);
      if(returnScene===null)this.database.prepare('DELETE FROM legacy_community_return_v1 WHERE pet_id=?').run(id);
      else if(returnScene!==undefined)this.database.prepare('INSERT INTO legacy_community_return_v1 VALUES(?,?) ON CONFLICT(pet_id) DO UPDATE SET scene=excluded.scene').run(id,returnScene);
      this.beforeCommit();this.database.exec('COMMIT');}
    catch(error){this.database.exec('ROLLBACK');throw error;}
  }
  handle(command,body,profile,context){
    const q=decodeLegacyCommunityRequest(command,body),p=this.policy;
    const reply=(fields={},outcome='accepted')=>{
      const body=encodeLegacyCommunityResult(command,fields);
      // Only the typed two-byte destination enum accompanies map decisions;
      // no request bytes, identity or position enter the diagnostic record.
      context.lastResult={count:(context.lastResult?.count??0)+1,command,outcome,
        ...([0x1103,0x110a].includes(command)?{requestedScene:q.value}:{})};
      return [{command,body}];
    };
    const denied=outcome=>reply({code:1,message:Buffer.from('Community unavailable')},outcome);
    if(command===0x1102){
      if(q.value!==0&&q.value!==p.area)return denied('area-unavailable');
      const saved=this.position(profile)??{scene:p.scene,x:p.x,y:p.y};
      const alias=p.sceneAliases?.find(a=>a.requested===saved.scene),destination=alias&&p.scenes.find(s=>s.id===alias.scene);
      const row=destination?{scene:destination.id,x:Math.min(p.x,destination.width-1),y:Math.min(p.y,destination.height-1)}:saved;
      const scene=p.scenes.find(s=>s.id===row.scene);
      if(!scene||row.x>=scene.width||row.y>=scene.height)return denied('saved-position-invalid');
      this.commit(profile,row);context.inCommunity=true;
      return reply({...row,zone:p.zone,area:p.area,direction:p.direction});
    }
    if(command===0x1108){context.inCommunity=false;return reply();}
    if(!context.inCommunity)return denied('not-in-community');
    const row=this.position(profile);
    if(!row)return denied('position-missing');
    if(command===0x1104){
      const scene=p.scenes.find(s=>s.id===row.scene);
      if(!scene||[q,...q.path].some(pos=>pos.x>=scene.width||pos.y>=scene.height))return denied('movement-invalid');
      // 1104 carries the current origin followed by the requested route, not a
      // destination followed by history. 1120 consumes that exact origin/time.
      const end=q.path.at(-1)??q;
      this.commit(profile,{scene:row.scene,x:end.x,y:end.y});
      const stamp=q.opaque.readBigUInt64LE();
      context.lastMove={x:q.x,y:q.y,path:q.path,time:stamp<=BigInt(Number.MAX_SAFE_INTEGER)?Number(stamp):undefined};
      context.revision=(context.revision??0)+1;return reply();
    }
    // Explicit compatibility resource mapping only. The 1069 whole-world map
    // still requests old Wali scene 4 and incomplete snow scene 5; the
    // configured available same-place scenes are 28 and 25.
    // Return the real scene id so its own config, NPCs and navigation agree.
    const trip=p.roundTrip,origin=trip?this.database.prepare('SELECT scene FROM legacy_community_return_v1 WHERE pet_id=?')
      .get(profile.petIdBytes.readBigUInt64LE().toString())?.scene:undefined;
    const returning=command===0x1103&&trip?.interiors.includes(row.scene)&&q.value===trip.exit&&trip.entrances.includes(origin);
    const target=returning?origin:p.sceneAliases?.find(a=>a.requested===q.value)?.scene??q.value;
    const scene=p.scenes.find(s=>s.id===target);
    if(!scene)return denied('scene-unavailable');
    // Walking through an NPC portal and choosing a world-map destination are
    // different entries. A walking arrival uses that destination's pinned
    // reciprocal NPC NavPoint; it must not share the global world-map spawn.
    const entry=command===0x1103?p.entryPoints?.find(e=>e.source===row.scene&&e.destination===scene.id):null;
    const next={scene:scene.id,x:entry?.x??Math.min(p.x,scene.width-1),y:entry?.y??Math.min(p.y,scene.height-1)};
    const returnScene=command===0x1103&&trip?.interiors.includes(scene.id)
      ?(trip.entrances.includes(row.scene)?row.scene:trip.interiors.includes(row.scene)&&trip.entrances.includes(origin)?origin:null):null;
    this.commit(profile,next,returnScene);return reply({...next,direction:p.direction});
  }
}
