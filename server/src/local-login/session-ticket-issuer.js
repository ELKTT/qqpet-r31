import {LocalServiceTicketIssuer} from '../txsso/service-ticket-issuer.js';
import {TxssoProtocolError} from '../txsso/binary-codec.js';

const rejected=()=>new TxssoProtocolError('INVALID_SERVICE_TICKET','local service ticket is unavailable');
const PETLESS_BOOT_TTL_MS=600000;
const ROOT_CONTINUATION_TTL_MS=120000;

// The short deadline governs new Root connections. Once a Root has accepted a
// ticket, HTTP may use that ticket until the last owning connection closes.
// An acknowledged growth pause reserves that credential for the original
// native resume (types 1/3), including a replacement Root. An accepted Home or
// community leave permits one bounded reconnect. Neither rootless state grants HTTP.
//
// Capacity and lifecycle, in one place, because a credential the client holds is what the limit is
// about - not the table it happens to sit in:
//
//   * every live credential occupies exactly one slot, whether it is a lease (a ticket an
//     authenticated petful entry holds, or the entry credential an adoption promoted to) or a
//     petless boot (the value a petless entry holds). maxTickets bounds the slots, so one account's
//     boot cannot be held outside the count while another account's ticket is refused for it.
//   * swapping one credential of an account for another does not consume a second slot:
//     issuePetlessBoot for an account that already holds a boot is a replacement (the old value is
//     revoked, the slot is reused) and promotePetlessBoot is a conversion in place (the boot's
//     slot becomes the lease's). Neither can fail for capacity, which is why an adoption can never
//     commit a pet and then discover it cannot hand back the credential for it.
//   * expiry releases a boot or an unpaused rootless lease. The last unpaused Root closing,
//     ordinary logout, account disable/reset and issuer closure also release its slot.
//     An acknowledged pause keeps one slot until resume or explicit revocation.
//   * the entry credential an adoption hands back is the boot converted in place, so its lifetime is
//     the entry lease's own and is counted from the conversion - the conversion is what makes the
//     client's start sign usable for the pet that was just committed, and a later request never
//     converts or renews the value again (see promotePetlessBoot).
export class LocalSessionTicketIssuer extends LocalServiceTicketIssuer {
  #leases=new Map();
  // A petless boot credential is the value a client may present while its account has no pet. It
  // is issued by the same source and has the same 64-hex shape as a session ticket - the client's
  // own launch chain carries exactly one sign into two consumers, the webdir request branch and
  // the Root login body, so the shape cannot differ - but it is recorded apart from the leases and
  // is therefore never a bound HTTP credential: verifyBoundHex only ever looks at leases. One
  // account has at most one live boot: issuing a new one supersedes the previous value, which is
  // the auth generation - a boot that was superseded can neither adopt nor enter.
  #petlessBoots=new Map();
  #promotedBoots=new Set();
  #bootGeneration=new Map();
  #promotedBootCount=0;
  #closed=false;
  constructor({clock=Date.now,ttlMs=120000,maxTickets=128,petlessBootTtlMs=PETLESS_BOOT_TTL_MS,randomBytes}={}) {
    super(randomBytes===undefined?{}:{randomBytes});
    if(typeof clock!=='function' || !Number.isInteger(ttlMs) || ttlMs<1 || ttlMs>300000 ||
        !Number.isInteger(maxTickets) || maxTickets<1 || maxTickets>2048 ||
        !Number.isInteger(petlessBootTtlMs) || petlessBootTtlMs<1 || petlessBootTtlMs>3600000)
      throw new TypeError('INVALID_LOCAL_TICKET_POLICY');
    this.clock=clock;this.ttlMs=ttlMs;this.maxTickets=maxTickets;this.petlessBootTtlMs=petlessBootTtlMs;
  }
  #now() {
    const now=this.clock();
    if(!Number.isSafeInteger(now) || now<0)throw new TypeError('INVALID_LOCAL_TICKET_CLOCK');
    return now;
  }
  #prune() {
    const now=this.#now();
    for(const [key,lease] of this.#leases)if(!lease.roots.size && !lease.paused && now>=(lease.resumeUntil??lease.expiresAt))this.revoke(Buffer.from(key,'hex'));
    for(const [key,boot] of [...this.#petlessBoots])if(now>=boot.expiresAt)this.revoke(Buffer.from(key,'hex'));
  }
  // The slots in use: one per live credential, in either namespace. Boots and leases cannot both
  // hold the same key (a promotion moves the value from one table to the other), so this is the
  // number of credentials a client could still present and never a double count.
  #occupiedSlots() {
    return this.#leases.size+this.#petlessBoots.size;
  }
  // The petless boot credential of one authenticated no-pet account. It is handed to that
  // authentication's own private caller, never published, and superseded (with its ticket value)
  // the moment the same account starts a newer boot. Like a ticket it occupies one slot of
  // maxTickets, and an account that already holds a boot is swapping its own slot rather than
  // asking for a second one - the replacement is accounted before the old value is dropped, so a
  // refused issuance leaves the account's existing credential exactly as it was.
  issuePetlessBoot({uin, serviceId, ttlMs}) {
    if(this.#closed)throw rejected();
    if(!Number.isInteger(uin) || uin<=0 || uin>0xffffffff)throw new TypeError('INVALID_PETLESS_BOOT_IDENTITY');
    if(!Number.isInteger(serviceId) || serviceId<=0 || serviceId>0xffffffff)throw new TypeError('INVALID_PETLESS_BOOT_IDENTITY');
    const lifetime=ttlMs===undefined?this.petlessBootTtlMs:ttlMs;
    if(!Number.isInteger(lifetime) || lifetime<1 || lifetime>3600000)throw new TypeError('INVALID_PETLESS_BOOT_POLICY');
    this.#prune();
    const replacing=[...this.#petlessBoots.values()].some(boot=>boot.uin===uin);
    if(this.#occupiedSlots()-(replacing?1:0)>=this.maxTickets)throw new Error('LOCAL_TICKET_LIMIT');
    const generation=(this.#bootGeneration.get(uin)??0)+1;
    const ticket=super.issue({uin,serviceId});
    const signHex=ticket.toString('hex');
    for(const [key,boot] of [...this.#petlessBoots])if(boot.uin===uin)this.revoke(Buffer.from(key,'hex'));
    this.#bootGeneration.set(uin,generation);
    this.#petlessBoots.set(signHex,{uin,serviceId,generation,expiresAt:this.#now()+lifetime});
    ticket.fill(0);
    return Object.freeze({signHex,generation});
  }
  // The boot state of one value: the account it stands for and its generation. A superseded or
  // expired boot is not a thing this issuer has, exactly like an unknown value.
  verifyPetlessBoot(signHex,{serviceId}) {
    if(!Number.isInteger(serviceId) || serviceId<=0 || serviceId>0xffffffff)throw new TypeError('INVALID_SERVICE_TICKET');
    const boot=this.#liveBoot(signHex,serviceId);
    return Object.freeze({uin:boot.uin,serviceId:boot.serviceId,generation:boot.generation,petless:true});
  }
  isPetlessBoot(signHex,{serviceId}={}) {
    try {this.#liveBoot(signHex,serviceId);return true;} catch {return false;}
  }
  #liveBoot(signHex,serviceId) {
    if(this.#closed || typeof signHex!=='string' || !/^[a-f0-9]{64}$/i.test(signHex))throw rejected();
    const boot=this.#petlessBoots.get(signHex.toLowerCase());
    if(!boot)throw rejected();
    if(this.#now()>=boot.expiresAt) {this.revoke(Buffer.from(signHex,'hex'));throw rejected();}
    if(this.#bootGeneration.get(boot.uin)!==boot.generation)throw rejected();
    if(serviceId!==undefined && boot.serviceId!==serviceId)throw rejected();
    return boot;
  }
  // The continuation point of the adopted account: the value the client has been carrying since
  // its petless boot becomes the entry credential of the pet the transaction just created. It is
  // called from the adoption itself and, defensively, from bindRoot - and bindRoot is only ever
  // reached after a login resolved the account's pet profile, so the promotion cannot turn a
  // petless identity into a petful one on its own.
  //
  // This is a conversion of the credential the client already holds, not the issuance of another
  // one: the boot's slot becomes the lease's slot, the value does not change, and no capacity is
  // consumed beyond the slot the boot was already occupying. The converted lease takes the entry
  // lease's own lifetime from this point, exactly as issue() gives one to a petful entry: the first
  // successful conversion converts the value into the entry namespace, and a value that is already
  // an entry lease is never given a second lifetime by a repeat - this method is only reached while
  // the value is still a boot.
  //
  // The record's own deadline is deliberately not re-read here. Every caller reaches this point only
  // after the same value was resolved as a live petless boot for the adoption it has just committed
  // in the same request, and a deadline that passes while that transaction runs must not decide
  // whether a pet that is already committed has an entry credential. What still wins is everything
  // that is not the clock: a closed issuer, a revoked value and a boot that a newer authentication
  // superseded (the account's current generation is the one that must be converted).
  promotePetlessBoot(signHex) {
    if(this.#closed || typeof signHex!=='string')return false;
    const key=signHex.toLowerCase();
    const boot=this.#petlessBoots.get(key);
    if(boot===undefined)return false;
    if(this.#bootGeneration.get(boot.uin)!==boot.generation)return false;
    const expiresAt=this.#now()+this.ttlMs;
    if(!Number.isSafeInteger(expiresAt))throw new TypeError('INVALID_LOCAL_TICKET_CLOCK');
    this.#petlessBoots.delete(key);
    const existing=this.#leases.get(key);
    this.#leases.set(key,{expiresAt,uin:boot.uin,roots:existing?.roots??new Set()});
    this.#promotedBoots.add(key);
    this.#promotedBootCount+=1;
    return true;
  }
  // Whether this value is a boot credential that has already been promoted for that account - the
  // state a committed adoption leaves behind. It is what lets a repeated submission answer with the
  // same pet instead of being refused for lacking a live petless boot, while an account whose
  // credential was revoked, or whose boot was superseded, satisfies neither this nor the live form.
  // Being promoted is not by itself a live credential: the lease the value became follows the same
  // rule every other lease does - held by a Root, or inside its own deadline - so a promoted value
  // that has run out is refused here exactly as it is refused at the entry, without waiting for some
  // other request to sweep the table first.
  isPromotedPetlessBoot(signHex,{uin}={}) {
    if(typeof signHex!=='string')return false;
    const key=signHex.toLowerCase();
    if(!this.#promotedBoots.has(key))return false;
    const lease=this.#leases.get(key);
    if(lease===undefined)return false;
    if(uin!==undefined&&lease.uin!==uin)return false;
    try {return this.#leaseLive(key,lease);} catch {return false;}
  }
  // The one rule for what a lease is right now, read by every consumer of one: a lease a Root is
  // holding lives until that Root lets go of it - the last disconnect is what ends it, not the
  // clock. A rootless acknowledged pause is reserved for native resume; an
  // accepted transition uses its bounded continuation deadline. Other rootless
  // leases live only up to their entry deadline. Nobody has to have swept
  // the table first: a dead rootless lease is refused here and released here, so the same value
  // cannot be refused by one entry and accepted by another depending on which request ran first.
  #leaseLive(key,lease) {
    if(lease.roots.size||lease.paused)return true;
    if(this.#now()<(lease.resumeUntil??lease.expiresAt))return true;
    this.revoke(Buffer.from(key,'hex'));
    return false;
  }
  #lease(signHex) {
    if(this.#closed || typeof signHex!=='string' || !/^[a-f0-9]{64}$/i.test(signHex))throw rejected();
    const key=signHex.toLowerCase(),lease=this.#leases.get(key);
    if(!lease)throw rejected();
    if(!this.#leaseLive(key,lease))throw rejected();
    return lease;
  }
  issue(identity) {
    if(this.#closed)throw rejected();
    this.#prune();
    // The same slot count a boot is held against: a ticket for a petful entry and a boot for a
    // petless one are both one credential handed to one client.
    if(this.#occupiedSlots()>=this.maxTickets)throw new Error('LOCAL_TICKET_LIMIT');
    const expiresAt=this.#now()+this.ttlMs;
    if(!Number.isSafeInteger(expiresAt))throw new TypeError('INVALID_LOCAL_TICKET_CLOCK');
    const ticket=super.issue(identity);
    this.#leases.set(ticket.toString('hex'),{expiresAt,uin:identity.uin,roots:new Set()});
    return ticket;
  }
  // A live petless boot resolves here so the client's own login body can be answered before the
  // account has a pet; everything the answer authorizes is still decided by the profile lookup the
  // login performs next, which cannot resolve a pet that does not exist. Every other value is a
  // lease and is read with the one lease rule (#leaseLive), which is also what the two adoption
  // entries ask about a promoted value: the entry verification, the public page and the private
  // adoption cannot disagree about whether a credential still is one.
  verifyHex(signHex,options) {
    if(typeof signHex==='string' && this.isPetlessBoot(signHex,options)) {
      const boot=this.#liveBoot(signHex,options?.serviceId);
      return Object.freeze({uin:boot.uin,serviceId:boot.serviceId,petless:true,generation:boot.generation});
    }
    this.#lease(signHex);
    return super.verifyHex(signHex,options);
  }
  verifyBoundHex(signHex,options) {
    if(!this.#lease(signHex).roots.size)throw rejected();
    return super.verifyHex(signHex,options);
  }
  bindRoot(signHex,owner,{resume=false,awaitHello=false}={}) {
    if(!owner || (typeof owner!=='object' && typeof owner!=='function'))throw new TypeError('INVALID_ROOT_OWNER');
    if(typeof resume!=='boolean'||typeof awaitHello!=='boolean')throw new TypeError('INVALID_ROOT_RESUME');
    // The caller reached this point only after the login resolved this account's pet profile, so a
    // boot credential that is still in its petless state has just been overtaken by the committed
    // adoption: promote it to the lease the entry now uses rather than refusing the connection the
    // promotion exists for. A boot of an account that never adopted stays petless and unbound.
    if(typeof signHex==='string' && this.isPetlessBoot(signHex))this.promotePetlessBoot(signHex);
    const lease=this.#lease(signHex);
    const handoff=resume&&(lease.paused===true||this.#now()<(lease.resumeUntil??0));
    if(!lease.roots.has(owner) && !handoff && (lease.paused||lease.resumeUntil!==undefined||this.#now()>=lease.expiresAt))throw rejected();
    if(lease.roots.size && !lease.roots.has(owner) && !handoff)throw rejected();
    for(const other of this.#leases.values()) {
      if(other!==lease && other.uin===lease.uin && other.roots.size)throw rejected();
    }
    const replaced=handoff?[...lease.roots].filter(root=>root!==owner):[];
    for(const root of replaced)lease.roots.delete(root);
    lease.roots.add(owner);
    // A native reconnect is not established until its authenticated Hello.
    // Keep the original bounded deadline across interrupted Login attempts;
    // retries must neither consume the credential early nor extend its life.
    if(handoff&&awaitHello){
      lease.resumeUntil??=this.#now()+ROOT_CONTINUATION_TTL_MS;
      lease.resumeOwner=owner;
    }else{
      delete lease.resumeUntil;
      delete lease.resumeOwner;
    }
    lease.paused=false;
    // A newly accepted entry/resume is the current connection for this account.
    // Older rootless pauses cannot revive after it exits.
    for(const [key,other] of this.#leases)if(other!==lease&&other.uin===lease.uin&&(other.paused||other.resumeUntil!==undefined)&&!other.roots.size)
      this.revoke(Buffer.from(key,'hex'));
    return replaced;
  }
  confirmRootContinuation(owner) {
    for(const lease of this.#leases.values())if(lease.roots.has(owner)&&lease.resumeOwner===owner){
      delete lease.resumeUntil;delete lease.resumeOwner;return true;
    }
    return false;
  }
  pauseRoot(owner) {
    for(const lease of this.#leases.values())if(lease.roots.has(owner)){
      lease.paused=true;delete lease.resumeUntil;delete lease.resumeOwner;return true;
    }
    return false;
  }
  // OnlineManager ReLogin uses the original type-3 Login on a replacement
  // Root. Only an accepted native Home/community exit reserves this handoff.
  // It consumes one existing slot, lasts two minutes and grants no rootless HTTP.
  reserveRootContinuation(owner) {
    for(const lease of this.#leases.values())if(lease.roots.has(owner)){
      const deadline=this.#now()+ROOT_CONTINUATION_TTL_MS;
      if(!Number.isSafeInteger(deadline))throw new TypeError('INVALID_LOCAL_TICKET_CLOCK');
      lease.resumeUntil=deadline;return true;
    }
    return false;
  }
  // Dropping every ticket of one account is what makes a disable take effect on credentials that
  // were already handed out: the tickets stop resolving here, and the caller also ends the live
  // connections that were authenticated with them. A petless boot credential is a credential of
  // that account too, so a disable or a credential reset takes it away with the same call.
  revokeUin(uin) {
    let revoked=0;
    for(const [key,lease] of [...this.#leases]) {
      if(lease.uin===uin) {this.revoke(Buffer.from(key,'hex'));revoked++;}
    }
    for(const [key,boot] of [...this.#petlessBoots]) {
      if(boot.uin===uin) {this.revoke(Buffer.from(key,'hex'));revoked++;}
    }
    return revoked;
  }
  activeRootOwners(uin) {
    return [...this.#leases.values()].filter(lease=>lease.uin===uin).flatMap(lease=>[...lease.roots]);
  }
  hasActiveRoot(uin) {
    return [...this.#leases.values()].some(lease=>lease.uin===uin && lease.roots.size>0);
  }
  abortUnbound(signHex) {
    if(typeof signHex!=='string' || !/^[a-f0-9]{64}$/i.test(signHex))return false;
    const lease=this.#leases.get(signHex.toLowerCase());
    return Boolean(lease && !lease.roots.size && !lease.paused && this.#now()>=(lease.resumeUntil??0) && this.revoke(Buffer.from(signHex,'hex')));
  }
  releaseRoot(owner,{loggedOut=false}={}) {
    if(typeof loggedOut!=='boolean')throw new TypeError('INVALID_ROOT_LOGOUT');
    for(const [key,lease] of this.#leases) {
      if(lease.roots.delete(owner)){
        if(loggedOut){lease.paused=false;delete lease.resumeUntil;delete lease.resumeOwner;}
        if(!lease.roots.size&&!lease.paused&&this.#now()>=(lease.resumeUntil??0))this.revoke(Buffer.from(key,'hex'));
      }
    }
  }
  revoke(ticket) {
    if(Buffer.isBuffer(ticket)) {
      const key=ticket.toString('hex');
      this.#leases.delete(key);
      this.#petlessBoots.delete(key);
      this.#promotedBoots.delete(key);
    }
    return super.revoke(ticket);
  }
  close() {
    this.#closed=true;
    for(const key of this.#leases.keys())super.revoke(Buffer.from(key,'hex'));
    for(const key of this.#petlessBoots.keys())super.revoke(Buffer.from(key,'hex'));
    this.#leases.clear();this.#petlessBoots.clear();this.#promotedBoots.clear();
  }
  summary() {
    this.#prune();
    const leases={unboundTicketCount:[...this.#leases.values()].filter(v=>!v.roots.size).length,
      boundTicketCount:[...this.#leases.values()].filter(v=>v.roots.size).length,
      pausedTicketCount:[...this.#leases.values()].filter(v=>v.paused).length};
    return Object.freeze({...super.summary(),...leases,
      petlessBootCount:this.#petlessBoots.size,promotedPetlessBootCount:this.#promotedBootCount,
      occupiedSlotCount:this.#occupiedSlots(),maxTickets:this.maxTickets,
      closed:this.#closed});
  }
}
