import {writeGameFrame} from '../runtime/bounded-socket-write.js';
import {parsePetShowRequest,petShowImageRoute} from '../protocol/petshow-http.js';
import {petBirthdayDate} from '../original-data/animation-calendar.js';
import {portraitImage,portraitList} from '../original-webdir/petinfo-portraits.js';
import {LocalAccountDirectory} from '../txsso/account-directory.js';
import {QQPENGUIN_SERVICE_ID} from '../txsso/service-id.js';
import {QqPenguinProfileDirectory} from '../original-login/qqpenguin-profile-directory.js';
import {OriginalQqPenguinGameServer} from '../original-login/qqpenguin-game-server.js';
import {OriginalWebdirServer} from '../original-webdir/original-webdir-server.js';
import {OriginalWebdirProfileDirectory} from '../original-webdir/webdir-profile-directory.js';
import {LocalSessionTicketIssuer} from './session-ticket-issuer.js';
import {buildQqPenguinStartParam,buildPetlessQqPenguinStartParam} from '../original-webdir/webdir-profile-directory.js';
import {zoneTemplateAgainstPort} from './zone-template.js';
import {gameIpv4SAddr} from '../deployment/endpoints.js';
import {resolveServerListener} from '../deployment/server-listener.js';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parsePetInfoHttpRequest,petInfoXml} from '../protocol/petinfo-http.js';
import {parseFriendHttpRequest,parseFriendMessageRequest,friendXml,friendGameXml} from '../protocol/friend-http.js';
import {PetinfoReceipts,currentRequestKey} from './petinfo-receipts.js';
import {WearableCatalogue} from '../original-webdir/wearable-catalogue.js';
import {PetProvisioning,gbkEncode,AccountError} from '../accounts/account-service.js';
import {isRenameCard} from '../original-data/pet-care-economy.js';

const ADOPTION_TOKEN_TTL_MS=600000;
const FIRST_ADOPTION_NICKNAME='Q宠宝贝';
// The page the client's own browser is navigated to when the start parameters carry no pet. It is
// the path the authoritative client's own string table names (web.pet.qq.com/tuoq/index.html) and
// the only address this server answers under it.
const ADOPT_PAGE_PATH='/tuoq/index.html';
const ADOPT_SUBMIT_PATH='/tuoq/adopt';
// What the submission route answers. Its identity is the pair of cookies the client's own cookie
// writer put in its browser immediately before the navigation that opened this page (see
// adoptIdentityCookies); a request without a resolvable pair is refused with this one code, this
// one message and no write of any kind, whatever else it carries. The constant was named
// ADOPTION_REQUIRES_LOGIN_WINDOW while the route was deliberately not connected and the only
// identity-bearing entry was the launcher's private channel; the route is connected now, so the
// name states what is actually missing - a verifiable client identity - and the negatives that
// used to be grouped under it stay in place, split by that one criterion.
const ADOPT_REFUSAL_CODE='ADOPTION_NOT_AUTHENTICATED';
const ADOPT_REFUSAL_MESSAGE='领养未开始：本请求没有可验证的客户端身份。请由客户端自己打开领养窗口后重新选择。';
// The two outcomes a submission can have besides the refusal: the pet was created (or was already
// there, which is the same answer for the client that is about to re-read its own start
// parameters), or the choice was cancelled. Neither is a failure, and neither carries a credential.
const ADOPT_CREATED_CODE='ADOPTION_CREATED';
const ADOPT_CREATED_MESSAGE='领养完成，正在继续入场…';
const ADOPT_CANCELLED_CODE='ADOPTION_CANCELLED';
const ADOPT_CANCELLED_MESSAGE='已取消，可以重新选择。';
const ADOPT_ASSET_PREFIX='/tuoq/asset/';
// The page's own artwork, copied from the authoritative resources (the dialog background from
// res/Plugins/PetLogin/UI/adoptbg.png and the plugin's cancel button skin) plus historical movie and user
// designated for the gender choice. Only these names are served, each as the file it was copied
// from; a name the page does not own resolves to nothing.
const ADOPT_PAGE_ASSETS=new Map([['adoptbg.png','adoptbg.png'],['cancel-up.png','cancel-up.png'],
  ['cancel-down.png','cancel-down.png'],['adopt.swf','adopt.swf'],
  ['male-normal.png','male-normal.png'],['male-highlight.png','male-highlight.png'],
  ['female-normal.png','female-normal.png'],['female-highlight.png','female-highlight.png']]);
// The client's own cookie writer (PetLogin_20160519_181721.dll, sha256 92bc7e68…, sub_10009B00 at
// RVA 0x9b00) runs in the adoption branch and, immediately before it navigates AdoptWebBrowser to
// this page, writes four cookies for the qq.com domain with InternetSetCookieA:
//
//   PET_SIGN_TYPE   ← DCN_STR_SIGN_TYPE      (RVA 0x9bb0)
//   PET_SIGN        ← DCN_STR_SSOSIGN, or DCN_STR_QQSIGN when that is empty  (RVA 0x9bf5/0x9c10)
//   PET_UIN         ← "%lu" of DCN_INT_QQNUMBER  (RVA 0x9c66)
//   PENGUIN_VERSION ← "%d" of DCN_INT_ROOTVERSION (RVA 0x9ca3)
//
// The registered web-login plugin WebLogic_20131209_154318.dll (sha256 6c7916ad…, sub_10015550)
// writes the same four with the same two-source fallback for PET_SIGN and adds PET_ID/PET_WEATHER/
// PET_VIP/PET_CLASS. So whichever of the two writes last, PET_SIGN carries DCN_STR_QQSIGN in this
// route, and in this route DCN_STR_QQSIGN is the petless boot credential: the bridge writes it
// into CPetStartParam+76 (see the D notes) and QQStartParamParser projects it into
// DCN_STR_QQSIGN, which is what the server issued for that account at its petless authentication.
//
// That pair - the account and a credential this server issued for it - is the whole identity of a
// page request, and it is resolved, never inferred: a cookie whose sign is not a live boot of that
// exact account (or that account's own already-promoted value) authorizes nothing. No query
// parameter, Host, Referer, source address, recently authenticated account or guessable name is
// consulted, and the 32-hex adoption handle of the private channel is never accepted here.
const ADOPT_COOKIE_UIN='pet_uin';
const ADOPT_COOKIE_SIGN='pet_sign';
const ADOPT_COOKIE_MAX_LENGTH=2048;
const xmlEscape=(value)=>String(value).replace(/[&<>"']/gu,
  (character)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
// The two cookies above, and nothing else in the header. A repeated name is not a choice between
// two values, and a header that cannot be read at all is not an identity: both are refused by
// returning no identity, which the caller answers exactly like an absent one.
function adoptIdentityCookies(cookie) {
  if(typeof cookie!=='string'||cookie.length===0||cookie.length>ADOPT_COOKIE_MAX_LENGTH)return {uin:null,sign:null};
  const values=new Map();
  for(const part of cookie.split(';')) {
    const at=part.indexOf('=');
    if(at<1)return {uin:null,sign:null};
    const name=part.slice(0,at).trim().toLowerCase();
    if(values.has(name))return {uin:null,sign:null};
    values.set(name,part.slice(at+1).trim());
  }
  return {uin:values.get(ADOPT_COOKIE_UIN)??null,sign:values.get(ADOPT_COOKIE_SIGN)??null};
}

// `derivable` answers whether this server can produce an account's start parameters itself. It is
// what makes a configuration valid after an account adopts: the document does not have to list a
// pet that did not exist when it was written. Without it the document still has to be complete,
// and an account that is in neither place refuses the whole assembly.
function bindings(accounts,profiles,directory,gamePort,derivable=()=>false,gameIp=0x0100007f) {
  const accountUins=new Set(accounts.map(account=>account.uin));
  const rootKeys=new Set(), matched=new Set(), byUin=new Map();
  for(const profile of profiles) {
    if(!accountUins.has(profile.uin))throw new TypeError('LOCAL_PROFILE_OWNER_MISSING');
    if(byUin.has(profile.uin))throw new TypeError('LOCAL_LOGIN_REQUIRES_UNIQUE_ACCOUNT_PET');
    byUin.set(profile.uin,profile);
    rootKeys.add(`${profile.uin}:${profile.petIdBytes.readBigUInt64LE()}`);
  }
  // Accounts without a pet are registered but not yet adopted: they authenticate and are then
  // routed to adoption, and they are never given a placeholder pet here.
  const petless=new Set([...accountUins].filter(uin=>!byUin.has(uin)));
  for(const record of directory.records.values()) {
    if(record.productName!=='QQPenguin')throw new TypeError('UNSUPPORTED_WEBDIR_PRODUCT');
    const payload=record.payload;
    if(payload.kind==='Prelogin')continue;
    if(payload.kind!=='QQPenguin')throw new TypeError('UNSUPPORTED_WEBDIR_PAYLOAD');
    const key=`${record.uin}:${payload.petIdDecimal}`;
    // Pairing stays per identity: a record has to name an account this server actually serves, and
    // that account's pet. A record for an unknown account, or for one whose pet is different, is
    // refused - an equal number of records and roots is not evidence that they pair up. An account
    // that adopted after the document was written is covered by derivation instead, which needs no
    // record at all.
    if(!accountUins.has(record.uin))throw new TypeError('WEBDIR_PROFILE_UNKNOWN_ACCOUNT');
    if(petless.has(record.uin))throw new TypeError('WEBDIR_PROFILE_FOR_PETLESS_ACCOUNT');
    if(!rootKeys.has(key))throw new TypeError('WEBDIR_ROOT_IDENTITY_MISMATCH');
    for(const zone of [payload.zone,payload.lastZone]) {
      if(zone.ip!==gameIp || zone.port!==gamePort)throw new TypeError('WEBDIR_GAME_ENDPOINT_MISMATCH');
    }
    matched.add(key);
  }
  if(matched.size!==rootKeys.size) {
    for(const profile of profiles) {
      const key=`${profile.uin}:${profile.petIdBytes.readBigUInt64LE()}`;
      if(matched.has(key))continue;
      // The same identity and endpoint conditions the document is held to: a derived account
      // must exist with exactly one pet, and it is served on the configured loopback endpoint.
      if(derivable(profile.uin)!==true)throw new TypeError('WEBDIR_ROOT_PROFILE_MISSING');
      matched.add(key);
    }
  }
  return {byUin,petless};
}

// The zone and version block a derived account inherits. The configured document's own
// QQPenguin record is still the first source: nothing new is invented for a document that
// already carries the block. A document without a QQPenguin record falls back to the declared
// zone template when the assembly provides one, which is what lets a fresh install hand out
// start parameters before any record exists; with neither, derivation stays off and the server
// refuses rather than guessing a zone.
function openZoneTemplate(directory,gamePort,declared,gameIpv4='127.0.0.1') {
  const gameIp=gameIpv4SAddr(gameIpv4);
  for(const record of directory.records.values()) {
    if(record.productName!=='QQPenguin'||record.payload.kind!=='QQPenguin')continue;
    const payload=record.payload;
    if(payload.zone.ip!==gameIp||payload.zone.port!==gamePort)throw new TypeError('WEBDIR_GAME_ENDPOINT_MISMATCH');
    return Object.freeze({versions:{...record.versions},
      lastZone:{...payload.lastZone},zone:{...payload.zone},resourceDomain:payload.resourceDomain});
  }
  return declared===undefined?null:zoneTemplateAgainstPort(declared,gamePort,gameIpv4);
}

// Explicit compatibility entry. It owns no TXSSO transport, client process,
// system registration, routing, or credential logging.
export class LocalLoginClientServer {
  #accounts; #profiles; #petless=new Set();
  #authCount=0; #authFailures=0;
  // Handles a petless authentication hands to its own caller: an adoption may then be bound to
  // the just-authenticated account without re-sending a credential and without trusting an
  // arbitrary account name. Tokens are short lived and replay-safe by construction. They are
  // never published: the only holder is the private caller the authentication answered.
  #adoptionTokens=new Map();
  // The petless-state startup data of the same authentication, in its own namespace: a 64-hex boot
  // credential the server issues for one account and supersedes on that account's next boot. It is
  // not a petful entry ticket: it is recorded apart from the session leases (verifyBoundHex never
  // sees it), no HTTP route takes it while the account has no pet, and the account's own state
  // decides when it becomes the entry credential of the pet an adoption created.
  #petlessBootCount=0; #petlessPromotionCount=0;
  // What the client's own adoption page did, counted where it happened. The run package reports
  // these instead of inferring them from the page: how often the page and its artwork were
  // requested, how many choices were submitted, how many of them created the pet, how many were a
  // repeat of the account's own committed adoption, how many were cancellations, and how many were
  // refused for lacking a resolvable identity. See handleAdoptPageHttp for what each of those
  // means and what it writes (creation writes one pet and one receipt; the other three write
  // nothing at all).
  #adoptPageCounts={pageRequestCount:0,assetRequestCount:0,submissionCount:0,adoptedCount:0,
    replayedCount:0,cancelledCount:0,refusedCount:0};
  // Publication faults are recorded per account and reported through health()/summary(): a
  // committed rename whose directory or active-channel publication failed must say so instead
  // of pretending the in-memory state moved.
  profilePublishFailures=new Map();
  // How many times a committed change had to isolate a stale live session because it could not
  // be published. Reported in summary() so the run package states it instead of hiding it.
  publishIsolationCount=0;
  // The committed-rename push (0x0552) over the account's live Root session: frames written,
  // sessions that could not be addressed yet (their next 0x0532 request answers the new name),
  // and write failures. Reported through health()/summary() so none of the three is silent.
  nickNameNotifyCount=0;
  nickNameNotifyUnaddressable=0;
  nickNameNotifyFailures=0;
  // Finite business refusal counts only; never retain names, identities or tickets.
  petRenameRefusals={missingCard:0,catalogueMismatch:0,cardUnmapped:0};
  constructor({accounts,profiles,webdirProfiles,webdirZoneTemplate,postEntryState,legacyHome,legacyCommunity,legacyCommunityResources,playMenu,careResources,toolbarResources,marketPages,legacyCommunityEntries,desktopGame,accountWeb,accountService,store,provisioning,wearableCatalogue=null,
    gameHost,gamePort,webdirHost,webdirPort,deploymentEndpoints,
    clock=Date.now,randomBytes,sessionKeyFactory,ticketTtlMs=120000,maxTickets=128,
    petlessBootTtlMs,unknownCommandPolicy='reject'}={}) {
    const gameBinding=resolveServerListener('game',{host:gameHost,port:gamePort,deploymentEndpoints});
    const webBinding=resolveServerListener('web',{host:webdirHost,port:webdirPort,deploymentEndpoints,allowLegacyHttp80:Boolean(legacyCommunityResources)});
    gameHost=gameBinding.host;gamePort=gameBinding.port;webdirHost=webBinding.host;webdirPort=webBinding.port;
    this.deployment=gameBinding.config;
    const publishedGame=this.deployment?.public.game??{ipv4:'127.0.0.1',port:gamePort};
    this.publishedGame=Object.freeze({...publishedGame});
    this.#accounts=new LocalAccountDirectory(accounts);
    const profileDirectory=new QqPenguinProfileDirectory(profiles);
    const canonicalProfiles=[...profileDirectory.records.values()].flatMap(byPet=>[...byPet.values()]);
    let directory=new OriginalWebdirProfileDirectory(webdirProfiles,{protocolOwnsPetName:true});
    if(this.deployment)directory=directory.withGameEndpoint(publishedGame);
    if(this.deployment)directory=directory.withResourceHost(new URL(this.deployment.public.webOrigin).host);
    if(accountService!==undefined&&(typeof accountService?.authenticate!=='function'))
      throw new TypeError('INVALID_ACCOUNT_SERVICE');
    if(store!==undefined&&typeof store?.profileForUin!=='function')throw new TypeError('INVALID_ACCOUNT_STORE');
    if(accountService!==undefined&&store===undefined)throw new TypeError('ACCOUNT_SERVICE_REQUIRES_STORE');
    const prepared=bindings(accounts,canonicalProfiles,directory,publishedGame.port,
      (uin)=>Boolean(store)&&store.profileForUin(uin).length===1,gameIpv4SAddr(publishedGame.ipv4));
    this.#profiles=prepared.byUin;this.#petless=prepared.petless;
    // Live identity: the account service verifies the credential and the store answers with the
    // pet that exists right now, so an account registered or adopted while this server runs needs
    // no restart. Without those two the constructor snapshot stays the only source, exactly as
    // before.
    if(accountService!==undefined&&(typeof accountService?.authenticate!=='function'))
      throw new TypeError('INVALID_ACCOUNT_SERVICE');
    if(store!==undefined&&typeof store?.profileForUin!=='function')throw new TypeError('INVALID_ACCOUNT_STORE');
    if(accountService!==undefined&&store===undefined)throw new TypeError('ACCOUNT_SERVICE_REQUIRES_STORE');
    if(provisioning!==undefined&&typeof provisioning?.adopt!=='function')throw new TypeError('INVALID_PROVISIONING');
    if(accountWeb!==undefined&&typeof accountWeb?.start!=='function')throw new TypeError('INVALID_ACCOUNT_WEB');
    this.accountWeb=accountWeb??null;
    this.accountService=accountService??null;this.store=store??null;this.provisioning=provisioning??null;
    // The zone a derived account is sent to is the one the configured document already uses, so
    // no new endpoint contract is introduced for a newly adopted pet; without a record the
    // declared template stands in, and with neither there is no derivation.
    this.webdirTemplate=openZoneTemplate(directory,publishedGame.port,webdirZoneTemplate,publishedGame.ipv4);
    if(this.webdirTemplate&&this.deployment)this.webdirTemplate=Object.freeze({...this.webdirTemplate,
      resourceDomain:new URL(this.deployment.public.webOrigin).host});
    if(gameHost===webdirHost&&gamePort===webdirPort)throw new TypeError('LISTENER_PORT_COLLISION');
    if(Boolean(careResources)!==Boolean(postEntryState?.careEconomy))throw new TypeError('CARE_REQUIRES_HTTP_AND_STATE');
    if(Boolean(toolbarResources)!==Boolean(postEntryState?.desktopTasks))throw new TypeError('TOOLBAR_REQUIRES_HTTP_AND_STATE');
    // The HTML market needs both the page service copy and the write path through the
    // live Root, exactly like the care contract; one without the other is a half entry.
    if(marketPages!==undefined&&!postEntryState?.careEconomy)throw new TypeError('MARKET_REQUIRES_HTTP_AND_STATE');
    if(Boolean(desktopGame)&&!marketPages)throw new TypeError('DESKTOP_GAME_REQUIRES_MARKET');
    if(legacyCommunityEntries!==undefined&&!marketPages)throw new TypeError('LEGACY_ENTRY_REQUIRES_MARKET');
    this.ticketIssuer=new LocalSessionTicketIssuer({clock,ttlMs:ticketTtlMs,maxTickets,randomBytes,
      ...(petlessBootTtlMs===undefined?{}:{petlessBootTtlMs})});
    this.clock=clock;
    this.postEntryState=postEntryState;
    this.friends=postEntryState?.friends;
    if(this.friends&&(this.friends.database!==store?.database||this.friends.accounts!==accountService))
      throw new TypeError('FRIENDS_REQUIRE_SHARED_ACCOUNTS_AND_STORE');
    // The registered wearables are a browsable category, not a sellable one. The catalogue is
    // optional: without the deployed document the route simply is not served.
    if(wearableCatalogue!==undefined&&wearableCatalogue!==null
        &&typeof wearableCatalogue?.list!=='function')throw new TypeError('INVALID_WEARABLE_CATALOGUE');
    this.wearableCatalogue=wearableCatalogue??null;
    // The rename panel's request receipts: one row per (operation, pet, target name, submitting
    // account, cache-buster) the client actually sent. A retransmitted request lands on its own
    // receipt and is answered without touching a card or a name, while a genuinely new request
    // — including deliberately renaming back to an earlier name — carries a new cache-buster
    // and is processed normally. The session credential is deliberately NOT part of the identity:
    // it is ephemeral, so a row bound to it would be unreachable after a restart or a re-login —
    // the very replay the receipt exists to answer — and the stale retransmission would instead
    // burn another card and roll the newer committed name back. No credential is stored either way.
    // The receipts are versioned explicitly: rows written before the key carried a version are
    // marked unrecorded instead of being mistaken for current ones, and the boundary is a
    // recorded fact. See petinfo-receipts.js for why those rows cannot be matched or migrated.
    if(store?.database) {
      this.receipts=new PetinfoReceipts({database:store.database,clock,accountService:accountService??null});
      this.receipts.upgrade();
    }
    this.game=new OriginalQqPenguinGameServer({profiles:canonicalProfiles,ticketIssuer:this.ticketIssuer,
      deploymentEndpoints,host:gameHost,port:gamePort,postEntryState,legacyHome,legacyCommunity,clock,sessionKeyFactory,unknownCommandPolicy,allowLocalQqsignTicket:true});
    this.webdir=new OriginalWebdirServer({profiles:directory,host:webdirHost,port:webdirPort,playMenu,careResources,toolbarResources,
      deploymentEndpoints,marketPages,legacyCommunityEntries,legacyCommunityResources,desktopGame,
      careHandler:careResources?(authority,target)=>this.game.handleCareHttp(authority,target):undefined,
      careCatalogueHandler:careResources&&postEntryState?.careEconomy?()=>postEntryState.careEconomy.saleCatalogueXml():undefined,
      toolbarHandler:toolbarResources?(request,cookie)=>this.game.handleToolbarHttp(request,cookie):undefined,
      marketHtmlHandler:marketPages?(authority,target,cookie)=>this.game.handleMarketHtml(authority,target,cookie):undefined,
      gameplayHandler:postEntryState?.careEconomy?.health?(request,cookie)=>this.game.handleGameplayHttp(request,cookie):undefined,
      petShowHandler:(authority,target)=>this.handlePetShowHttp(authority,target),
      petInfoHandler:(authority,target)=>this.handlePetInfoHttp(authority,target),
      friendHandler:this.friends?(authority,target,body)=>this.handleFriendHttp(authority,target,body):undefined,
      wearableHandler:this.wearableCatalogue?((authority,target)=>this.handleWearableHttp(authority,target)):undefined,
      adoptPageHandler:(authority,target,cookie)=>this.handleAdoptPageHttp(authority,target,cookie),
      dynamicProfile:this.webdirTemplate?((productName,uin)=>this.#webdirProfile(productName,uin)):undefined});
    this.marketCapability=Object.freeze({pages:Boolean(marketPages),desktopEntry:Boolean(desktopGame)});
    this.ready=false;this.started=false;this.stopped=false;
  }
  // The start parameters of an account that is not in the configured document, built from the
  // pet that is actually in the store. Only the product this server owns is answered.
  //
  // An account that is registered but has no pet is answered here too, and that is the whole
  // point of this branch: the client's own reader decides "has pet" from the petid inside
  // <Common>, so a successful answer whose petid is zero is what makes the client's natural
  // path - not a 404 - reach its own adoption dialog. The answer differs from a with-pet one in
  // exactly the two values a pet that does not exist cannot have; an unknown UIN is still
  // refused, and an account with more than one pet is still refused rather than guessed at.
  #deriveProfile(productName,uin) {
    if(productName!=='QQPenguin')return null;
    // No store means no account facts at all: the derivation has nothing to answer from, and the
    // request keeps the refusal the record lookup already produced.
    if(!this.store)return null;
    const profiles=this.store.profileForUin(uin);
    if(profiles.length>1)return null;
    if(profiles.length===0) {
      if(!this.#isRegisteredAccount(uin))return null;
      const petless={kind:'QQPenguin',petIdDecimal:'0',petName:'',hideMode:0,
        lastZone:{...this.webdirTemplate.lastZone},zone:{...this.webdirTemplate.zone},
        resourceDomain:this.webdirTemplate.resourceDomain};
      return {petless:true,versioninfo:{upgradetype:this.webdirTemplate.versions.upgradetype,
        loadver:this.webdirTemplate.versions.loadver,updatever:this.webdirTemplate.versions.updatever,
        kernelver:this.webdirTemplate.versions.kernelver,kernelinfo:this.webdirTemplate.versions.kernelinfo,
        xmlinfo:buildPetlessQqPenguinStartParam(petless)}};
    }
    const profile=profiles[0];
    const bytes=profile.login.petName,end=bytes.indexOf(0);
    const petName=end<0?bytes:bytes.subarray(0,end);
    const payload={kind:'QQPenguin',petIdDecimal:profile.petIdBytes.readBigUInt64LE().toString(),
      petName:new TextDecoder('gb18030',{fatal:true}).decode(petName),hideMode:0,
      lastZone:{...this.webdirTemplate.lastZone},zone:{...this.webdirTemplate.zone},
      resourceDomain:this.webdirTemplate.resourceDomain};
    return {petless:false,versioninfo:{upgradetype:this.webdirTemplate.versions.upgradetype,
      loadver:this.webdirTemplate.versions.loadver,updatever:this.webdirTemplate.versions.updatever,
      kernelver:this.webdirTemplate.versions.kernelver,kernelinfo:this.webdirTemplate.versions.kernelinfo,
      xmlinfo:buildQqPenguinStartParam(payload,{protocolOwnsPetName:true})}};
  }
  // The account table is the one row every registration writes, so an account with no pet rows
  // that exists here is exactly the "registered, not adopted yet" state - a document this server
  // was never told about is not answered, and neither is a UIN nobody registered.
  #isRegisteredAccount(uin) {
    return Boolean(this.store.database.prepare('SELECT 1 AS present FROM account WHERE uin=?').get(uin));
  }
  // The webdir hook: the answer itself. A webdir query carries no credential, so it is answered
  // read-only and never creates a right to write: the petid="0" document is what the client's own
  // branch reads to open its adoption dialog, and that is all it gets. The right to adopt comes
  // from an authenticated petless login (see authenticate) and is handed to that login's own
  // private caller only; nothing a page or an HTTP query does can obtain it.
  #webdirProfile(productName,uin) {
    const derived=this.#deriveProfile(productName,uin);
    if(derived===null)return null;
    return derived.versioninfo;
  }
  // Two credential contracts, one entry point. With the account service assembled the caller
  // sends the account name and the password itself, which is what lets a salted credential be
  // verified and a legacy one be migrated; without it the original 16-byte digest is checked
  // against the directory exactly as before.
  authenticate(input) {
    if(!this.ready)throw new Error('LOCAL_LOGIN_UNAVAILABLE');
    let account, uinInput=null;
    try {
      if(!input || typeof input!=='object' || Array.isArray(input) || typeof input.account!=='string'
          || !/^[1-9][0-9]{0,9}$/.test(input.account) || Number(input.account)>0xffffffff)throw new Error();
      if(this.accountService) {
        if(Object.keys(input).length!==2 || !Object.hasOwn(input,'password') || typeof input.password!=='string'
            || input.password.length===0 || input.password.length>128)throw new Error();
        const live=this.accountService.authenticate({loginName:input.account,password:input.password});
        if(!live)throw new Error();
        uinInput=live.uin;
      } else {
        if(Object.keys(input).length!==2 || !Object.hasOwn(input,'credential')
            || !Buffer.isBuffer(input.credential) || input.credential.length!==16)throw new Error();
        account=this.#accounts.resolveWire(Buffer.from(input.account,'ascii'));
        if(!this.#accounts.verifyCredential(account,input.credential))throw new Error();
        uinInput=account.uin;
      }
      if(this.ticketIssuer.hasActiveRoot(uinInput))throw new Error();
    } catch {
      this.#authFailures++;throw new Error('LOCAL_AUTHENTICATION_FAILED');
    }
    const profile=this.#liveProfile(uinInput);
    // A recorded publish fault blocks a new entry until the publication succeeds: issuing an
    // entry from a directory this process could not publish would hand the client the stale
    // profile the fault is about. Recovery reads the current store, so an entry is granted only
    // once the running state agrees with the committed one.
    if(profile&&this.profilePublishFailures.has(uinInput)) {
      const recovered=this.#publishLatestProfile(uinInput,profile.petIdBytes);
      if(!recovered.ok)throw new Error('LOCAL_PROFILE_PUBLISH_FAILED');
      this.profilePublishFailures.delete(uinInput);
    }
    this.#authCount++;
    // A registered account that has not adopted yet is authenticated and reported as such: no
    // ticket and no pet are invented, so the caller can route it to adoption. The adoption
    // handle names this exact account for a bounded time, and nothing else can adopt it.
    if(!profile) {
      // Authentication is what creates the right to adopt, and that right is handed back to the
      // caller of this method alone - the launcher's private stdio channel. Nothing else receives
      // it: no page, no HTTP route and no other caller is given this handle, so the only way to
      // adopt is to have authenticated for the account first.
      const adoptToken=this.#issueAdoptionToken(uinInput);
      return {uin:uinInput,petless:true,adoptToken};
    }
    const ticket=this.ticketIssuer.issue({uin:uinInput,serviceId:QQPENGUIN_SERVICE_ID});
    // Sensitive result: caller may send only over its private, bounded IPC.
    return {uin:uinInput,petIdBytes:Buffer.from(profile.petIdBytes),ticket,
      nickname:Buffer.from(this.friends?profile.login.petName:profile.login.masterName)};
  }
  #issueAdoptionToken(uin) {
    const now=this.clock();
    for(const [token,entry] of [...this.#adoptionTokens])
      if(entry.expires<=now)this.#adoptionTokens.delete(token);
    const token=randomBytes(16).toString('hex');
    // The same authentication opens the account's petless boot: the 64-hex value the client's own
    // launch chain carries as its start sign. Issuing it supersedes that account's earlier boot, so
    // a superseded boot is neither handed out again nor able to adopt.
    const boot=this.ticketIssuer.issuePetlessBoot({uin,serviceId:QQPENGUIN_SERVICE_ID});
    this.#petlessBootCount+=1;
    this.#adoptionTokens.set(token,{uin,expires:now+ADOPTION_TOKEN_TTL_MS,bootSignHex:boot.signHex,
      bootGeneration:boot.generation});
    return token;
  }
  // The petless startup data of one live authentication, handed to that authentication's own
  // private caller and to nobody else. It names no account - the token does - and by itself it
  // authorizes nothing: while the account has no pet it resolves at the client's own login and is
  // refused by every bound HTTP route, and only the adoption transaction turns it into the entry
  // credential of the pet it created.
  petlessBoot(adoptToken) {
    if(typeof adoptToken!=='string'||!/^[a-f0-9]{32}$/.test(adoptToken))throw new Error('LOCAL_ADOPTION_REJECTED');
    const entry=this.#adoptionTokens.get(adoptToken);
    if(!entry||entry.expires<=this.clock())throw new Error('LOCAL_ADOPTION_REJECTED');
    if(this.accountService&&this.accountService.state(entry.uin).disabled)throw new Error('LOCAL_ADOPTION_REJECTED');
    let boot;
    try {boot=this.ticketIssuer.verifyPetlessBoot(entry.bootSignHex,{serviceId:QQPENGUIN_SERVICE_ID});}
    catch {throw new Error('LOCAL_ADOPTION_REJECTED');}
    if(boot.generation!==entry.bootGeneration)throw new Error('LOCAL_ADOPTION_REJECTED');
    return Object.freeze({uin:entry.uin,signHex:entry.bootSignHex,generation:boot.generation});
  }
  // The account-side kill switch for outstanding adoption handles: the same coordination a
  // disable or a credential reset runs against tickets and sessions must also take away the
  // right to adopt, or a handle issued before the disable would still mint a pet and a ticket.
  revokeAdoptionTokens(uin) {
    let revoked=0;
    for(const [token,entry] of [...this.#adoptionTokens]) {
      if(entry.uin===uin) {this.#adoptionTokens.delete(token);revoked++;}
    }
    return revoked;
  }
  // Legacy private adoption entry retained for launcher/control-channel compatibility:
  // reports the chosen gender over the private channel, bound to a token a petless
  // authentication issued. No account name travels with it and no credential is re-sent; a
  // replayed or interrupted request lands on the same pet (the adoption receipt is keyed by the
  // token), and an account that gained a pet in between is simply entered, never re-adopted.
  // Every step re-checks the account's live state: a handle that survived a disable or a
  // credential reset (or any future miss of the revocation wiring) still cannot act.
  adoptViaToken(adoptToken,gender) {
    if(!this.accountService||!this.provisioning)throw new Error('ACCOUNT_SERVICE_NOT_ASSEMBLED');
    if(typeof adoptToken!=='string'||!/^[a-f0-9]{32}$/.test(adoptToken)
        ||(gender!=='male'&&gender!=='female'))throw new Error('LOCAL_ADOPTION_REJECTED');
    const entry=this.#adoptionTokens.get(adoptToken);
    if(!entry||entry.expires<=this.clock())throw new Error('LOCAL_ADOPTION_REJECTED');
    if(this.accountService.state(entry.uin).disabled)throw new Error('LOCAL_ADOPTION_REJECTED');
    // Only the boot this authentication opened may adopt, and only while it is still the account's
    // current one: a superseded boot must not write a pet into an account whose next session
    // belongs to a newer boot. A repeated submission is the other accepted form - the value this
    // account's own committed adoption already promoted - and it answers with the same pet below
    // without running the transaction again. Both forms are read with the issuer's own rules, the
    // same ones the public page and the entry verification apply: a live boot, or a promoted value
    // whose lease is still a credential (held by a Root, or inside its own deadline). An expired
    // value satisfies neither, here as everywhere else, and does not need another request to have
    // pruned it first.
    const liveBoot=this.ticketIssuer.isPetlessBoot(entry.bootSignHex,{serviceId:QQPENGUIN_SERVICE_ID});
    if(liveBoot) {
      let authorized;
      try {authorized=this.ticketIssuer.verifyPetlessBoot(entry.bootSignHex,{serviceId:QQPENGUIN_SERVICE_ID});}
      catch {throw new Error('LOCAL_ADOPTION_REJECTED');}
      if(authorized.generation!==entry.bootGeneration)throw new Error('LOCAL_ADOPTION_REJECTED');
    } else if(!this.ticketIssuer.isPromotedPetlessBoot(entry.bootSignHex,{uin:entry.uin})) {
      throw new Error('LOCAL_ADOPTION_REJECTED');
    }
    // One transaction, the account's own receipt, the same one the page entry reaches: a repeated
    // submission is the other accepted form and answers with the same pet below.
    // The commit makes the boot credential the entry credential of the pet just created: the client
    // carries that one value from its petless boot into the Root login that follows, so the
    // conversion belongs to this same success point and a conversion that did not hold is a failed
    // adoption, not a committed pet with an answer that pretends otherwise.
    const outcome=this.#commitFirstAdoption(entry.uin,gender,`adopt:${adoptToken}`,
      liveBoot?entry.bootSignHex:null);
    if(!outcome.converted)throw new Error('LOCAL_ADOPTION_REJECTED');
    // Same shape as an authenticated entry, so the caller continues into the client unchanged -
    // and the credential in it is the one the client is already carrying: the conversion turned the
    // boot in place instead of this method asking the issuer for another credential, because a
    // second issuance is what made a committed adoption fail on a full table (review-50: with
    // maxTickets=1 the pet existed while the answer was LOCAL_TICKET_LIMIT). The slot is the one
    // the boot already occupied, so nothing here can fail for capacity after the write.
    const profile=outcome.profile;
    if(this.accountService.state(entry.uin).disabled)throw new Error('LOCAL_ADOPTION_REJECTED');
    return {uin:entry.uin,petIdBytes:Buffer.from(profile.petIdBytes),
      ticket:Buffer.from(entry.bootSignHex,'hex'),nickname:Buffer.from(this.friends?profile.login.petName:profile.login.masterName)};
  }
  handlePetShowHttp(authority,target) {
    if(petShowImageRoute(authority,target))return portraitImage(target);
    const request=parsePetShowRequest(authority,target);
    if(!this.ready||!this.store)throw new Error('PETSHOW_NOT_ENABLED');
    // The native portrait contract has no sign. Only an already-bound live pet may
    // resolve its basic appearance; no account/name/inventory fields are returned.
    const live=[...this.game.connections].filter(([socket,channel])=>!socket.destroyed&&socket.writable&&
      !channel.closed&&!channel.logoutCount&&channel.authenticatedUin&&
      channel.profile?.petIdBytes.readBigUInt64LE().toString()===request.petId);
    if(live.length!==1)throw new Error('PETSHOW_SESSION_UNAVAILABLE');
    const row=this.store.database.prepare('SELECT p.sex AS sex,q.level_value AS level FROM pet p JOIN qqpenguin_login_profile q USING(pet_id) WHERE p.pet_id=? AND p.uin=?').get(request.petId,live[0][1].authenticatedUin);
    if(!row)throw new Error('PETSHOW_PET_UNAVAILABLE');
    const wardrobe=this.postEntryState?.wardrobe;
    const avatars=wardrobe&&request.includeWardrobe!==false?wardrobe.load(request.petId).equipped:[];
    return portraitList(row,avatars);
  }

  // The in-game rename contract the original PetInfo panel speaks (web.pet.qq.com/fcgi-bin/
  // babyinfo, cmd=10 pet-info read / 11 pet rename / 12 master-name rename). The panel's
  // identity is the entry ticket itself: petsign verifies exactly like the care and market
  // handlers, the petid must be that account's pet, and the write updates both the text row
  // and the GBK wire bytes in one transaction before the live profile is rebound, so the next
  // login and the next Root both see the new name. Card deduction and name changes
  // commit atomically; refusal preserves both, and receipts prevent duplicate charges.
  handleFriendHttp(authority,target,body) {
    if(!this.ready||!this.friends)throw new Error('FRIENDS_NOT_ENABLED');
    const request=body===undefined?parseFriendHttpRequest(authority,target):parseFriendMessageRequest(authority,target,body);
    const failure=msg=>request.operation==='game'?friendGameXml(1):friendXml({result:1,msg});
    let identity;
    try {identity=this.ticketIssuer.verifyBoundHex(request.sign,{serviceId:QQPENGUIN_SERVICE_ID});}
    catch {return failure('登录状态已失效');}
    const live=[...this.game.connections].some(([socket,channel])=>
      !socket.destroyed&&socket.writable&&!channel.closed&&!channel.logoutCount&&channel.profile
      &&channel.notificationHeader&&channel.authenticatedUin===request.uin);
    if(identity.uin!==request.uin||this.accountService.state(request.uin).disabled||!live)
      return failure('登录状态已失效');
    if(request.operation==='list'){
      const p=this.friends.find(request.uin);
      return this.friends.list(request.uin,{announcements:p&&this.postEntryState?.desktopTasks?this.postEntryState.desktopTasks.announcementCount(request.uin,p.profile.petIdBytes):0});
    }
    if(request.operation==='detail')return this.friends.detail(request.targetUin,request.uin);
    if(request.operation==='goods-detail')return this.friends.detail(request.targetUin,request.uin);
    const channels=[...this.game.connections].filter(([socket,c])=>!socket.destroyed&&socket.writable
      &&!c.closed&&!c.logoutCount&&c.notificationHeader&&c.authenticatedUin===request.uin);
    if(channels.length!==1)return failure('交互状态不可用');
    if(['messages','clear-messages'].includes(request.operation))return channels[0][1].timeSession.friendInbox(request);
    const peer=this.friends.sceneOwner(request.targetUin);
    if(!peer||peer.uin===request.uin)return failure('好友不可访问');
    if(request.operation==='send-message')return channels[0][1].timeSession.friendMessage(peer,request,
      this.game.communityConnectionIds.get(channels[0][1]));
    if(request.operation==='game')return channels[0][1].timeSession.friendGame(peer,request,
      this.game.communityConnectionIds.get(channels[0][1]));
    if(!this.postEntryState?.careEconomy)return failure('喂养状态不可用');
    // Bring an already-online recipient to the current clock before applying care.
    // Offline recipients stay frozen; the item transfer itself is one transaction.
    for(const [,c] of this.game.connections)if(c.authenticatedUin===peer.uin&&c.notificationHeader&&!c.closed&&!c.logoutCount)
      c.timeSession.checkpoint();
    const result=channels[0][1].timeSession.friendCare(peer,request);
    // Attribute snapshots only: the visiting scene owns its SNS feed/bathe animation.
    if(result.data.result===0)for(const [socket,c] of this.game.connections)if(c.authenticatedUin===peer.uin
        &&c.notificationHeader&&!c.closed&&!c.logoutCount&&!socket.destroyed&&socket.writable)
      try {for(const output of c.careNotifications('attributes'))writeGameFrame(socket,output);}
      catch {socket.destroy();} // The transfer is committed; a notify failure cannot undo or retry it.
    return friendXml(result.data);
  }
  handlePetInfoHttp(authority,target) {
    if(!this.ready||!this.accountService||!this.provisioning)throw new Error('PETINFO_NOT_ENABLED');
    const request=parsePetInfoHttpRequest(authority,target);
    // The write contract follows the care path's session rule: the ticket must be BOUND to a
    // live Root. An unbound entry ticket reads nothing and writes nothing.
    let identity;
    try {
      identity=this.ticketIssuer.verifyBoundHex(request.sign,{serviceId:QQPENGUIN_SERVICE_ID});
    }catch{
      return petInfoXml(1,'auth failed');
    }
    const uin=identity.uin;
    const profiles=this.store.profileForUin(uin);
    if(profiles.length!==1||profiles[0].petIdBytes.readBigUInt64LE().toString()!==request.petId) {
      return petInfoXml(1,'pet mismatch');
    }
    const petIdBytes=profiles[0].petIdBytes;
    const petIdText=petIdBytes.readBigUInt64LE().toString();
    const row=this.store.database.prepare(
      'SELECT p.pet_name AS petName,p.master_name AS masterName,p.sex AS sex,p.birthday AS birthday,'+
      '(SELECT MIN(created_at) FROM pet_adoption_v1 d WHERE d.pet_id=p.pet_id) AS adoptedAt,'+
      'p.generation AS generation,p.vip_level AS vipLevel,q.level_value AS levelValue,q.vip_flag AS vipFlag,'+
      'q.auto_feed_flag AS autoFeed,q.pet_name_bytes AS petNameBytes,q.master_name_bytes AS masterNameBytes '+
      'FROM pet p JOIN qqpenguin_login_profile q USING(pet_id) WHERE p.pet_id=?').get(petIdText);
    if(!row)return petInfoXml(1,'pet not found');
    const decode=(bytes)=>{const end=bytes.indexOf(0);const text=end<0?bytes:bytes.subarray(0,end);
      return new TextDecoder('gb18030',{fatal:false}).decode(text);};
    const attribute=(code)=>this.store.database.prepare(
      'SELECT value FROM pet_attribute WHERE pet_id=? AND attribute_code=?').get(petIdText,code)?.value??0;
    if(request.operation==='info') {
      // The complete field set completeHandler1 consumes (review-36: 16 consumer fields,
      // pet_level as the level tag). Every value maps from the persistent/running state; the
      // unmated-pet semantics the panel branches on (mate_name === 未婚) are stated as such.
      const qqName=this.store.database.prepare('SELECT qq_name AS n FROM account WHERE uin=?').get(uin)?.n??'';
      const fields={petid:petIdText,pet_name:decode(row.petNameBytes),master_name:decode(row.masterNameBytes),
        // PetInfo.completeHandler1 appends pet_sex directly to txtInfoleft1.text.
        // Present the stored gender; unknown imported values must not become female.
        qq_name:qqName,pet_level:row.levelValue,pet_sex:row.sex==='male'?'♂':row.sex==='female'?'♀':'',pet_birth:petBirthdayDate(row.birthday,row.adoptedAt)??'',
        pet_era:row.generation??'',father_name:'',mother_name:'',mate_name:'未婚',marry_date:'',
        pet_strong:attribute('strength'),pet_IQ:attribute('intelligence'),pet_charm:attribute('charm'),
        pet_trip:this.store.database.prepare('SELECT count(*) AS n FROM pet_travel WHERE pet_id=?').get(petIdText)?.n??0,
        pet_vip:row.vipFlag??0,pet_vip_lev:row.vipLevel??0,pet_autofeed:row.autoFeed??0};
      const children=Object.entries(fields).map(([k,v])=>`<${k}>${xmlEscape(v)}</${k}>`).join('');
      return '<?xml version="1.0" encoding="UTF-8"?>' +
        `<PetInfo><result>0</result>${children}<msg></msg></PetInfo>`;
    }
    try {
      const name=PetProvisioning.validateNickname(request.name);
      const encoded=gbkEncode(name);
      if(encoded.length>15)throw new AccountError('INVALID_NICKNAME','昵称过长，最多 15 字节');
      const bytes=Buffer.alloc(16);encoded.copy(bytes);
      // The request receipt: the client's own cache-buster is the natural identifier of one
      // submission, so its retransmission lands on the row written the first time and is
      // answered without another card or another write — while an identical rename issued
      // deliberately later carries a new buster and runs normally. The identity is the account
      // and the pet, never the session credential, so a retransmission that outlives the session
      // it was sent in is still answered from its row instead of re-running the rename. Every
      // successful outcome gets a row, including the no-op ones below, so a later replay can
      // never fall through to a fresh deduction.
      const requestKey=currentRequestKey({operation:request.operation,petId:request.petId,name,uin,nonce:request.nonce});
      const sameNameAlready=(request.operation==='rename'&&row.petName===name&&decode(row.petNameBytes)===name)
        ||(request.operation==='master-rename'&&row.masterName===name&&decode(row.masterNameBytes)===name);
      const verdict=this.receipts.classify({operation:request.operation,petIdText,name,
        nonce:request.nonce,key:requestKey,sameName:sameNameAlready});
      const recordSuccess=()=>this.accountService.runTransaction(()=>{
        this.receipts.record({key:requestKey,petIdText,operation:request.operation,name,nonce:request.nonce});
      });
      // One outcome funnel: a non-zero code is answered as-is; a zero code first re-publishes
      // the LATEST committed profile. The publish step is idempotent and card-free, so a
      // retransmission (the receipt path) repairs a directory or channel that a previous
      // publication fault left behind without repeating any business transaction.
      const settle=(code,msg)=>{
        if(code!==0)return petInfoXml(code,msg);
        const published=this.#publishLatestProfile(uin,petIdBytes);
        if(!published.ok) {
          this.profilePublishFailures.set(uin,published.reason);
          // The committed change cannot be published, so the live state this account would
          // keep serving is stale by definition: the account's own channel and outstanding
          // tickets are revoked synchronously (socket.destroy is immediate, so no queued write
          // can slip through), and a later entry has to re-authenticate. Other accounts are
          // untouched, the committed business result stays, and no receipt is deleted.
          let closed=0,revokedTickets=0;
          try { closed=this.game.closeUin(uin); } catch {}
          try { revokedTickets=this.ticketIssuer.revokeUin(uin); } catch {}
          this.publishIsolationCount+=1;
          return petInfoXml(1,`改名已保存，但资料发布未完成（${published.reason}）：本账号的旧会话已失效，请重新登录`);
        }
        this.profilePublishFailures.delete(uin);
        // The committed name is pushed on the account's live session as the client's own
        // name-only notification (0x0552). It is an addition to the published state, not a
        // condition of it: the rebind above already makes every later request answer the new
        // name, so a session that cannot be addressed is counted instead of turning the
        // committed rename into a reported failure.
        const pushed=this.game.notifyNickNameChange(uin);
        this.nickNameNotifyCount+=pushed.notified;
        this.nickNameNotifyUnaddressable+=pushed.unaddressable;
        this.nickNameNotifyFailures+=pushed.failed;
        return petInfoXml(0,'修改成功');
      };
      if(verdict.kind==='receipt')return settle(verdict.code,verdict.msg);
      // A rename that cannot be proven new is refused instead of executed: the pet carries
      // receipts whose key formula is unrecorded, so this request might be a replay of one of
      // them, and executing it would roll a newer committed name back and burn another card.
      // Nothing is written and no card is touched; the block and its reason are audited, and the
      // documented transition is the operator's explicit epoch closure (see petinfo-receipts.js).
      if(verdict.kind==='refused') {
        this.accountService.audit({actorUin:uin,actorScope:'user',
          action:'pet-rename-blocked-legacy',targetUin:uin,
          detail:{petId:petIdText,operation:request.operation,unrecordedReceipts:verdict.legacyUnrecorded}});
        return petInfoXml(1,'该宠物存在旧版领取记录，无法确认本次是否为重复提交；请先关闭旧版收据纪元后再试');
      }
      // A resubmission of the name the pet already carries changes nothing and consumes
      // nothing; the outcome is still recorded, so replaying it later cannot deduct a card.
      if(sameNameAlready) {
        recordSuccess();
        return settle(0,'');
      }
      // The original confirm dialog (method15) binds the pet rename to one 改名卡. The card's
      // catalogue entry is resolved by its own name — the one fact the dialog proves — and the
      // deduction, the rename, its receipt and the audit share this transaction: no card or any
      // failure leaves the old name and the stock untouched. The master-name flow has no such
      // dialog evidence and is therefore not card-gated. No card count or price is invented.
      let cardCid=null;
      const careEconomy=this.postEntryState?.careEconomy??null;
      if(request.operation==='rename') {
        if(!careEconomy)return petInfoXml(1,'rename requires the care economy');
        const cards=[...careEconomy.items].filter(([,item])=>isRenameCard(item));
        if(cards.length!==1) {
          this.petRenameRefusals.cardUnmapped++;
          return petInfoXml(1,'改名卡目录未正确配置，请先检查物品目录');
        }
        cardCid=cards[0][0];
      }
      this.accountService.runTransaction(()=>{
          if(cardCid!==null)careEconomy.revoke(uin,petIdBytes,{cid:cardCid,count:1});
          if(request.operation==='rename') {
            this.store.database.prepare('UPDATE pet SET pet_name=? WHERE pet_id=?').run(name,petIdText);
            this.store.database.prepare('UPDATE qqpenguin_login_profile SET pet_name_bytes=? WHERE pet_id=?').run(bytes,petIdText);
          }else{
            this.store.database.prepare('UPDATE pet SET master_name=? WHERE pet_id=?').run(name,petIdText);
            this.store.database.prepare('UPDATE qqpenguin_login_profile SET master_name_bytes=? WHERE pet_id=?').run(bytes,petIdText);
          }
          this.receipts.record({key:requestKey,petIdText,operation:request.operation,name,nonce:request.nonce});
          this.accountService.audit({actorUin:uin,actorScope:'user',
            action:request.operation==='rename'?'pet-rename':'master-rename',targetUin:uin,
            detail:{petId:petIdText,operation:request.operation,cardCid:cardCid??undefined}});
      });
      // The business transaction committed; from here the only remaining step is publishing,
      // and its outcome — not the commit — is what settle() reports.
      return settle(0,'');
    }catch(error){
      const code=error&&error.code, message=error&&error.message;
      if(['INVALID_NICKNAME','NICKNAME_NOT_ENCODABLE'].includes(code))
        return petInfoXml(1,message||'name rejected');
      if(message==='CARE_INVENTORY_INSUFFICIENT') {
        this.petRenameRefusals.missingCard++;
        return petInfoXml(1,'需要一张改名卡');
      }
      if(message==='CARE_POLICY_CHANGED') {
        this.petRenameRefusals.catalogueMismatch++;
        return petInfoXml(1,'存档与物品目录版本不一致，请先检查目录配置；购买改名卡不能解决此问题');
      }
      // A storage-level failure (a commit that could not complete, a locked database) is a
      // refusal the panel recovers from — it restores the old name and the user can retry —
      // not a transport 400. Programming errors keep surfacing as errors instead of being
      // masked as a user-visible refusal.
      if(error instanceof TypeError)throw error;
      return petInfoXml(1,'改名未完成，请重试');
    }
  }
  // The wearable category the shop page reaches: a bounded, read-only list of the registered
  // 装扮 rows and their artwork. No identity is required because nothing here is per account —
  // there is no holding, no price and no action — and every entry states why it cannot be
  // bought or used.
  handleWearableHttp(authority,target) {
    if(authority!=='web.pet.qq.com')throw new TypeError('WEARABLE_ROUTE_INVALID');
    const url=new URL(target,'http://'+authority);
    const params=url.searchParams;
    if([...params.keys()].some((key)=>params.getAll(key).length!==1))throw new TypeError('WEARABLE_QUERY_DUPLICATE');
    if(url.pathname==='/wearables'||url.pathname==='/wearables/') {
      // The locally written carrier page for the category (authorised local HTML/JS): it reads
      // the same endpoint below and marks every row not sellable and not usable. The market
      // column that opened it names itself in `from` so the page can hand the user back to the
      // column they left; that one short name is the page's whole query, and anything else on
      // this URL is refused instead of being carried into the document.
      for(const [key,value] of params)
        if(key!=='from'||!/^[a-z]{1,16}$/.test(value))throw new TypeError('WEARABLE_PAGE_QUERY_INVALID');
      return {contentType:'text/html; charset=utf-8',
        body:readFileSync(new URL('../../assets/wearable-page/index.html',import.meta.url))};
    }
    if(url.pathname==='/fcgi-bin/wearables') {
      const part=params.get('part');
      const page=params.has('page')?Number(params.get('page')):1;
      if(params.has('part')&&!this.wearableCatalogue.parts[part])throw new TypeError('WEARABLE_PART_UNKNOWN');
      return {contentType:'application/json; charset=utf-8',
        body:Buffer.from(JSON.stringify(this.wearableCatalogue.list({part:params.has('part')?part:null,page})),'utf8')};
    }
    if(url.pathname.startsWith('/wearable/')) {
      const icon=this.wearableCatalogue.resolveIcon(url.pathname.slice('/wearable/'.length).replace(/\.png$/u,''));
      if(icon===null)return null;
      return {contentType:icon.contentType,body:icon.body};
    }
    throw new TypeError('WEARABLE_ROUTE_INVALID');
  }
  // The page the client's own browser opens when its start parameters carry no pet, and the route
  // its controls submit to. The page is served read-only, and that is the whole of this entry: a
  // page request and a submission are both anonymous HTTP requests under the exact host and path
  // the client's own string table names, and an anonymous HTTP request cannot prove who is asking.
  // So this route never publishes an adoption handle, never accepts one, and never writes.
  //
  // The submission route reads no parameter at all. Its answer is one constant refusal - the same
  // code, the same message and zero writes - whether it carries a gender, an action, no parameter
  // whatsoever, a well-formed handle, a forged one or a foreign one. There is no shape to probe,
  // no state to leave behind (no pet, no receipt, no ticket, no profile, no context), and no
  // oracle: an unknown, expired, revoked, spent or foreign handle is simply not a thing this route
  // can look at, because it looks at nothing.
  //
  // Adoption itself is unchanged and stays where its identity is provable: a petless login over
  // the launcher's private stdio channel returns the short-lived handle bound to the account that
  // authenticated, and adoptViaToken - reached only from that channel - performs the same single
  // idempotent adoption it always did. The public page entry is deliberately not connected until a
  // channel exists that can prove the identity of the page's own requester.
  // The page the client's own browser opens when its start parameters carry no pet, and the route
  // its HTML buttons submit to. The page is served read-only; the submission route reads exactly two
  // things - the gender (or the cancel action) from its own query, and the identity cookies the
  // client's own cookie writer put in its browser before navigating here - and resolves the
  // second to the account this server issued that credential to. Everything else about the
  // request is ignored rather than trusted: no account name, no handle, no ticket, no query
  // credential, no Host/Referer/address. A request whose pair does not resolve is refused with one
  // constant answer and writes nothing, which is the same answer for an absent cookie, a
  // malformed one, a forged one, an expired or superseded one, and one that belongs to another
  // account than the UIN it was sent with. There is no shape to probe: the only difference
  // between the answers is whether the credential resolved, and that is a fact about the issuer's
  // own records, not about the request.
  //
  // The write itself is one transaction of the same PetProvisioning the private entry uses, keyed
  // by the account (never by the credential), so a repeated or concurrent submission lands on the
  // account's own adoption receipt or on the pet it already has, and a second pet cannot be
  // created. When both are already there the answer is the same ADOPTION_CREATED the first
  // submission received, because for the client that is about to re-read its own start parameters
  // the two are the same outcome.
  handleAdoptPageHttp(authority,target,cookie='') {
    if(authority!=='web.pet.qq.com')throw new TypeError('ADOPT_PAGE_ROUTE_INVALID');
    const url=new URL(target,'http://'+authority);
    const params=url.searchParams;
    if([...params.keys()].some((key)=>params.getAll(key).length!==1))throw new TypeError('ADOPT_PAGE_QUERY_INVALID');
    if(url.pathname===ADOPT_PAGE_PATH) {
      // The page's own address takes no query at all, so no handle, context or account name can
      // ride in with the navigation. The bytes served are the pinned asset exactly as it is on
      // disk: nothing is substituted into the document, so there is no per-render value that could
      // be a secret and no placeholder for a future one.
      if([...params.keys()].length!==0)throw new TypeError('ADOPT_PAGE_QUERY_INVALID');
      this.#adoptPageCounts.pageRequestCount++;
      return {contentType:'text/html; charset=utf-8',
        body:readFileSync(new URL('../../assets/adopt-page/index.html',import.meta.url))};
    }
    if(url.pathname.startsWith(ADOPT_ASSET_PREFIX)) {
      // Fixed reference PNGs and cancel artwork, plus preserved historical page assets. The movie
      // the user designated for the gender choice, each as the file it was copied from. Only the
      // pinned names are served, so the page cannot name a file it does not own.
      const asset=ADOPT_PAGE_ASSETS.get(url.pathname.slice(ADOPT_ASSET_PREFIX.length));
      if(asset===undefined)throw new TypeError('ADOPT_PAGE_ROUTE_INVALID');
      if([...params.keys()].length!==0)throw new TypeError('ADOPT_PAGE_QUERY_INVALID');
      this.#adoptPageCounts.assetRequestCount++;
      const isMovie=asset.endsWith('.swf');
      return {contentType:isMovie?'application/x-shockwave-flash':'image/png',
        body:readFileSync(new URL('../../assets/adopt-page/'+asset,import.meta.url))};
    }
    if(url.pathname!==ADOPT_SUBMIT_PATH)throw new TypeError('ADOPT_PAGE_ROUTE_INVALID');
    this.#adoptPageCounts.submissionCount++;
    const refusal={contentType:'application/json; charset=utf-8',
      body:Buffer.from(JSON.stringify({ok:false,code:ADOPT_REFUSAL_CODE,message:ADOPT_REFUSAL_MESSAGE}),'utf8')};
    // The route reads exactly three query names - the choice, the cancel action and the client's own
    // cache-buster - and nothing else: a request carrying any other name (a handle, an account, a
    // credential, a context) is not a submission this route can act on, so it gets the refusal and
    // no write. The cache-buster is not used as an identifier here; it is admitted because the
    // page's own sender always appends it.
    for(const key of params.keys())if(key!=='gender'&&key!=='action'&&key!=='rt') {
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    const identity=adoptIdentityCookies(cookie);
    const uinText=identity.uin;
    const uin=uinText!==null&&/^[1-9][0-9]{0,9}$/.test(uinText)&&Number(uinText)<=0xffffffff
      ?Number(uinText):null;
    if(uin===null||identity.sign===null||!/^[a-f0-9]{64}$/i.test(identity.sign)) {
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    if(!this.accountService||!this.provisioning)throw new Error('ACCOUNT_SERVICE_NOT_ASSEMBLED');
    // The credential decides the account; the UIN cookie only has to agree with it. A live boot of
    // that account authorizes a first adoption; that account's own already-promoted value
    // authorizes nothing by itself but keeps a repeat of the same submission on the same answer,
    // which is what makes a retried or duplicated submit harmless.
    //
    // Both forms are read through the issuer's own rules - the same rules the private entry and the
    // entry verification apply - so the three cannot disagree: a boot that has run out is not a live
    // boot, and a promoted value whose lease has run out (no Root holds it and its deadline passed)
    // is no longer a credential, whether or not some earlier request happened to sweep the table.
    let authorized=false,liveBoot=false;
    try {
      const boot=this.ticketIssuer.verifyPetlessBoot(identity.sign,{serviceId:QQPENGUIN_SERVICE_ID});
      if(boot.uin===uin) {authorized=true;liveBoot=true;}
    } catch {
      authorized=this.ticketIssuer.isPromotedPetlessBoot(identity.sign,{uin});
    }
    if(!authorized||this.accountService.state(uin).disabled) {
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    const action=params.get('action');
    const gender=params.get('gender');
    if(params.has('rt')&&!/^[0-9]{1,13}$/u.test(params.get('rt'))) {
      this.#adoptPageCounts.refusedCount++;return refusal;
    }
    if(action!==null) {
      if(action!=='cancel'||gender!==null) {this.#adoptPageCounts.refusedCount++;return refusal;}
      // Transport loss does not undo the committed transaction. Confirm the same account's
      // durable profile before reporting cancellation; never provision from this branch.
      if(this.#liveProfile(uin)) {
        const pet=this.store.database.prepare('SELECT sex FROM pet WHERE uin=?').get(uin);
        const outcome=this.#commitFirstAdoption(uin,pet.sex,`adopt:account:${uin}`,
          liveBoot?identity.sign:null);
        if(!outcome.converted) {this.#adoptPageCounts.refusedCount++;return refusal;}
        return {contentType:'application/json; charset=utf-8',body:Buffer.from(JSON.stringify({
          ok:true,code:'ADOPTION_ALREADY_COMMITTED',gender:outcome.sex,replayed:true,
          message:'宠物已创建，取消不会撤销领养。请点“重试”继续入场。'}),'utf8')};
      }
      this.#adoptPageCounts.cancelledCount++;
      return {contentType:'application/json; charset=utf-8',
        body:Buffer.from(JSON.stringify({ok:false,code:ADOPT_CANCELLED_CODE,message:ADOPT_CANCELLED_MESSAGE}),'utf8')};
    }
    if(gender!=='male'&&gender!=='female') {
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    if(params.has('rt')&&!/^[0-9]{1,13}$/u.test(params.get('rt'))) {
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    // One success point: the account's own receipt transaction, then the conversion of the boot
    // credential the client has been carrying since its petless launch into the entry credential of
    // the pet that transaction committed - the value does not change, the slot the boot already held
    // does not change, and a value that is already promoted is this account's own committed adoption
    // and needs no second conversion. The answer below is built from the committed pet, so the
    // gender in it is the pet's own and a repeated submission cannot describe a pet this account
    // does not have; a conversion that did not hold is not reported as a completed adoption.
    const outcome=this.#commitFirstAdoption(uin,gender,`adopt:account:${uin}`,
      liveBoot?identity.sign:null);
    if(!outcome.converted) {
      // The pet is committed but the credential cannot continue into it (a revocation or a newer
      // boot superseded it between the authorization above and this point). The route does not
      // report an adoption the client would then fail to enter with: it answers the same refusal
      // every unusable identity gets and the account's own next login finds the pet.
      this.#adoptPageCounts.refusedCount++;
      return refusal;
    }
    if(outcome.created)this.#adoptPageCounts.adoptedCount++;
    else this.#adoptPageCounts.replayedCount++;
    return {contentType:'application/json; charset=utf-8',
      body:Buffer.from(JSON.stringify({ok:true,code:ADOPT_CREATED_CODE,message:ADOPT_CREATED_MESSAGE,
        gender:outcome.sex,replayed:!outcome.created}),'utf8')};
  }
  // The one first adoption this server performs, reached only by an entry that has already
  // established which account is asking (the launcher's handle, or the page's own cookies). The
  // receipt key is the account's, never the credential: a second submission for the same account
  // finds the pet that exists or the receipt that was written, and cannot create a second pet.
  //
  // This is also the one success point both entries share - authenticated, transaction, conversion,
  // success - so the public page and the private channel cannot answer differently about the same
  // account: the pet and the gender in the answer are read back from the committed rows, and the
  // conversion of the credential that authorized the request is part of the outcome rather than an
  // afterthought whose failure a caller may ignore.
  #commitFirstAdoption(uin,gender,adoptionId,convertSign=null) {
    const existing=this.#liveProfile(uin);
    if(!existing)this.provisioning.adopt({uin,gender,nickname:FIRST_ADOPTION_NICKNAME,adoptionId});
    const profile=this.#liveProfile(uin);
    if(!profile)throw new Error('LOCAL_ADOPTION_REJECTED');
    // The committed pet, read back from the table the transaction just wrote. The answer a caller
    // gets is built from this row, not from the request: a repeated submission that asks for the
    // other gender is answered with the pet and the gender this account actually has. The profile
    // read above already refuses an account with more than one pet, so this is the same single row.
    const committed=this.store.database.prepare('SELECT sex FROM pet WHERE uin=?').get(uin);
    if(!committed)throw new Error('LOCAL_ADOPTION_REJECTED');
    // The conversion is the last step of the success point, not a separate favour asked afterwards:
    // a pet the credential the client is carrying cannot continue into is not a completed adoption,
    // so a conversion that does not hold is reported to the caller instead of being hidden behind a
    // committed pet. A transaction that throws reaches none of this: nothing is converted, and the
    // credential is left exactly as it was for the caller that retries.
    if(convertSign!==null) {
      if(!this.ticketIssuer.promotePetlessBoot(convertSign))
        return Object.freeze({converted:false,created:!existing,profile,sex:committed.sex});
      this.#petlessPromotionCount+=1;
    }
    return Object.freeze({converted:true,created:!existing,profile,sex:committed.sex});
  }
  // The publication half of a committed change: rebuild the directory from the LATEST stored
  // profile and rebind this account's live connection. It is idempotent and never touches a
  // card or a business row, so any later request — including a receipt hit — can repair a
  // directory or channel a previous fault left stale. The profile is read from the store, not
  // from a receipt's target name, so recovering after another rename cannot roll a newer name
  // back to an older one.
  #publishLatestProfile(uin,petIdBytes=null) {
    let profiles;
    try { profiles=this.store.profileForUin(uin); }
    catch { return {ok:false,reason:'PROFILE_READ_FAILED'}; }
    if(profiles.length!==1)return {ok:false,reason:'PROFILE_MISSING'};
    this.#profiles.set(uin,profiles[0]);
    try { this.game.refreshProfiles([...this.#profiles.values()]); }
    catch { return {ok:false,reason:'DIRECTORY_PUBLISH_FAILED'}; }
    try { this.game.refreshUinProfile(uin,petIdBytes??profiles[0].petIdBytes); }
    catch { return {ok:false,reason:'CHANNEL_REBIND_FAILED'}; }
    return {ok:true};
  }
  // The pet that exists right now, not the one the constructor saw. The directory is rebound so
  // a following connection resolves it too, which is what makes an adoption take effect without
  // a restart.
  #liveProfile(uin) {
    if(!this.store)return this.#profiles.get(uin)??null;
    const profiles=this.store.profileForUin(uin);
    if(profiles.length===0)return null;
    if(profiles.length>1)throw new Error('LOCAL_LOGIN_REQUIRES_UNIQUE_ACCOUNT_PET');
    this.#profiles.set(uin,profiles[0]);
    try {this.game.refreshProfiles([...this.#profiles.values()]);} catch {throw new Error('LOCAL_PROFILE_REFRESH_FAILED');}
    return profiles[0];
  }
  async start() {
    if(this.started || this.stopped)throw new Error('LOCAL_SERVER_ALREADY_STARTED');
    this.started=true;
    try {
      for(const [service,listener] of [['game',this.game],['web',this.webdir],['admin',this.accountWeb],
        ['login',this.remoteLogin],['web',this.legacyHttp],['directory',this.legacyDirectory]]){
        try{await listener?.start();}catch(error){error.service=service;throw error;}
      }
      this.ready=true;return this.health();}
    catch(error) {await this.stop();throw error;}
  }
  // Registration and first adoption are exposed here because this object already owns the
  // database and the login chain; a second long-running account backend is not started.
  register(input) {
    this.#requireAccounts();
    return this.accountService.register(input);
  }
  adopt(input) {
    this.#requireAccounts();
    return this.provisioning.adopt(input);
  }
  accountSummary() {
    this.#requireAccounts();
    // Counted from the database, not from the set the constructor saw: an account registered or
    // adopted since then must be reported as it is now.
    const petless=this.store?this.store.loadServerConfiguration().petlessUins.length:this.#petless.size;
    return Object.freeze({accounts:this.accountService.searchAccounts({limit:200}).length,
      admins:this.accountService.countAdmins(),petlessAccounts:petless});
  }
  #requireAccounts() {
    if(!this.accountService||!this.provisioning)throw new Error('ACCOUNT_SERVICE_NOT_ASSEMBLED');
  }
  health() {
    return Object.freeze({ready:this.ready,profile:'local-login-client',compatibility:true,
      deployment:this.deployment?{id:this.deployment.deploymentId,mode:this.deployment.mode,
        publishedGame:this.publishedGame,webOrigin:this.deployment.public.webOrigin,
        scope:this.remoteLogin?'login-game-and-webdir':'game-and-webdir-only',remoteLoginImplemented:Boolean(this.remoteLogin)}:null,
      game:this.game.health(),webdir:this.webdir.health(),
      accountWeb:this.accountWeb?this.accountWeb.health():null,
      profilePublishFailures:Object.fromEntries(this.profilePublishFailures),
      publishIsolationCount:this.publishIsolationCount,txssoListenersStarted:0,
      nickNameNotifyCount:this.nickNameNotifyCount,
      nickNameNotifyUnaddressable:this.nickNameNotifyUnaddressable,
      nickNameNotifyFailures:this.nickNameNotifyFailures,
      petRenameRefusals:Object.freeze({...this.petRenameRefusals}),
      clientProcessesStarted:0,systemStateChanged:false});
  }
  summary() {
    return Object.freeze({...this.health(),game:this.game.summary(),webdir:this.webdir.summary(),legacyDirectory:this.legacyDirectory?.summary()??{enabled:false},
      adoptPage:Object.freeze({...this.#adoptPageCounts}),
      tickets:this.ticketIssuer.summary(),authenticationCount:this.#authCount,authenticationFailures:this.#authFailures,
      petlessBootIssuedCount:this.#petlessBootCount,petlessBootPromotionCount:this.#petlessPromotionCount,
      sensitiveValuesPresent:false});
  }
  async stop() {
    if(this.stopping)return this.stopping;
    this.ready=false;this.stopped=true;
    this.stopping=(async()=>{
      try {await Promise.all([this.legacyDirectory?.stop(),this.legacyHttp?.stop(),this.remoteLogin?.stop(),this.accountWeb?.stop(),this.webdir.stop(),this.game.stop()]);}
      finally {this.ticketIssuer.close();}
      return this.summary();
    })();
    return this.stopping;
  }
}
