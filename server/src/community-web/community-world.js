import {createHash} from 'node:crypto';
import {CommunityNavigation} from './community-navigation.js';

// E-125: scene links come from the active NpcList's enterScene actions.
// The original server's arrival coordinates are missing; local reciprocal-portal
// placement is an explicit webpage policy, never an original wire-protocol claim.
export class CommunityWorld {
  constructor(data,resources) {
    if(data?.schemaVersion!==1 || !data.sources || !Array.isArray(data.scenes)
        || !data.scenes.length || data.scenes.length>64)throw Error('INVALID_COMMUNITY_WORLD');
    for(const [name,sha] of Object.entries(data.sources)) {
      const r=resources.get(name);
      if(!r || createHash('sha256').update(r.body).digest('hex')!==sha)throw Error('WORLD_SOURCE_CHANGED');
    }
    this.scenes=new Map();
    for(const source of data.scenes) {
      const s=structuredClone(source),id=s.sceneId;
      if(!Number.isInteger(id) || id<1 || id>65535 || this.scenes.has(id)
          || typeof s.name!=='string' || s.name.length>64 || !s.name
          || !Array.isArray(s.npcs) || s.npcs.length>512 || s.navigation?.sceneId!==id)
        throw Error('INVALID_COMMUNITY_SCENE');
      const ids=new Set();
      for(const n of s.npcs) {
        if(!Number.isInteger(n.id) || n.id<0 || n.id>65535 || ids.has(n.id)
            || !['x','y','navX','navY','distance'].every(k=>Number.isFinite(n[k]) && Math.abs(n[k])<=10000)
            || typeof n.name!=='string' || n.name.length>256 || !Array.isArray(n.actions) || n.actions.length>64)
          throw Error('INVALID_COMMUNITY_NPC');
        ids.add(n.id);
        for(const a of n.actions)if(typeof a.name!=='string' || a.name.length>64 || !a.params
            || typeof a.params!=='object' || Array.isArray(a.params) || Object.keys(a.params).length>16
            || Object.entries(a.params).some(([k,v])=>k.length>64 || typeof v!=='string' || v.length>2048))
          throw Error('INVALID_COMMUNITY_ACTION');
      }
      this.scenes.set(id,{...s,nav:new CommunityNavigation(s.navigation)});
    }
    this.aliases=new Map();
    for(const [old,id] of Object.entries(data.aliases??{})) {
      if(!/^[1-9][0-9]{0,4}$/.test(old) || this.scenes.has(Number(old)) || !this.scenes.has(id))throw Error('INVALID_SCENE_ALIAS');
      this.aliases.set(Number(old),id);
    }
  }
  navigation(id) {return this.scenes.get(id)?.nav;}
  npcTarget(sceneId,npcId) {
    if(!Number.isInteger(sceneId) || !Number.isInteger(npcId))return null;
    const actual=this.aliases.get(sceneId)??sceneId;
    return this.scenes.get(actual)?.npcs.some(n=>n.id===npcId)?{sceneId:actual,npcId}:null;
  }
  exits(id) {
    return (this.scenes.get(id)?.npcs ?? []).flatMap(n=>n.actions.filter(a=>a.name==='enterScene')
      .map(a=>({npcId:n.id,sceneId:Number(a.params.id),name:n.name,x:n.navX||n.x,y:n.navY||n.y})));
  }
  destination(from,to) {
    if(!Number.isInteger(to) || !this.scenes.has(to) || !this.exits(from).some(e=>e.sceneId===to))return null;
    const target=this.scenes.get(to),back=this.exits(to).find(e=>e.sceneId===from);
    if(!back)return null;
    // Keep clear of the exit trigger: choose a walkable triangle center near it.
    const points=target.nav.cells.map(c=>c.center).filter(p=>p.x<target.nav.width && p.y<target.nav.height)
      .map(p=>({p,d:Math.hypot(p.x-back.x,p.y-back.y)})).filter(v=>v.d>=60 && v.d<=200)
      .sort((a,b)=>a.d-b.d);
    if(!points.length)return null;
    return {sceneId:to,x:points[0].p.x,y:points[0].p.y,direction:4};
  }
  describe(id) {
    const scene=this.scenes.get(id);if(!scene)return null;
    return {sceneId:id,name:scene.name,exits:this.exits(id).map(e=>({sceneId:e.sceneId,npcId:e.npcId,
      name:this.scenes.get(e.sceneId)?.name??e.name,available:!!this.destination(id,e.sceneId)}))};
  }
  jumpDestination(to) {
    if(!Number.isInteger(to))return null;
    const actual=this.aliases.get(to)??to,target=this.scenes.get(actual);if(!target)return null;
    const center={x:target.nav.width/2,y:target.nav.height/2};
    const p=target.nav.cells.map(c=>c.center).filter(p=>p.x<target.nav.width && p.y<target.nav.height)
      .sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y))[0];
    return p?{sceneId:actual,x:p.x,y:p.y,direction:4,...(actual!==to?{requestedSceneId:to}:{})}:null;
  }
  page(id,raw) {
    if(typeof raw!=='string' || raw.length>4096 || /[\x00-\x1f]/.test(raw))return null;
    function unwrap(value) {
      for(let i=0;i<3;i++) {
        const m=/^pet:\/\/\$(?:SUB|MAIN|MIDDLE)\$\[([\s\S]*)\]$/i.exec(value);
        if(!m)break;value=m[1];
      }
      return value.replace(/\?localtime=[0-9]+$/,'');
    }
    const url=unwrap(raw),scene=this.scenes.get(id);
    const npc=scene?.npcs.find(n=>n.actions.some(a=>['openUrl','openSubUrl','openMainUrl','openMiddleUrl'].includes(a.name)
      && unwrap(a.params.url??'')===url));
    if(!npc)return null;
    let kind='unavailable';
    if(/^http:\/\/web\.pet\.qq\.com\/fcgi-bin\/petstudy\?cmd=1&grade=[0-2]&type=0$/.test(url))kind='courses';
    else if(url==='http://web.pet.qq.com/index10003.html')kind='jobs';
    else if(url==='http://web.pet.qq.com/npc/npc_zhoudabing.html')kind='shop';
    else if(url==='http://web.pet.qq.com/guide/stf_index.html')kind='guide';
    return {kind,title:npc.name||'社区活动',npcId:npc.id,sceneId:id};
  }
}
