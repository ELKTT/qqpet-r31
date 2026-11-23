import { randomBytes as systemRandomBytes } from "node:crypto";

import { decodeHelloRequest, encodeHelloSuccess, HELLO_COMMAND_ID } from "../protocol/hello.js";
import { decodeLoginRequest, encodeLoginSuccess } from "../protocol/login.js";
import {
  ROOT_FRAME_KEY_EXCHANGE_COMMAND_ID,
  ROOT_FRAME_RESET_KEY,
  ROOT_FRAME_SESSION_KEY_LENGTH,
} from "../root-frame/constants.js";
import { RootFrameSessionDecoder, encodeRootFrame } from "../root-frame/root-frame-codec.js";
import { QqPenguinLoginTicketAuthenticator } from "../txsso/qqpenguin-login-authenticator.js";
import { QqPenguinProfileDirectory } from "./qqpenguin-profile-directory.js";
import { CHARACTER_ENTRY_NOTIFY_COMMAND, encodeCharacterEntryNotify, encodeServerAnimation } from "../protocol/character-entry-notify.js";
import {encodeCareActionNotify} from '../protocol/care-action-notify.js';
import {encodePetSpeech} from '../protocol/pet-speech.js';
import {SPATIAL_CHAT,decodeSpatialChat} from '../protocol/spatial-chat.js';
import {COMMUNITY_EMOTION,decodeCommunityEmotion} from '../protocol/community-emotion.js';
import {decodeAdjustTimeStampRequest,encodeAdjustTimeStampSuccess} from '../protocol/adjust-time-stamp.js';
import {decodeOnlineTimeRequest} from '../protocol/online-time.js';
import {decodeCommInteractRequest,encodeCommInteractFailure} from '../protocol/comm-interact.js';
import {decodeSpecialInteractRequest,encodeSpecialInteractFailure} from '../protocol/special-interact.js';
import {decodeDailyTaskInfoRequest,encodeDailyTaskInfoResponse} from '../protocol/daily-task-info.js';
import {decodeToolbarAdRequest} from '../protocol/toolbar-ad.js';
import {decodeWeatherQueryRequest,encodeWeatherQueryFailure} from '../protocol/weather-query.js';
import {decodeLoadingReport} from '../protocol/loading-report.js';
import {decodeLogoutRequest,LOGOUT_COMMAND_ID,PAUSE_GROWTH_LOGOUT_REASON} from '../protocol/logout.js';
import {decodePetInfoRequest,encodePetInfoSuccess,PET_INFO_COMMAND_ID} from '../protocol/pet-info.js';
import {decodeAvatarInfoRequest,encodeAvatarVersion,AVATAR_INFO_COMMAND_ID,AVATAR_VERSION_COMMAND_ID} from '../protocol/community-avatar.js';
import {decodeFlashBusinessRequest,FLASH_BUSINESS_COMMAND_ID} from '../protocol/flash-business.js';
import {decodeAutoFeedRequest,AUTO_FEED_COMMAND_ID} from '../protocol/auto-feed.js';
import {decodeOtherPetInfoRequest,OTHER_PET_INFO_COMMAND_ID} from '../protocol/other-pet-info.js';
import {COMMUNITY_FRIEND_COMMANDS} from '../protocol/community-friends.js';
import {encodeAttributeChangeNotify,encodeStatusChangeNotify,decodeEnterNormalStatus,encodeEnterNormalStatusResult,encodeNickNameChangeNotify} from '../protocol/pet-state-notify.js';

export const QQPENGUIN_LOGIN_COMMAND_ID = 0x0530;

export class OriginalRootChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OriginalRootChannelError";
    this.code = code;
  }
}

function makeHeader(frame, commandId, body) {
  return {
    unknown_0x02: Buffer.from(frame.unknown_0x02),
    versionMajor: frame.versionMajor,
    versionMinor: frame.versionMinor,
    unknown_0x0c: frame.unknown_0x0c,
    commandId,
    body,
  };
}

export class OriginalRootChannel {
  constructor({ ticketAuthenticator, profileDirectory, sessionKeyFactory = systemRandomBytes, postEntryState, legacyHome, legacyCommunity, clock=Date.now, unknownCommandPolicy='reject' } = {}) {
    if(!['reject','record-only'].includes(unknownCommandPolicy))throw new TypeError('INVALID_UNKNOWN_COMMAND_POLICY');
    this.unknownCommandPolicy=unknownCommandPolicy;
    this.unsupportedCommandCounts={};
    if (!(ticketAuthenticator instanceof QqPenguinLoginTicketAuthenticator)) {
      throw new TypeError("ticketAuthenticator must be a QqPenguinLoginTicketAuthenticator");
    }
    if (!(profileDirectory instanceof QqPenguinProfileDirectory)) {
      throw new TypeError("profileDirectory must be a QqPenguinProfileDirectory");
    }
    if (typeof sessionKeyFactory !== "function") {
      throw new TypeError("sessionKeyFactory must be a function");
    }
    this.ticketAuthenticator = ticketAuthenticator;
    this.profileDirectory = profileDirectory;
    this.sessionKeyFactory = sessionKeyFactory;
    this.decoder = new RootFrameSessionDecoder({
      encrypted: true,
      key: Buffer.from(ROOT_FRAME_RESET_KEY),
    });
    this.sessionKey = null;
    this.profile = null;
    this.authenticatedUin = null;
    this.closed = false;
    this.loginCount = 0;
    this.helloCount = 0;
    this.notificationHeader = null;
    this.characterEntryNotifyCount = 0;
    this.initialPetInfoSent = false;
    this.receivedCommandCounts = {};
    this.postEntryState=postEntryState;
    if(legacyHome!==undefined&&(typeof legacyHome.accepts!=='function'||typeof legacyHome.handle!=='function'))throw new TypeError('INVALID_LEGACY_HOME');
    this.legacyHome=legacyHome;this.homeContext={inHome:false};
    if(legacyCommunity!==undefined&&(typeof legacyCommunity.accepts!=='function'||typeof legacyCommunity.handle!=='function'))throw new TypeError('INVALID_LEGACY_COMMUNITY');
    this.legacyCommunity=legacyCommunity;this.communityContext={inCommunity:false};
    this.clock=clock;
    this.timeSession=null;
    this.interactionRejections=0;
    this.logoutCount=0;
    this.growthPaused=false;
    this.rootContinuationPending=false;
    this.lastCareYuanbao=null;
  }

  #encode(frame, commandId, body, key) {
    return encodeRootFrame(makeHeader(frame, commandId, body), { encrypted: true, key });
  }

  #createSessionKey() {
    const key = this.sessionKeyFactory(ROOT_FRAME_SESSION_KEY_LENGTH);
    if (!Buffer.isBuffer(key) || key.length !== ROOT_FRAME_SESSION_KEY_LENGTH) {
      throw new OriginalRootChannelError(
        "INVALID_SESSION_KEY_SOURCE",
        "sessionKeyFactory must return exactly 16 bytes",
      );
    }
    return Buffer.from(key);
  }

  #handleLogin(frame) {
    const request = decodeLoginRequest(frame.body);
    const identity = this.ticketAuthenticator.authenticate(request);
    const profile = this.profileDirectory.resolve(identity.uin, frame.unknown_0x02);
    if (this.authenticatedUin !== null && (this.authenticatedUin !== identity.uin ||
        !this.profile.petIdBytes.equals(profile.petIdBytes))) {
      throw new OriginalRootChannelError(
        "SESSION_IDENTITY_CHANGED",
        "a Root session cannot change its authenticated identity",
      );
    }
    this.authenticatedUin = identity.uin;
    this.profile = profile;
    if(this.postEntryState && !this.timeSession)this.timeSession=this.postEntryState.open(identity.uin,profile.petIdBytes);
    this.lastGameplayHealth=(this.timeSession?.profile(profile)??profile).login.unknown_0x4b;
    const outputs = [];
    if (this.sessionKey === null) {
      const nextKey = this.#createSessionKey();
      const keyBody = Buffer.concat([Buffer.from([ROOT_FRAME_SESSION_KEY_LENGTH]), nextKey]);
      outputs.push(
        this.#encode(
          frame,
          ROOT_FRAME_KEY_EXCHANGE_COMMAND_ID,
          keyBody,
          ROOT_FRAME_RESET_KEY,
        ),
      );
      this.sessionKey = nextKey;
      this.decoder = new RootFrameSessionDecoder({ encrypted: true, key: this.sessionKey });
    }
    const response = this.profileDirectory.createLoginSuccess(request, this.timeSession?.profile(profile) ?? profile);
    outputs.push(
      this.#encode(frame, QQPENGUIN_LOGIN_COMMAND_ID, encodeLoginSuccess(response), this.sessionKey),
    );
    this.loginCount += 1;
    this.growthPaused=false;
    // OnlineManager publishes ResumeGrowth/ReLogin success to its UI listeners
    // before the next periodic Hello. Restore the authenticated request header
    // at that accepted continuation so friend/shop requests do not fail in that
    // interval. Ordinary first entry still waits for its original Hello.
    if([1,3].includes(request.unknown_0x42))this.notificationHeader=makeHeader(frame,0,Buffer.alloc(0));
    return outputs;
  }

  #handleHello(frame) {
    if (this.profile === null || this.sessionKey === null) {
      throw new OriginalRootChannelError(
        "HELLO_BEFORE_LOGIN",
        "Hello is not allowed before an authenticated Login",
      );
    }
    if(!frame.unknown_0x02.equals(this.profile.petIdBytes))throw new OriginalRootChannelError('HELLO_STATE_MISMATCH','Hello requires the authenticated pet');
    decodeHelloRequest(frame.body);
    const current=this.timeSession?.profile(this.profile) ?? this.profile;
    const response = this.profileDirectory.createHelloSuccess(current);
    this.helloCount += 1;
    this.notificationHeader = makeHeader(frame, 0, Buffer.alloc(0));
    if(this.postEntryState?.careEconomy?.health) {
      const login=current.login;
      this.lastGameplaySignature=JSON.stringify([login.levelValue,login.unknown_0x47,login.unknown_0x49,login.unknown_0x4b,login.unknown_0x4e,login.unknown_0x67]);
      this.lastGameplayStatus=login.statusId;
    }
    const outputs=[this.#encode(frame, HELLO_COMMAND_ID, encodeHelloSuccess(response), this.sessionKey)];
    if(this.postEntryState?.careEconomy&&this.lastCareYuanbao!==current.login.unknown_0x67) {
      outputs.push(this.#encode(frame,0x0550,encodeAttributeChangeNotify(current.login,this.postEntryState.careEconomy.policy.notifyUnknownByte),this.sessionKey));
      this.lastCareYuanbao=current.login.unknown_0x67;
    }
    return outputs;
  }

  careRequest(request) {
    if(this.closed||this.logoutCount||!this.timeSession||!this.notificationHeader||!this.postEntryState?.careEconomy)
      throw new Error('CARE_SESSION_UNAVAILABLE');
    const result=this.timeSession.care(request);
    return {data:result.data,outputs:this.careNotifications(result.notify,result.careAction,result.animation)};
  }
  // The HTML market contract needs "nothing was written" told apart from "the write is
  // committed but the client could not be told": by the time the notification frames are
  // encoded, the entry checkpoint that owns the write has already closed, so an encoding
  // failure is reported as a separate field instead of thrown. A failure *before* this
  // point still throws: nothing may claim a commit that did not happen. The Flash contract
  // keeps careRequest unchanged.
  careRequestReport(request) {
    if(this.closed||this.logoutCount||!this.timeSession||!this.notificationHeader||!this.postEntryState?.careEconomy)
      throw new Error('CARE_SESSION_UNAVAILABLE');
    const result=this.timeSession.care(request);
    try {
      return {data:result.data,outputs:this.careNotifications(result.notify,result.careAction,result.animation),notified:true};
    } catch(error) {
      return {data:result.data,outputs:[],notified:false};
    }
  }
  wardrobeRequestReport(request) {
    if(this.closed||this.logoutCount||!this.timeSession||!this.notificationHeader||!this.postEntryState?.wardrobe)
      throw new Error('WARDROBE_SESSION_UNAVAILABLE');
    const result=this.timeSession.wardrobe(request);
    try {
      const outputs=this.careNotifications(result.notify);
      if(result.avatarVersion!==undefined)outputs.push(this.#encode(this.notificationHeader,AVATAR_VERSION_COMMAND_ID,
        encodeAvatarVersion(result.avatarVersion),this.sessionKey));
      return {data:result.data,outputs,notified:true};
    } catch {return {data:result.data,outputs:[],notified:false};}
  }
  toolbarRequest(request) {
    if(this.closed||this.logoutCount||!this.timeSession||!this.notificationHeader||!this.postEntryState?.desktopTasks)
      throw new Error('TOOLBAR_SESSION_UNAVAILABLE');
    const result=this.timeSession.toolbar(request);
    const outputs=this.careNotifications(result.notify);
    // DailyTask 13F60 filters only the command; 13C90 has no request/busy
    // latch. Root 2D20 broadcasts to registered matching receivers. Once the
    // client has initialized this consumer, publish a committed snapshot,
    // never a decrement and never a pre-commit projection.
    if(result.notify)outputs.push(...this.#dailyTaskNotifications(true));
    return {data:result.data,outputs};
  }
  #dailyTaskNotifications(force=false) {
    const header=this.dailyTaskHeader??this.notificationHeader;
    if(!this.dailyTaskInitialized||!header||typeof this.timeSession?.dailyTask!=='function')return [];
    const now=this.clock();
    // DailyTask 44D0 increments on whole-minute DataCenter updates, including
    // session time restarted after ResumeGrowth. It does not know the persistent
    // claim ledger. Reassert a snapshot even when its value stayed zero; sending
    // only changed counts leaves those independent increments on the desktop.
    if(!force&&this.lastDailyTaskPublishAt!==undefined&&now>=this.lastDailyTaskPublishAt&&now-this.lastDailyTaskPublishAt<1000)return [];
    const body=encodeDailyTaskInfoResponse(this.timeSession.dailyTask());
    this.lastDailyTaskPublishAt=now;
    return [this.#encode(header,0x2203,body,this.sessionKey)];
  }
  careNotifications(kind,careAction,animation) {
    if(!kind)return [];
    const current=this.timeSession.profile(this.profile),unknown=this.postEntryState.careEconomy.policy.notifyUnknownByte;
    const frames=[];
    if(current.login.unknown_0x4b===0&&(careAction==='death'||this.lastGameplayHealth>0))frames.push(this.#encode(this.notificationHeader,0x0554,encodeCareActionNotify('death-transition'),this.sessionKey));
    this.lastGameplayHealth=current.login.unknown_0x4b;
    frames.push(this.#encode(this.notificationHeader,0x0550,encodeAttributeChangeNotify(current.login,unknown),this.sessionKey));
    this.lastCareYuanbao=current.login.unknown_0x67;
    if(kind==='status')frames.push(this.#encode(this.notificationHeader,0x0551,encodeStatusChangeNotify(current.login,unknown),this.sessionKey));
    // timeSession.care has committed before this point. This is an independent
    // kind-2 action, never the once-per-session first-entry notification.
    // FeedLogic CDeadStateMonitor (17A0 -> 1C5D) queues relive/42 on
    // the committed dead -> healthy attribute transition. A second 0554
    // queues the same animation twice.
    if(careAction!==undefined&&careAction!=='revive'&&careAction!=='death')frames.push(this.#encode(this.notificationHeader,CHARACTER_ENTRY_NOTIFY_COMMAND,
      encodeCareActionNotify(careAction),this.sessionKey));
    // Native action queue: greet the owner before the activity transition.
    if(animation?.speech)frames.push(this.#encode(this.notificationHeader,0x0554,encodePetSpeech(animation.speech),this.sessionKey));
    if(animation?.action)frames.push(this.#encode(this.notificationHeader,0x0554,encodeServerAnimation({action:animation.action}),this.sessionKey));
    return frames;
  }
  createSpatialNotification(command,body) {
    const header=this.spatialHeader??this.notificationHeader;
    if(!header||this.closed||this.logoutCount||!this.sessionKey)return null;
    return this.#encode(header,command,body,this.sessionKey);
  }
  createGameplayNotifications() {
    if(this.closed||this.logoutCount||!this.notificationHeader||!this.timeSession||!this.postEntryState?.careEconomy?.health)return {outputs:[],exit:false};
    const current=this.timeSession.profile(this.profile),login=current.login;
    const events=this.timeSession.drainGameplayEvents(),outputs=[];
    // Queue the existing transition before the attribute change lets FeedLogic
    // append its original dead/41 and dead_state/43. Never replay it on dead login.
    if(this.lastGameplayHealth>0&&login.unknown_0x4b===0)outputs.push(this.#encode(this.notificationHeader,0x0554,encodeCareActionNotify('death-transition'),this.sessionKey));
    this.lastGameplayHealth=login.unknown_0x4b;
    const signature=JSON.stringify([login.levelValue,login.unknown_0x47,login.unknown_0x49,login.unknown_0x4b,login.unknown_0x4e,login.unknown_0x67]);
    const unknown=this.postEntryState.careEconomy.policy.notifyUnknownByte;
    if(this.lastGameplaySignature!==undefined&&signature!==this.lastGameplaySignature)
      outputs.push(this.#encode(this.notificationHeader,0x0550,encodeAttributeChangeNotify(login,unknown),this.sessionKey));
    if(this.lastGameplayStatus!==undefined&&login.statusId!==this.lastGameplayStatus)
      outputs.push(this.#encode(this.notificationHeader,0x0551,encodeStatusChangeNotify(login,unknown),this.sessionKey));
    this.lastGameplaySignature=signature;this.lastGameplayStatus=login.statusId;
    outputs.push(...this.#dailyTaskNotifications());
    for(const event of events) {
      const action=event.kind==='auto-feed'?'feed':event.kind==='auto-clean'?'clean':event.kind==='hungry'?'hungry':event.kind==='itchy'?'dirty':event.kind==='death'?'death'
        :event.kind==='illness'?'sick':null;
      if(action&&action!=='death')outputs.push(this.#encode(this.notificationHeader,0x0554,encodeCareActionNotify(action),this.sessionKey));
      if(event.message)outputs.push(this.#encode(this.notificationHeader,0x0554,encodePetSpeech(event.message),this.sessionKey));
    }
    const exit=this.timeSession.shouldAutoExit();
    if(exit){outputs.push(this.#encode(this.notificationHeader,0x0554,encodeCareActionNotify('leave'),this.sessionKey));this.logoutCount++;}
    return {outputs,exit};
  }
  gameplayRequest(request) {
    if(!this.timeSession||!this.notificationHeader||this.closed||this.logoutCount)throw new Error('GAMEPLAY_NOT_AUTHENTICATED');
    const data=this.timeSession.gameplay(request),outputs=[];
    if(!['state','vip-native-info'].includes(request.operation)&&data.result===0) {
      outputs.push(...this.careNotifications(data.careAction==='medicine'||request.operation.startsWith('embrace-')?'status':'attributes',data.careAction));
      const current=this.timeSession.profile(this.profile);
      outputs.push(this.#encode(this.notificationHeader,PET_INFO_COMMAND_ID,encodePetInfoSuccess(current,current.growthSpeed),this.sessionKey));
    }
    return {data,outputs};
  }

  createInitialPetInfoNotification() {
    // BODU 1AB8 initializes its distinct 0532 observer with allow-notification=1.
    // BasicProtocol 7510 stores it at +108, bypassing only the request-busy gate.
    // Send a single current snapshot after authenticated Hello, before UI entry.
    if(this.closed||this.logoutCount||!this.notificationHeader||!this.profile||!this.sessionKey
      ||!this.timeSession||!this.postEntryState?.onlineVitals||this.initialPetInfoSent)return null;
    const current=this.timeSession.profile(this.profile);
    const output=this.#encode(this.notificationHeader,PET_INFO_COMMAND_ID,
      encodePetInfoSuccess(current,current.growthSpeed),this.sessionKey);
    this.initialPetInfoSent=true;
    return output;
  }

  createCharacterEntryNotification({firstAdoption=false}={}) {
    // Explicit caller policy only; Login/Hello do not automatically send it.
    if (this.closed || this.logoutCount || !this.notificationHeader || this.characterEntryNotifyCount !== 0) return null;
    const encode=selection=>this.#encode(this.notificationHeader,CHARACTER_ENTRY_NOTIFY_COMMAND,encodeCharacterEntryNotify({firstAdoption,...selection}),this.sessionKey);
    const output=this.timeSession?.animation?this.timeSession.animation('entry',{firstAdoption},encode):encode({});
    this.characterEntryNotifyCount += 1;
    return output;
  }

  // The original name-only push the client parses as CNickNameChangeNotify (protocol id 0x0552).
  // It carries the two names the session's current profile serves, so a committed rename reaches
  // a running client without waiting for its next 0x0532 request. A session that cannot be
  // addressed (no key exchange, no Hello-derived notification header, closed or logged out)
  // returns null: its next request already answers with the committed name, so nothing is queued.
  createNickNameChangeNotification() {
    if (this.closed || this.logoutCount || this.sessionKey === null || !this.notificationHeader || !this.profile) return null;
    return this.#encode(this.notificationHeader, 0x0552,
      encodeNickNameChangeNotify(this.profile), this.sessionKey);
  }

  createFriendNotifications() {
    if(this.closed||this.logoutCount||this.growthPaused||!this.notificationHeader||!this.sessionKey||!this.profile)return [];
    this.friendNotificationContext??={};
    return (this.postEntryState?.friends?.relations.notifications(this.profile.petIdBytes,this.friendNotificationContext)??[])
      .map(p=>this.#encode(this.notificationHeader,p.command,p.body,this.sessionKey));
  }
  createManorRefreshNotification() {
    const c=this.manorContext;
    if(!c||c.refillAt===null||this.closed||this.logoutCount||!this.notificationHeader)return null;
    if(this.postEntryState.now()<c.refillAt)return null;
    const body=this.timeSession.flash(c.request);
    c.refillAt=null; // One publication per depletion; the next four claims rearm it.
    return this.#encode(c.frame,FLASH_BUSINESS_COMMAND_ID,body,this.sessionKey);
  }

  ingest(chunk) {
    if (this.closed) {
      throw new OriginalRootChannelError("CHANNEL_CLOSED", "Root channel is closed");
    }
    // A successful logout is terminal, including further data already in flight.
    if (this.logoutCount) return [];
    const decoded = this.decoder.ingest(Buffer.from(chunk));
    if (decoded.closed) {
      throw new OriginalRootChannelError(
        decoded.error?.code ?? "ROOT_DECODE_FAILED",
        "Root frame decoding failed",
      );
    }
    const outputs = [];
    for (const frame of decoded.frames) {
      // Command numbers only; never retain request payloads or identity values.
      const key = Object.hasOwn(this.receivedCommandCounts, frame.commandId)
        || Object.keys(this.receivedCommandCounts).length < 32 ? frame.commandId : "other";
      this.receivedCommandCounts[key] = (this.receivedCommandCounts[key] ?? 0) + 1;
    }
    for (const frame of decoded.frames) {
      // OnlineManager stops its monitor after the pause acknowledgement. Ignore
      // in-flight business/Hello without reopening time or closing the Root.
      if(this.growthPaused&&![QQPENGUIN_LOGIN_COMMAND_ID,LOGOUT_COMMAND_ID].includes(frame.commandId))continue;
      if (frame.commandId === QQPENGUIN_LOGIN_COMMAND_ID) {
        outputs.push(...this.#handleLogin(frame));
      } else if(COMMUNITY_FRIEND_COMMANDS.includes(frame.commandId)&&this.postEntryState?.friends) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!this.notificationHeader
          ||this.logoutCount||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new Error('COMMUNITY_FRIENDS_NOT_AUTHENTICATED');
        const state=this.postEntryState;
        const replies=state.friends.communityPackets(frame.commandId,frame.body,this.authenticatedUin,this.profile.petIdBytes,
          (uin,id)=>state.active.has(`${uin}:${id.toString('hex')}`));
        for(const reply of replies)outputs.push(this.#encode(frame,reply.command,reply.body,this.sessionKey));
      } else if(frame.commandId===OTHER_PET_INFO_COMMAND_ID&&this.postEntryState?.friends) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!this.notificationHeader||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new Error('OTHER_PET_INFO_NOT_AUTHENTICATED');
        const request=decodeOtherPetInfoRequest(frame.body);
        if(!this.postEntryState.friends.find(this.authenticatedUin,this.profile.petIdBytes.readBigUInt64LE().toString()))
          throw new Error('OTHER_PET_INFO_NOT_AUTHENTICATED');
        this.manorContext=null;
        outputs.push(this.#encode(frame,frame.commandId,this.postEntryState.friends.otherInfo(request.petId,this.authenticatedUin),this.sessionKey));
      } else if(frame.commandId===0x0535&&this.postEntryState?.careEconomy) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!this.notificationHeader||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new Error('CARE_SESSION_UNAVAILABLE');
        const {status}=decodeEnterNormalStatus(frame.body),success=this.timeSession.stopActivity(status);
        outputs.push(this.#encode(frame,0x0535,encodeEnterNormalStatusResult(success),this.sessionKey));
        if(success)outputs.push(...this.careNotifications('status'));
      } else if(frame.commandId===AUTO_FEED_COMMAND_ID&&this.postEntryState?.membership) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('AUTO_FEED_STATE_MISMATCH','Authenticated pet required');
        const body=this.timeSession.setAutoCare(decodeAutoFeedRequest(frame.body));
        outputs.push(this.#encode(frame,AUTO_FEED_COMMAND_ID,body,this.sessionKey));
      } else if(frame.commandId===AVATAR_INFO_COMMAND_ID&&this.postEntryState?.wardrobe) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('AVATAR_INFO_STATE_MISMATCH','Authenticated pet required');
        const request=decodeAvatarInfoRequest(frame.body);
        this.timeSession.profile(this.profile);
        // Native community requests up to 100 IDs; 053A accepts at most ten records per response.
        for(let offset=0;offset<Math.max(1,request.petIds.length);offset+=10)
          outputs.push(this.#encode(frame,AVATAR_INFO_COMMAND_ID,this.postEntryState.wardrobe.infoResponse(request.petIds.slice(offset,offset+10)),this.sessionKey));
      } else if (frame.commandId === PET_INFO_COMMAND_ID && this.postEntryState?.onlineVitals) {
        if(!this.profile||!this.sessionKey||!this.timeSession||!frame.unknown_0x02.equals(this.profile.petIdBytes)) {
          throw new OriginalRootChannelError('PET_INFO_STATE_MISMATCH','Pet info requires the authenticated pet');
        }
        const request=decodePetInfoRequest(frame.body);
        if(request.petId!==this.profile.petIdBytes.readBigUInt64LE())throw new OriginalRootChannelError('PET_INFO_STATE_MISMATCH','Pet info requires the authenticated pet');
        const current=this.timeSession.profile(this.profile);
        outputs.push(this.#encode(frame,PET_INFO_COMMAND_ID,encodePetInfoSuccess(current,current.growthSpeed),this.sessionKey));
      } else if (frame.commandId === LOGOUT_COMMAND_ID && this.postEntryState?.logoutResponse) {
        if (!this.profile || !this.sessionKey || !frame.unknown_0x02.equals(this.profile.petIdBytes)) {
          throw new OriginalRootChannelError('LOGOUT_STATE_MISMATCH','Logout requires the authenticated pet');
        }
        const request=decodeLogoutRequest(frame.body);
        const body=Buffer.from(this.postEntryState.logoutResponse);
        body.writeUInt16BE(request.reason,2);
        // Commit before acknowledging. A failed checkpoint must never report success.
        const encode=selection=>{
          // OnlineManager 8120 -> D420 copies the response tail to MAIN (+8),
          // preserving local 202 only in SUB (+0x244) as the load-failure fallback.
          if(selection)body.writeUInt32BE(selection.action,8);
          return this.#encode(frame,LOGOUT_COMMAND_ID,body,this.sessionKey);
        };
        let reply;
        if(request.reason===0&&this.timeSession&&this.postEntryState.serverAnimations)reply=this.timeSession.close(encode);
        else{reply=encode();this.timeSession?.close();}
        this.timeSession=null;
        this.notificationHeader=null;
        this.homeContext.inHome=false;this.communityContext.inCommunity=false;
        this.manorContext=null;
        this.dailyTaskHeader=null;
        this.lastDailyTaskPublishAt=undefined;
        outputs.push(reply);
        if(request.reason===PAUSE_GROWTH_LOGOUT_REASON) {
          // ResumeGrowth sends Login type1 over this same Root and key. The
          // bound ticket lives with the connection, even past its launch TTL.
          this.growthPaused=true;
          continue;
        }
        this.logoutCount++;
        break; // Never process pipelined Hello/Login after a terminal logout.
      } else if (frame.commandId === HELLO_COMMAND_ID) {
        outputs.push(...this.#handleHello(frame));
      } else if (frame.commandId === COMMUNITY_EMOTION.send && this.legacyCommunity) {
        if(!this.profile||!this.sessionKey||this.authenticatedUin===null||this.growthPaused||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('EMOTION_NOT_AUTHENTICATED','Emotion requires an active authenticated pet');
        const message=decodeCommunityEmotion(frame.body),allowed=this.communityContext.inCommunity&&!this.homeContext.inHome;
        this.spatialHeader=frame;
        if(allowed){this.pendingEmotions??=[];if(this.pendingEmotions.length<32)this.pendingEmotions.push(message);}
        const result=Buffer.alloc(8);result.writeUInt32BE(allowed?0:1);outputs.push(this.#encode(frame,frame.commandId,result,this.sessionKey));
      } else if ([SPATIAL_CHAT.homeSend,SPATIAL_CHAT.communitySend].includes(frame.commandId)) {
        if(!this.profile||!this.sessionKey||this.authenticatedUin===null||this.growthPaused||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('CHAT_NOT_AUTHENTICATED','Chat requires an active authenticated pet');
        const message=decodeSpatialChat(frame.commandId,frame.body);
        const allowed=message.kind==='home'?this.legacyHome&&this.homeContext.inHome&&message.host.equals(this.homeContext.homeHost??this.profile.petIdBytes)
          :this.legacyCommunity&&this.communityContext.inCommunity&&!this.homeContext.inHome;
        this.spatialHeader=frame;
        if(allowed){this.pendingChat??=[];if(this.pendingChat.length<32)this.pendingChat.push(message);}
        if(message.kind==='community'){const result=Buffer.alloc(8);result.writeUInt32BE(allowed?0:1);outputs.push(this.#encode(frame,frame.commandId,result,this.sessionKey));}
      } else if (this.legacyCommunity?.accepts(frame.commandId)) {
        // Community/Home reconnect requests are direct replies to an accepted
        // Login. OnlineManager's periodic Hello can arrive later; its header
        // is required for unsolicited notifications, not for these replies.
        if(!this.profile||!this.sessionKey||this.authenticatedUin===null||this.growthPaused||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('LEGACY_COMMUNITY_NOT_AUTHENTICATED','Community requires an active authenticated pet');
        const current=this.timeSession?.profile(this.profile)??this.profile;
        this.spatialHeader=frame;
        for(const reply of this.legacyCommunity.handle(frame.commandId,frame.body,current,this.communityContext)){
          outputs.push(this.#encode(frame,reply.command,reply.body,this.sessionKey));
          // An accepted world entry owns the active location even when the
          // native return path does not send HOME.Leave as a separate request.
          if([0x1102,0x1103,0x110a].includes(frame.commandId)&&reply.body.readUInt32BE()===0){
            this.homeContext.inHome=false;this.homeContext.homeHost=null;
          }
          if(frame.commandId===0x1108&&reply.body.readUInt32BE()===0)this.rootContinuationPending=true;
        }
      } else if (this.legacyHome?.accepts(frame.commandId)) {
        if(!this.profile||!this.sessionKey||this.authenticatedUin===null||this.growthPaused
          ||!frame.unknown_0x02.equals(this.profile.petIdBytes))
          throw new OriginalRootChannelError('LEGACY_HOME_NOT_AUTHENTICATED','Home requires an active authenticated pet');
        const current=this.timeSession?.profile(this.profile)??this.profile;
        this.spatialHeader=frame;
        for(const reply of this.legacyHome.handle(frame.commandId,frame.body,current,this.homeContext,this.clock())){
          outputs.push(this.#encode(frame,reply.command,reply.body,this.sessionKey));
          if(frame.commandId===0xa08&&reply.body.readUInt32BE()===0)this.rootContinuationPending=true;
        }
      } else if ([0x1101,0x2216,0x053b,0x053c,0x2203,0x0563,0x1501,0x0584].includes(frame.commandId)) {
        if(!this.profile || !this.sessionKey || !frame.unknown_0x02.equals(this.profile.petIdBytes)) {
          throw new OriginalRootChannelError('POST_ENTRY_STATE_MISMATCH','Post-entry request requires the authenticated pet');
        }
        let body,playNotification=false;
        if(frame.commandId===0x0584) {
          decodeLoadingReport(frame.body);
          continue; // Known one-way report. No reply or payload retention.
        }
        if(frame.commandId===0x1101) {
          const request=decodeAdjustTimeStampRequest(frame.body),now=this.clock();
          if(!Number.isSafeInteger(now)||now<0)throw new Error('INVALID_SERVER_CLOCK');
          body=encodeAdjustTimeStampSuccess({type:'AdjustTimeStampSuccess',sentClientTime:request.sentClientTime,serverTime:BigInt(now)});
        } else if(frame.commandId===0x2216) {
          decodeOnlineTimeRequest(frame.body);
          if(!this.timeSession)throw new OriginalRootChannelError('ONLINE_TIME_NOT_CONFIGURED','Explicit online time state is required');
          body=this.timeSession.response();
        } else if(frame.commandId===0x1501) {
          decodeWeatherQueryRequest(frame.body);
          body=encodeWeatherQueryFailure(1);
        } else if(frame.commandId===0x0563) {
          decodeToolbarAdRequest(frame.body);
          if(!this.postEntryState?.toolbarAdResponse)throw new OriginalRootChannelError('TOOLBAR_AD_NOT_CONFIGURED','Explicit toolbar advertisement configuration is required');
          body=Buffer.from(this.postEntryState.toolbarAdResponse);
        } else if(frame.commandId===0x2203) {
          decodeDailyTaskInfoRequest(frame.body);
          this.dailyTaskHeader=makeHeader(frame,0,Buffer.alloc(0));
          this.dailyTaskInitialized=true;
          // Live first: the answer follows the claim ledger of the authenticated pet. The
          // startup block is only the fallback for an assembly without the toolbar module.
          if(this.timeSession&&typeof this.timeSession.dailyTask==='function')
            body=encodeDailyTaskInfoResponse(this.timeSession.dailyTask());
          else if(this.postEntryState?.dailyTaskResponse)
            body=Buffer.from(this.postEntryState.dailyTaskResponse);
          else throw new OriginalRootChannelError('DAILY_TASK_NOT_CONFIGURED','Explicit daily task information is required');
          this.lastDailyTaskPublishAt=this.clock();
        } else if(frame.commandId===0x053b) {
          const request=decodeSpecialInteractRequest(frame.body);
          body=this.postEntryState?.playRewards?this.timeSession.specialInteract(request):encodeSpecialInteractFailure(1);
          if(body.readUInt16BE(0)!==0)this.interactionRejections++;
        } else {
          const request=decodeCommInteractRequest(frame.body);
          const play=this.postEntryState?.playRewards&&request.items.length===1&&request.items[0].type===105;
          body=play?this.timeSession.playInteraction(request):this.postEntryState?.petBusiness?this.timeSession.interact(request):encodeCommInteractFailure(1);
          playNotification=Boolean(play);
          if(body.readUInt16BE(0)!==0)this.interactionRejections++;
        }
        outputs.push(this.#encode(frame,frame.commandId,body,this.sessionKey));
        if(frame.commandId===0x2216)outputs.push(...this.#dailyTaskNotifications(true));
        if((frame.commandId===0x053b||playNotification)&&body.readUInt16BE(0)===0&&this.notificationHeader&&this.postEntryState?.careEconomy)
          outputs.push(...this.careNotifications('attributes'));
      } else {
        if(frame.commandId===FLASH_BUSINESS_COMMAND_ID&&this.postEntryState?.petBusiness) {
          if(!this.profile||!this.sessionKey||!this.timeSession||!frame.unknown_0x02.equals(this.profile.petIdBytes))
            throw new OriginalRootChannelError('FLASH_BUSINESS_NOT_AUTHENTICATED','Authenticated pet required');
          const request=decodeFlashBusinessRequest(frame.body);
          if([6,9].includes(request.head.game)) {
            if(request.head.game===9&&[9,10].includes(request.head.cmd)&&!this.notificationHeader)
              throw new Error('MANOR_REQUIRES_HELLO');
            const body=this.timeSession.flash(request);
            outputs.push(this.#encode(frame,frame.commandId,body,this.sessionKey));
            const manor=this.postEntryState.petBusiness.manor;
            if(manor&&[6,9].includes(request.head.game)&&request.head.cmd===9) {
              const data=JSON.parse(body.subarray(2)).data;
              this.manorContext=data.cResult===0?{frame:makeHeader(frame,0,Buffer.alloc(0)),request,
                refillAt:manor.deadline(this.authenticatedUin,this.profile.petIdBytes,request.data.ullPetID)}:null;
            } else if(manor&&[6,9].includes(request.head.game)&&request.head.cmd===10) {
              if(this.manorContext?.request.data.ullPetID===request.data.ullPetID)
                this.manorContext.refillAt=manor.deadline(this.authenticatedUin,this.profile.petIdBytes,request.data.ullPetID);
              if(JSON.parse(body.subarray(2)).data.cResult===0&&this.postEntryState.careEconomy)
                outputs.push(...this.careNotifications('attributes'));
            } else {
              this.manorContext=null;
              // Harvest yb is the animation's award, not a wallet snapshot.
              // Publish the committed balance through the original 0550 path.
              const result=JSON.parse(body.subarray(2)).data;
              if(([2,5,8].includes(request.head.cmd)&&result.result===0
                  ||[6,9].includes(request.head.game)&&request.head.cmd===6&&[1,2].includes(result.result))
                  &&this.notificationHeader&&this.postEntryState.careEconomy)
                outputs.push(...this.careNotifications('attributes'));
            }
            continue;
          }
        }
        if(this.unknownCommandPolicy==='record-only' && this.profile && this.sessionKey
            && frame.unknown_0x02.equals(this.profile.petIdBytes)) {
          const key=Object.hasOwn(this.unsupportedCommandCounts,frame.commandId)
            || Object.keys(this.unsupportedCommandCounts).length<32 ? frame.commandId : 'other';
          this.unsupportedCommandCounts[key]=(this.unsupportedCommandCounts[key]??0)+1;
          continue; // No invented reply, no payload retention, authenticated session stays open.
        }
        throw new OriginalRootChannelError(
          "UNKNOWN_REQUIRED_COMMAND",
          "Root command is not registered in the original login contract",
        );
      }
    }
    return outputs;
  }

  close() {
    if (this.closed) return this.snapshot();
    this.closed = true;
    this.homeContext.inHome=false;
    this.communityContext.inCommunity=false;
    this.timeSession?.close();
    if (!this.decoder.closed) this.decoder.end();
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      state: this.closed
        ? "closed"
        : this.logoutCount !== 0
          ? "logged-out"
        : this.growthPaused
          ? "paused"
        : this.profile === null
          ? "negotiating"
          : this.helloCount === 0
            ? "pet-loaded"
            : "online",
      loginCount: this.loginCount,
      logoutCount: this.logoutCount,
      helloCount: this.helloCount,
      characterEntryNotifyCount: this.characterEntryNotifyCount,
      receivedCommandCounts: Object.freeze({ ...this.receivedCommandCounts }),
        communityResult:this.communityContext.lastResult?Object.freeze({...this.communityContext.lastResult}):null,
      authenticated: this.profile !== null && this.logoutCount === 0,
      interactionRejections:this.interactionRejections,
      unknownCommandPolicy:this.unknownCommandPolicy,
      unsupportedCommandCounts:Object.freeze({...this.unsupportedCommandCounts}),
      sensitiveValuesPresent: false,
    });
  }
}
