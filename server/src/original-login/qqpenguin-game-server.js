import {writeGameFrame} from '../runtime/bounded-socket-write.js';
import net from "node:net";
import {randomUUID} from "node:crypto";
import {communityProfileBinding} from './community-profile-binding.js';

import { HELLO_COMMAND_ID } from "../protocol/hello.js";
import { LocalServiceTicketIssuer } from "../txsso/service-ticket-issuer.js";
import { QqPenguinLoginTicketAuthenticator } from "../txsso/qqpenguin-login-authenticator.js";
import {
  OriginalRootChannel,
  QQPENGUIN_LOGIN_COMMAND_ID,
} from "./original-root-channel.js";
import { QqPenguinProfileDirectory } from "./qqpenguin-profile-directory.js";
import {parseCareHttpRequest} from '../protocol/care-http.js';
import {PAGE_SIZE,marketEconomySubkind,parseMarketHtmlRequest,projectMarketHtmlFailure,projectMarketHtmlFrame,projectMarketHtmlList,projectMarketHtmlSuccess} from '../protocol/market-html.js';
import {wardrobeSeat,projectWardrobeMarketItem} from '../protocol/wardrobe-market.js';

import {resolveServerListener} from '../deployment/server-listener.js';

export const ORIGINAL_QQPENGUIN_HOST = "127.0.0.1";
export const ORIGINAL_QQPENGUIN_DEFAULT_PORT = 18001;

const DEFAULT_TRANSPORT_LIMITS=Object.freeze({maxConnections:512,maxPerAddress:128,loginTimeoutMs:15000,maxCompletedSessions:128});
function transportPolicy(input={}) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(DEFAULT_TRANSPORT_LIMITS,k)))throw new TypeError('INVALID_GAME_TRANSPORT_LIMITS');
  const value={...DEFAULT_TRANSPORT_LIMITS,...input};
  for(const [key,min,max]of[['maxConnections',1,16384],['maxPerAddress',1,16384],['loginTimeoutMs',10,120000],['maxCompletedSessions',0,4096]])
    if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw new TypeError('INVALID_GAME_TRANSPORT_LIMITS');
  return Object.freeze(value);
}

function assertEndpoint(host, port, deploymentEndpoints) {
  return resolveServerListener('game', {host, port, deploymentEndpoints});
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export class OriginalQqPenguinGameServer {
  constructor({
    ticketIssuer,
    profiles,
    host,
    port,
    deploymentEndpoints,
    sessionKeyFactory,
    postEntryState,
    legacyHome,legacyCommunity,
    clock,
    unknownCommandPolicy='reject',
    allowLocalQqsignTicket=false,
    transportLimits,
  } = {}) {
    if (!(ticketIssuer instanceof LocalServiceTicketIssuer)) {
      throw new TypeError("ticketIssuer must be a LocalServiceTicketIssuer");
    }
    ({host, port} = assertEndpoint(host, port, deploymentEndpoints));
    this.ticketAuthenticator = new QqPenguinLoginTicketAuthenticator({ ticketIssuer, allowLocalQqsignTicket });
    this.allowLocalQqsignTicket=allowLocalQqsignTicket;
    this.profileDirectory = new QqPenguinProfileDirectory(profiles);
    if(!['reject','record-only'].includes(unknownCommandPolicy))throw new TypeError('INVALID_UNKNOWN_COMMAND_POLICY');
    this.options = { host, port, sessionKeyFactory, postEntryState, legacyHome,legacyCommunity, clock, unknownCommandPolicy };
    this.server = null;
    this.connections = new Map();
    this.transportLimits=transportPolicy(transportLimits);
    this.peerConnections=new Map();
    this.completedSessionsDiscarded=0;
    this.connectionLimitRejections=0;
    this.spatialPresence=new SpatialPresence({community:legacyCommunity,home:legacyHome,clock:this.options.clock});
    if(legacyHome)legacyHome.presenceProfiles=()=>[...this.connections.values()].filter(c=>!c.closed&&!c.logoutCount&&!c.growthPaused&&c.profile&&c.sessionKey)
      .map(c=>({profile:c.timeSession?.profile(c.profile)??c.profile,context:c.homeContext}));
    this.communityRunGeneration=randomUUID();
    this.communityConnectionIds=new WeakMap();
    this.firstAdoptionConnections = new WeakSet();
    this.completedSessions = [];
    this.connectionCount = 0;
    this.protocolErrorCount = 0;
    this.errorCategories = { ingest: 0, transportReset: 0, transportOther: 0, close: 0, listener: 0 };
    // The committed-rename push (0x0552): how many frames went out, how many sessions could not
    // be addressed because they had no Hello-derived notification header yet (their next 0x0532
    // request answers the new name), and how many writes failed.
    this.nickNameNotifyCount = 0;
    this.nickNameNotifyUnaddressable = 0;
    this.nickNameNotifyFailures = 0;
    this.started = false;
    this.ready = false;
    this.stopped = false;
  }

  #accept(socket) {
    this.connectionCount += 1;
    // Addresses exist only in this bounded in-memory admission map, never in reports.
    const peer=socket.remoteAddress??'unknown',peerCount=this.peerConnections.get(peer)??0;
    if(this.connections.size>=this.transportLimits.maxConnections||peerCount>=this.transportLimits.maxPerAddress){
      this.connectionLimitRejections++;socket.on('error',()=>{});socket.destroy();return;
    }
    this.peerConnections.set(peer,peerCount+1);
    const pendingTickets=new Map();
    const issuer=this.ticketAuthenticator.ticketIssuer;
    const authenticator=this.allowLocalQqsignTicket
      ? new QqPenguinLoginTicketAuthenticator({ticketIssuer:issuer,allowLocalQqsignTicket:true,
        onAuthenticated:(sign,request)=>pendingTickets.set(sign,[1,3].includes(request.unknown_0x42))}) : this.ticketAuthenticator;
    const channel = new OriginalRootChannel({
      ticketAuthenticator: authenticator,
      profileDirectory: this.profileDirectory,
      postEntryState:this.options.postEntryState,
      legacyHome:this.options.legacyHome,legacyCommunity:this.options.legacyCommunity,
      clock:this.options.clock,
      unknownCommandPolicy:this.options.unknownCommandPolicy,
      ...(this.options.sessionKeyFactory === undefined
        ? {}
        : { sessionKeyFactory: this.options.sessionKeyFactory }),
    });
    this.connections.set(socket, channel);
    // Absolute pre-login deadline: sending one byte at a time cannot renew it.
    const loginTimer=setTimeout(()=>socket.destroy(),this.transportLimits.loginTimeoutMs);loginTimer.unref();
    this.communityConnectionIds.set(channel,this.communityRunGeneration+":"+this.connectionCount);
    socket.on("data", (chunk) => {
      try {
        const before=channel.loginCount,beforeHello=channel.helloCount, outputs=channel.ingest(Buffer.from(chunk));
        if(channel.loginCount>0)clearTimeout(loginTimer);
        // Bind only after Root has accepted both identity and pet/profile. A
        // rejected or expired launch receives no success frames.
        if(this.allowLocalQqsignTicket && channel.loginCount>before && typeof issuer.bindRoot==='function') {
          for(const [sign,resume] of pendingTickets) {
            const replaced=issuer.bindRoot(sign,socket,{resume,awaitHello:true})??[];
            for(const oldSocket of replaced)oldSocket.destroy();
            if(issuer.isPromotedPetlessBoot?.(sign,{uin:channel.authenticatedUin}))
              this.firstAdoptionConnections.add(socket);
          }
        }
        if(this.allowLocalQqsignTicket&&channel.helloCount>beforeHello)issuer.confirmRootContinuation?.(socket);
        if(this.allowLocalQqsignTicket&&channel.growthPaused)issuer.pauseRoot?.(socket);
        if(this.allowLocalQqsignTicket&&channel.rootContinuationPending){
          issuer.reserveRootContinuation?.(socket);channel.rootContinuationPending=false;
        }
        pendingTickets.clear();
        for (const output of outputs) writeGameFrame(socket,output);
        this.spatialPresence.synchronize(this.connections);
        if (channel.snapshot().state === 'logged-out') {
          if(this.allowLocalQqsignTicket)issuer.releaseRoot?.(socket,{loggedOut:true});
          socket.end();
        }
      } catch (error) {
        if(this.allowLocalQqsignTicket)for(const sign of pendingTickets.keys())issuer.abortUnbound?.(sign);
        pendingTickets.clear();
        this.protocolErrorCount += 1;
        this.errorCategories.ingest += 1;
        socket.destroy();
      }
    });
    socket.on("error", (error) => {
      this.protocolErrorCount += 1;
      this.errorCategories[error.code === "ECONNRESET" ? "transportReset" : "transportOther"] += 1;
    });
    socket.on("close", () => {
      clearTimeout(loginTimer);
      const remaining=(this.peerConnections.get(peer)??1)-1;
      if(remaining>0)this.peerConnections.set(peer,remaining);else this.peerConnections.delete(peer);
      if(this.allowLocalQqsignTicket)issuer.releaseRoot?.(socket);
      const current = this.connections.get(socket);
      this.connections.delete(socket);
      try{this.spatialPresence.synchronize(this.connections);}catch{this.protocolErrorCount++;this.errorCategories.close++;}
      if (current !== undefined) {
        try {
          this.completedSessions.push(current.close());
        } catch {
          this.protocolErrorCount += 1;
          this.errorCategories.close += 1;
          this.completedSessions.push(current.snapshot());
        }
        const excess=this.completedSessions.length-this.transportLimits.maxCompletedSessions;
        if(excess>0){this.completedSessions.splice(0,excess);this.completedSessionsDiscarded+=excess;}
      }
    });
  }

  async start() {
    if (this.started) throw new Error("OriginalQqPenguinGameServer has already been started");
    this.started = true;
    this.server = net.createServer((socket) => this.#accept(socket));
    this.server.on("error", () => {
      if (this.ready) { this.protocolErrorCount += 1; this.errorCategories.listener += 1; }
    });
    await listen(this.server, this.options.host, this.options.port);
    this.ready = true;
    if(this.options.postEntryState?.careEconomy?.health){this.gameplayTimer=setInterval(()=>this.notifyGameplay(),250);this.gameplayTimer.unref();}
    if(this.options.postEntryState?.friends) {
      this.manorTimer=setInterval(()=>this.notifyManorRefresh(),250);
      this.manorTimer.unref();
    }
    return this.health();
  }

  notifyManorRefresh() {
    for(const [socket,channel] of this.connections) {
      if(socket.destroyed||!socket.writable)continue;
      try {for(const output of channel.createFriendNotifications())writeGameFrame(socket,output);const output=channel.createManorRefreshNotification();if(output)writeGameFrame(socket,output);}
      catch {this.protocolErrorCount++;this.errorCategories.ingest++;socket.destroy();}
    }
  }
  notifyGameplay() {
    const notify=()=>{
      for(const [socket,channel] of this.connections)if(!socket.destroyed&&socket.writable) {
        try{const result=channel.createGameplayNotifications();for(const output of result.outputs)writeGameFrame(socket,output);
          if(result.exit){this.ticketAuthenticator.ticketIssuer.releaseRoot?.(socket,{loggedOut:true});socket.end();}}
        catch{this.protocolErrorCount++;this.errorCategories.ingest++;socket.destroy();}
      }
      try{this.spatialPresence.synchronize(this.connections);}catch{this.protocolErrorCount++;this.errorCategories.ingest++;}
    };
    const state=this.options.postEntryState;
    return state?.withProfileSnapshots?state.withProfileSnapshots(notify):notify();
  }

  // End every live connection authenticated as this account. A disable must not leave an
  // already-authenticated session playing. Returns how many connections were closed.
  closeUin(uin) {
    let closed=0;
    for(const [socket,channel] of [...this.connections]) {
      if(channel.authenticatedUin!==uin)continue;
      closed++;
      try {socket.destroy();} catch {}
    }
    return closed;
  }

  // Rebind the profile directory after an account adopts. Existing connections keep the
  // profile they authenticated with; the next connection resolves against the new set.
  refreshProfiles(profiles) {
    this.profileDirectory=new QqPenguinProfileDirectory(profiles);
    return this.profileDirectory.size;
  }

  // Rebind the live profile of the account's current connection. A rename must reach the
  // running session too: refreshProfiles only serves future connections, while the open
  // channel keeps answering Hello from its own profile copy until it is replaced here. The
  // replacement is resolved through the rebuilt directory so the record carries the normalised
  // LoginSuccess shape (type/result included) the wire encoders require.
  refreshUinProfile(uin, petIdBytes) {
    let rebound=0;
    const profile=this.profileDirectory.resolve(uin, petIdBytes);
    for(const [,channel] of [...this.connections]) {
      if(channel.authenticatedUin!==uin)continue;
      channel.profile=profile;
      rebound++;
    }
    return rebound;
  }

  notifyInitialPetInfo() {
    if(!this.ready)return 0;
    let notified=0;
    for(const [socket,channel] of this.connections) {
      if(socket.destroyed||!socket.writable)continue;
      // The channel owns authentication, Hello readiness and its one-time flag.
      const output=channel.createInitialPetInfoNotification();
      if(output===null)continue;
      if(writeGameFrame(socket,output))notified++;
    }
    return notified;
  }

  notifyCharacterEntry() {
    if (!this.ready) return 0;
    let notified=0;
    for(const [socket,channel] of this.connections) {
      if(socket.destroyed||!socket.writable)continue;
      // Entry belongs to each authenticated, Hello-ready channel. A neighbour
      // must neither block it nor select its main action or encryption key.
      // Only this socket's committed adoption boot selects birth; a reconnect
      // has a new channel and an ordinary entry. The channel suppresses repeats.
      const output=channel.createCharacterEntryNotification({firstAdoption:this.firstAdoptionConnections.has(socket)});
      if(output===null)continue;
      if(writeGameFrame(socket,output))notified++;
    }
    return notified;
  }

  // Push the committed names to every live session authenticated as this account, as the
  // original name-only notification (0x0552). The publish step already rebound those sessions'
  // profiles, so this only removes the wait for the client's next 0x0532 request. A session
  // that cannot be addressed is counted, never queued: the next request answers it correctly.
  notifyNickNameChange(uin) {
    let notified=0,unaddressable=0,failed=0;
    for(const [socket,channel] of [...this.connections]) {
      if(channel.authenticatedUin!==uin)continue;
      const output=channel.createNickNameChangeNotification();
      if(output===null||socket.destroyed||!socket.writable) { unaddressable++; this.nickNameNotifyUnaddressable++; continue; }
      try { if(writeGameFrame(socket,output)){this.nickNameNotifyCount++;notified++;}else{failed++;this.nickNameNotifyFailures++;} }
      catch { failed++; this.nickNameNotifyFailures++; }
    }
    return {notified,unaddressable,failed};
  }

  handleToolbarHttp(request,cookie) {
    if(!this.ready||!this.options.postEntryState?.desktopTasks)throw new Error('TOOLBAR_NOT_ENABLED');
    const input=parseToolbarCookies(cookie);
    const issuer=this.ticketAuthenticator.ticketIssuer;
    const identity=this.allowLocalQqsignTicket && typeof issuer.verifyBoundHex==='function'
      ? issuer.verifyBoundHex(input.sign,{serviceId:0x00200e01}) : issuer.verifyHex(input.sign,{serviceId:0x00200e01});
    if(identity.uin!==input.uin)throw new Error('TOOLBAR_AUTH_FAILED');
    const targets=[...this.connections].filter(([socket,channel])=>!socket.destroyed&&socket.writable
      &&!channel.closed&&!channel.logoutCount&&channel.authenticatedUin===identity.uin
      &&channel.profile?.petIdBytes.readBigUInt64LE()===input.petId&&channel.notificationHeader);
    if(!targets.length)throw new Error('TOOLBAR_AUTH_FAILED');
    const [socket,channel]=targets[0],{data,outputs}=channel.toolbarRequest(request);
    for(const output of outputs)writeGameFrame(socket,output);
    return data;
  }
  handleGameplayHttp(request,cookie) {
    if(!this.ready||!this.options.postEntryState?.careEconomy?.health)throw new Error('GAMEPLAY_NOT_ENABLED');
    const input=parseToolbarCookies(cookie),issuer=this.ticketAuthenticator.ticketIssuer;
    const identity=this.allowLocalQqsignTicket&&typeof issuer.verifyBoundHex==='function'
      ?issuer.verifyBoundHex(input.sign,{serviceId:0x00200e01}):issuer.verifyHex(input.sign,{serviceId:0x00200e01});
    if(identity.uin!==input.uin)throw new Error('GAMEPLAY_AUTH_FAILED');
    const live=[...this.connections].filter(([socket,c])=>!socket.destroyed&&socket.writable&&!c.closed&&!c.logoutCount
      &&c.notificationHeader&&c.authenticatedUin===identity.uin&&c.profile?.petIdBytes.readBigUInt64LE()===input.petId);
    if(live.length!==1)throw new Error('GAMEPLAY_AUTH_FAILED');
    const [socket,channel]=live[0],send=outputs=>{for(const output of outputs)writeGameFrame(socket,output);};
    if(request.operation==='item-buy'||request.operation==='item-use') {
      const care=this.options.postEntryState.careEconomy;
      let item=request.operation==='item-buy'?care.items.get(request.cid):null;
      if(!item){const owned=care.inventorySummary(identity.uin,channel.profile.petIdBytes).find(i=>Number(i.gid)===request.gid);item=owned&&care.items.get(owned.cid);}
      if(!item)return {result:1,msg:'背包里没有这个物品'};
      const report=channel.careRequest(request.operation==='item-buy'?{operation:'buy',cid:item.cid,type:item.subkind+1,count:request.count,pay:'yb',nonce:request.nonce}
        :{operation:'use',gid:request.gid,type:item.subkind+1,nonce:request.nonce});send(report.outputs);return report.data;
    }
    if(request.operation.startsWith('home-')) {
      const home=this.options.legacyHome;if(!home)return {result:1,msg:'家园暂未开放'};
      const current=channel.timeSession.profile(channel.profile),result=home.manage(current,request,this.options.clock?.()??Date.now());
      if(result.result===0&&result.target) {
        const target=Buffer.alloc(8);target.writeBigUInt64LE(BigInt(result.target));
        const messages=home.handle(HOME_COMMANDS.visit,Buffer.concat([current.petIdBytes,target]),current,channel.homeContext);
        send(messages.map(m=>channel.createSpatialNotification(m.command,m.body)).filter(Boolean));
        if(messages[0]?.body.readUInt32BE()!==0){result.result=1;result.msg='这个家园暂时无法进入';delete result.target;}
        else {result.msg='已经到达小伙伴的家园啦';
          if(request.operation==='home-accept')home.database.prepare('DELETE FROM legacy_home_invite_v1 WHERE host=? AND target=?')
            .run(request.target,current.petIdBytes.readBigUInt64LE().toString());}
      }
      if(result.result===0&&['home-rename','home-select'].includes(request.operation))for(const [other,c] of this.connections) {
        const host=c.homeContext.homeHost??c.profile?.petIdBytes;
        if(!other.destroyed&&other.writable&&c.homeContext.inHome&&host?.equals(current.petIdBytes)) {
          const p=c.timeSession.profile(c.profile),message=home.notification(p,home.scene(current),c.homeContext);
          const frame=c.createSpatialNotification(message.command,message.body);if(frame)other.write(frame);
          // A21 carries the changed configuration key. HomeSystem requests A01
          // and updates its own cache; an unsolicited A01 for a ready key is ignored.
        }
      }
      if(result.result===0&&request.operation==='home-invite'){
        const target=Buffer.alloc(8);target.writeBigUInt64LE(BigInt(request.target));
        channel.homeContext.pendingInvites??=[];channel.homeContext.pendingInvites.push(target);
      }
      if(result.result===0&&!['home-state','home-random'].includes(request.operation))send(channel.careNotifications('attributes'));
      this.spatialPresence.synchronize(this.connections);return result;
    }
    const report=channel.gameplayRequest(request);send(report.outputs);
    if(request.operation==='state'&&report.data.result===0) {
      const p=channel.timeSession.profile(channel.profile),care=this.options.postEntryState.careEconomy.profile(identity.uin,p.petIdBytes);
      report.data.profile={name:new TextDecoder('gb18030').decode(p.login.petName).replace(/\0.*$/s,''),level:p.login.levelValue,
        sex:care.sex==='male'?0:1,strength:care.strength,intelligence:care.intelligence,charm:care.charm};
      if(this.options.legacyHome)report.data.home=this.options.legacyHome.manage(p,{operation:'home-state'});
    }
    return report.data;
  }
  handleCareHttp(authority,target) {
    if(!this.ready||!this.options.postEntryState?.careEconomy)throw new Error('CARE_NOT_ENABLED');
    const request=parseCareHttpRequest(authority,target);
    const issuer=this.ticketAuthenticator.ticketIssuer;
    const identity=this.allowLocalQqsignTicket && typeof issuer.verifyBoundHex==='function'
      ? issuer.verifyBoundHex(request.sign,{serviceId:0x00200e01}) : issuer.verifyHex(request.sign,{serviceId:0x00200e01});
    if(identity.uin!==request.uin)throw new Error('CARE_AUTH_FAILED');
    const targets=[...this.connections].filter(([socket,channel])=>!socket.destroyed&&socket.writable
      &&!channel.closed&&!channel.logoutCount&&channel.authenticatedUin===identity.uin
      &&channel.profile?.petIdBytes.readBigUInt64LE()===request.petId&&channel.notificationHeader);
    if(!targets.length)throw new Error('CARE_AUTH_FAILED');
    const [socket,channel]=targets[0];
    const {data,outputs}=request.operation.startsWith('vip-native-')?channel.gameplayRequest(request):channel.careRequest(request);
    for(const output of outputs)writeGameFrame(socket,output);
    return data;
  }

  // The HTML market pages request web.pet.qq.com/fcgi-bin/market with the identity the
  // WebLogic cookie producer writes (PET_UIN/PET_ID/PET_SIGN). The verification block is
  // the same one handleCareHttp/handleToolbarHttp use; the parsed HTML operation carries no
  // identity itself, so an unverified uin/petId never reaches the economy.
  handleMarketHtml(authority,target,cookie) {
    if(!this.ready||!this.options.postEntryState?.careEconomy)throw new Error('MARKET_NOT_ENABLED');
    const wardrobe=this.options.postEntryState?.wardrobe;
    const request=parseMarketHtmlRequest(authority,target,{wardrobeEnabled:Boolean(wardrobe)});
    const input=parseToolbarCookies(cookie);
    const issuer=this.ticketAuthenticator.ticketIssuer;
    const identity=this.allowLocalQqsignTicket&&typeof issuer.verifyBoundHex==='function'
      ? issuer.verifyBoundHex(input.sign,{serviceId:0x00200e01}) : issuer.verifyHex(input.sign,{serviceId:0x00200e01});
    if(identity.uin!==input.uin)throw new Error('MARKET_AUTH_FAILED');
    const targets=[...this.connections].filter(([socket,channel])=>!socket.destroyed&&socket.writable
      &&!channel.closed&&!channel.logoutCount&&channel.authenticatedUin===identity.uin
      &&channel.profile?.petIdBytes.readBigUInt64LE()===input.petId&&channel.notificationHeader);
    // Exactly one active channel: two matches would make the pet ambiguous and a write
    // would land on whichever the map happened to yield first.
    if(targets.length!==1)throw new Error(targets.length===0?'MARKET_AUTH_FAILED':'MARKET_CHANNEL_AMBIGUOUS');
    const [socket,channel]=targets[0];
    // A notification failure happens strictly after the write's checkpoint closed, so it
    // must not be reported as a failed request: the operation is remembered as committed
    // and the caller returns the client's own "processed, refresh" outcome instead. A
    // failure before the commit still throws, and is never turned into a claimed commit.
    let notifyFailed=false;
    const sendReport=(report)=>{
      if(report.notified===false)notifyFailed=true;
      try {for(const output of report.outputs)if(!writeGameFrame(socket,output))notifyFailed=true;}
      catch(error) {notifyFailed=true;}
      return report.data;
    };
    const ask=q=>sendReport(channel.careRequestReport(q));
    const askWardrobe=q=>sendReport(channel.wardrobeRequestReport(q));
    // The economy answers two shapes: the list operations nest their payload under data,
    // the write operations (cart/use) return it flat. Normalise once here.
    const payload=(read)=>read&&typeof read==='object'?(read.data&&typeof read.data==='object'?read.data:read):{};
    const merged=(()=>{try{return typeof channel.timeSession?.profile==='function'?channel.timeSession.profile(channel.profile):channel.profile;}catch{return channel.profile;}})();
    const level=merged?.login?.levelValue;
    const user=()=>({uin:identity.uin,level,...(wardrobe?{spec:String(merged.petIdBytes.readUInt32LE(4)),vip:String(merged.login.vipFlag)}:{})});
    const listPage=(operation,kind,subkind,page,spec)=> {
      const seat=wardrobe?wardrobeSeat(operation,kind,subkind):null;
      if(seat!==null) {
        const read=askWardrobe({operation:operation==='shop'?'avatar-shop':'avatar-store',seat});
        if(read?.result!==0)return {failure:projectMarketHtmlFailure(read?.result??1,payload(read).msg)};
        const body=payload(read),size=PAGE_SIZE[operation],start=(page-1)*size;
        return {read,page:projectMarketHtmlList({operation,kind,subkind,page,items:body.items.slice(start,start+size),
          total:body.items.length,user:user(),yb:body.yb,spec,projectItem:projectWardrobeMarketItem})};
      }
      const economySubkind=marketEconomySubkind(operation,kind,subkind);
      const functional=subkind===0&&(operation==='shop'?kind===3:kind===2);
      const read=ask({operation,subkind:functional?3:economySubkind??0,categoryView:'native-four-tabs'});
      if(read?.result!==0)return {failure:projectMarketHtmlFailure(read?.result??1,payload(read).msg)};
      const body=payload(read),all=economySubkind!==null&&Array.isArray(body.items)?body.items:[];
      const size=PAGE_SIZE[operation],start=(page-1)*size;
      return {read,page:projectMarketHtmlList({operation,kind,subkind,itemSubkind:economySubkind??subkind,page,items:all.slice(start,start+size),
        total:all.length,user:user(),yb:body.yb,spec})};
    };
    const inventoryRow=(key,field)=> {
      if(wardrobe&&field==='cid'&&wardrobe.items.has(Number(key))) {
        const read=askWardrobe({operation:'avatar-store',seat:0});
        return read.result===0?read.data.items.find(i=>String(i.cid)===String(key))??null:null;
      }
      for(const subkind of [0,1,2]) {
        const read=ask({operation:'store',subkind});
        if(read?.result!==0)continue;
        const row=(payload(read).items??[]).find((item)=>String(item[field])===String(key));
        if(row)return {...row,subkind};
      }
      return null;
    };
    if(request.operation==='frame') {
      const read=ask({operation:'shop',subkind:marketEconomySubkind(request.panel,request.kind,request.subkind)??0});
      if(read?.result!==0)return projectMarketHtmlFailure(read?.result??1,payload(read).msg);
      const appearance=wardrobe?askWardrobe({operation:'avatar-frame'}):null;
      if(appearance&&appearance.result!==0)return projectMarketHtmlFailure(1,appearance.msg);
      return projectMarketHtmlFrame({panel:request.panel,kind:request.kind,subkind:request.subkind,page:request.page,
        uin:identity.uin,yb:payload(read).yb,level,...(wardrobe?{avatar:appearance.avatar,spec:user().spec,vip:user().vip}:{})});
    }
    if(request.operation==='shop'||request.operation==='store') {
      const built=listPage(request.operation,request.kind,request.subkind,request.page,request.spec);
      return built.failure??built.page;
    }
    if(request.operation==='cart') {
      const read=wardrobe?askWardrobe({operation:'avatar-cart',lines:request.lines}):ask({operation:'cart',lines:request.lines});
      if(read?.result!==0)return projectMarketHtmlFailure(read?.result??1,payload(read).msg);
      // The persisted gid is read back after the commit so the store page can offer
      // "use immediately" on the real inventory row. A failed read-back is reported as
      // refreshRequired, never as a failed or repeated purchase.
      let purchased=null,refreshRequired=false;
      try{purchased=[];for(const line of request.lines){const row=inventoryRow(line.cid,'cid');
        if(!row){refreshRequired=true;continue;}purchased.push({cid:line.cid,gid:row.gid,num:row.num});}
        if(purchased.length!==request.lines.length)refreshRequired=true;
      }catch{purchased=null;refreshRequired=true;}
      // The commit succeeded but the client could not be told about it: the same explicit
      // refresh-required outcome, without the immediate-use round that would chain a second
      // action onto a session whose notification path just failed.
      if(notifyFailed){purchased=null;refreshRequired=true;}
      return projectMarketHtmlSuccess({code:0,msg:refreshRequired?'已处理，请刷新仓库确认':(payload(read).msg??'购买成功'),
        yb:payload(read).yb,total:Number.parseInt(payload(read).total??'',10),
        purchased:refreshRequired?undefined:purchased,refreshRequired:Boolean(wardrobe)&&refreshRequired});
    }
    if(request.operation==='avatar-save') {
      const read=askWardrobe(request);
      if(read.result!==0)return projectMarketHtmlFailure(read.result,read.msg);
      return projectMarketHtmlSuccess({msg:notifyFailed?'已保存，请刷新确认':read.msg,refreshRequired:notifyFailed});
    }
    if(request.operation==='use') {
      const row=inventoryRow(request.gid,'gid');
      // An unknown gid means the row is not in this pet's inventory: refuse before the
      // domain sees a write, instead of letting it fail on a derived type.
      if(!row)return projectMarketHtmlFailure(1,'背包中没有此物品');
      const read=ask({operation:'use',gid:request.gid,type:row.subkind+1});
      if(read?.result!==0)return projectMarketHtmlFailure(read?.result??1,payload(read).msg);
      if(request.context==='prompt')return projectMarketHtmlSuccess({code:0,msg:payload(read).msg??'使用成功'});
      const built=listPage('store',request.kind,request.subkind,request.page);
      return built.failure??built.page;
    }
    return projectMarketHtmlFailure(1,'操作失败');
  }

  health() {
    return Object.freeze({
      ready: this.ready,
      profile: "original-qqpenguin-login",
      endpoint: Object.freeze({
        host: this.options.host,
        port: this.options.port,
        transports: Object.freeze(["tcp"]),
      }),
      clientProcessesStarted: 0,
      nickNameNotifyCount: this.nickNameNotifyCount,
      nickNameNotifyUnaddressable: this.nickNameNotifyUnaddressable,
      nickNameNotifyFailures: this.nickNameNotifyFailures,
    });
  }

  summary() {
    const activeSessions = [...this.connections.values()].map((channel) => {
      const snapshot = channel.snapshot();
      let communitySoleProfile=false;
      let communityProfileKey=null;
      if(snapshot.authenticated){
        try {
          const profile=this.profileDirectory.resolve(channel.authenticatedUin,channel.profile.petIdBytes);
          communityProfileKey=communityProfileBinding(this.communityConnectionIds.get(channel),profile.petIdBytes);
        } catch {}
      }
      if(snapshot.authenticated && this.profileDirectory.size===1){
        try { communitySoleProfile=Boolean(this.profileDirectory.resolve(channel.authenticatedUin,channel.profile.petIdBytes)); } catch {}
      }
      return Object.freeze({
        state: snapshot.state,
        commandCounts: Object.freeze({
          ...(snapshot.loginCount === 0
            ? {}
            : { [QQPENGUIN_LOGIN_COMMAND_ID]: snapshot.loginCount }),
          ...(snapshot.helloCount === 0 ? {} : { [HELLO_COMMAND_ID]: snapshot.helloCount }),
        }),
        authenticated: snapshot.authenticated,
        // Non-authorizing, per-process/per-connection generation; no user identity.
        communityGeneration: snapshot.authenticated ? this.communityConnectionIds.get(channel) : null,
        communitySoleProfile,
        communityProfileKey,
        logoutCount: snapshot.logoutCount,
        characterEntryNotifyCount: snapshot.characterEntryNotifyCount,
        interactionRejections: snapshot.interactionRejections,
        receivedCommandCounts: snapshot.receivedCommandCounts,
        unknownCommandPolicy: snapshot.unknownCommandPolicy,
        unsupportedCommandCounts: snapshot.unsupportedCommandCounts,
        sensitiveValuesPresent: false,
      });
    });
    return Object.freeze({
      ...this.health(),
      profileCount: this.profileDirectory.size,
      connectionCount: this.connectionCount,
      activeSessionCount: this.connections.size,
      protocolErrorCount: this.protocolErrorCount,
      errorCategories: Object.freeze({ ...this.errorCategories }),
      activeSessions: Object.freeze(activeSessions),
      completedSessions: this.completedSessions.map((value) => ({ ...value })),
      completedSessionsDiscarded:this.completedSessionsDiscarded,
      connectionLimitRejections:this.connectionLimitRejections,
      privacy: Object.freeze({
        uinPresent: false,
        petIdPresent: false,
        credentialPresent: false,
        ticketPresent: false,
      }),
    });
  }

  async stop() {
    if (this.stopped) return this.summary();
    this.stopped = true;
    this.ready = false;
    clearInterval(this.manorTimer);
    clearInterval(this.gameplayTimer);
    // Flush each channel's durable time checkpoint before callers close SQLite.
    const closing = [...this.connections.keys()].map(socket => new Promise(resolve => {
      socket.once("close", resolve);
      socket.destroy();
    }));
    await closeServer(this.server);
    await Promise.all(closing);
    return this.summary();
  }
}

export async function startOriginalQqPenguinGameServer(options) {
  const server = new OriginalQqPenguinGameServer(options);
  await server.start();
  return server;
}
import {parseToolbarCookies} from '../protocol/desktop-toolbar-http.js';
import {SpatialPresence} from './spatial-presence.js';
import {HOME_COMMANDS} from '../protocol/legacy-home.js';
