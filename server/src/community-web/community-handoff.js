import {randomBytes,timingSafeEqual} from 'node:crypto';
import {CommunitySession} from './community-session.js';

// Operator-owned capability, distinct from one-use browser launch grants. The
// resolver must confirm the currently owned Root, never merely a database row.
export class CommunityHandoff {
  constructor({resolve,now=Date.now}) {
    if(typeof resolve!=='function')throw TypeError('COMMUNITY_OWNER_REQUIRED');
    this.resolve=resolve;this.now=now;this.owner=randomBytes(32).toString('hex');
    this.generation=null;this.session=null;this.closed=false;this.sessions=new Map();
  }
  refresh(generation=null) {
    let binding=null;
    try{if(!this.closed)binding=this.resolve(generation);}catch{}
    if(!binding || typeof binding.generation!=='string' || !binding.generation
        ||(generation!==null && binding.generation!==generation)) {
      if(generation!==null){this.sessions.get(generation)?.close();this.sessions.delete(generation);}
      this.session=null;this.generation=null;return null;
    }
    try {
    let session=this.sessions.get(binding.generation);
    if(!session){
      if(this.sessions.size>=128)return null;
      session=new CommunitySession({pet:binding.pet,now:this.now});
      this.sessions.set(binding.generation,session);
    } else session.updatePet(binding.pet);
    this.session=session;this.generation=binding.generation;
    return this.session;
    } catch { this.sessions.get(binding.generation)?.close();this.sessions.delete(binding.generation);this.session=null;this.generation=null;return null; }
  }
  sweep(){for(const generation of [...this.sessions.keys()])this.refresh(generation);}
  forCookie(cookie){
    this.sweep();
    for(const session of this.sessions.values())if(session.authorized(cookie))return session;
    return null;
  }
  redeem(grant){
    this.sweep();
    for(const session of this.sessions.values()){
      const token=session.redeem(grant);if(token)return token;
    }
    return null;
  }
  request(value) {
    if(!value || !['owner,renew','generation,owner,renew'].includes(Object.keys(value).sort().join(',')) || typeof value.renew!=='boolean'
      || ('generation' in value && (typeof value.generation!=='string'||!value.generation||value.generation.length>128))
      || typeof value.owner!=='string' || !/^[a-f0-9]{64}$/.test(value.owner)
      || !timingSafeEqual(Buffer.from(value.owner),Buffer.from(this.owner)))return null;
    this.sweep();
    if(!this.refresh(value.generation??null))return null;
    return {generation:this.generation,active:this.session.capabilityActive(),...(value.renew?{grant:this.session.issueGrant()}: {})};
  }
  close(){this.closed=true;for(const session of this.sessions.values())session.close();this.sessions.clear();this.session=null;this.generation=null;}
}
