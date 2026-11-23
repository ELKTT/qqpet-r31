import http from "node:http";
import {resolveServerListener} from '../deployment/server-listener.js';
import {BusinessAddresses} from '../deployment/business-addresses.js';
import { PlayMenuResources } from './play-menu-resources.js';
import {CareResources} from './care-resources.js';
import {DesktopToolbarResources} from './desktop-toolbar-resources.js';
import {PetBusinessResources} from './pet-business-resources.js';
import {GameplayResources} from './gameplay-resources.js';
import {SupplementGames} from './supplement-games.js';
import {parseGameplayRequest} from '../protocol/gameplay-http.js';
import {parseReliveRequest} from '../protocol/relive-http.js';
import {parseSupplementLegacyRequest,encodeSupplementLegacyResponse} from '../protocol/supplement-game-http.js';
import {createNativePetInfoHttpServer} from './native-petinfo-http-input.js';

import {
  OriginalWebdirProfileDirectory,
  OriginalWebdirProfileError,
} from "./webdir-profile-directory.js";

export const ORIGINAL_WEBDIR_HOST = "127.0.0.1";
export const ORIGINAL_WEBDIR_DEFAULT_PORT = 18080;
export const ORIGINAL_WEBDIR_PATH = "/websmartdir";
export const ORIGINAL_WEBDIR_AUTHORITY = "webdir.pet.qq.com";

const EXPECTED_QUERY_KEYS = Object.freeze([
  "productname",
  "cmd",
  "uin",
  "localver",
  "kernelver",
  "rt",
]);

class InvalidWebdirRequest extends Error {}

function isAdoptTarget(target = '') {
  return target === '/tuoq/index.html' || target === '/tuoq/adopt'
    || target.startsWith('/tuoq/adopt?') || /^\/tuoq\/asset\/[a-z0-9-]+\.(?:png|swf)$/.test(target);
}

function isSameOriginAdoption(request, origin) {
  if (request.headers.origin !== undefined && request.headers.origin !== origin) return false;
  if (request.headers.referer !== undefined) {
    try {
      const ref = new URL(request.headers.referer);
      if (ref.origin !== origin || ref.username || ref.password) return false;
    } catch { return false; }
  }
  // The existing page submits GETs. Requiring a non-simple header prevents cross-origin
  // form/image navigations from performing a write; this listener never grants CORS.
  return !request.url.startsWith('/tuoq/adopt') || request.headers['x-qqpet-request'] === 'adopt';
}

const REJECTION_CODES = new Map([
  ["request target length is invalid", "TARGET_LENGTH_INVALID"],
  ["request target is invalid", "TARGET_INVALID"],
  ["request path is invalid", "PATH_INVALID"],
  ["request query shape is invalid", "QUERY_SHAPE_INVALID"],
  ["productname is invalid", "PRODUCT_NAME_INVALID"],
  ["cmd is invalid", "COMMAND_INVALID"],
  ["request authority is invalid", "AUTHORITY_INVALID"],
]);

function rejectionCode(error) {
  if (error instanceof OriginalWebdirProfileError) return error.code;
  if (error instanceof InvalidWebdirRequest) {
    if (REJECTION_CODES.has(error.message)) return REJECTION_CODES.get(error.message);
    if (error.message.endsWith(" is not canonical decimal")) return "DECIMAL_INVALID";
    if (error.message.endsWith(" is outside its unsigned range")) {
      const label = error.message.slice(0, -" is outside its unsigned range".length);
      if (["uin", "localver", "kernelver", "rt"].includes(label)) {
        return `${label.toUpperCase()}_RANGE_INVALID`;
      }
      return "RANGE_INVALID";
    }
  }
  return "REQUEST_INVALID";
}

function requestShape(request, bodyBytes = 0, authority = ORIGINAL_WEBDIR_AUTHORITY) {
  let pathname = null;
  let queryKeys = [];
  try {
    const parsed = new URL(request.url, "http://webdir.pet.qq.com");
    pathname = parsed.pathname.slice(0, 256);
    queryKeys = [...parsed.searchParams.keys()].slice(0, 32);
  } catch {
    // The rejection code remains authoritative for an unparseable target.
  }
  return Object.freeze({
    method: request.method ?? null,
    authorityMatches: request.headers.host === authority,
    requestTargetLength: typeof request.url === "string" ? request.url.length : null,
    pathname,
    queryKeys: Object.freeze(queryKeys),
    bodyBytes,
  });
}

function assertEndpoint(host, port, deploymentEndpoints,allowLegacyHttp80=false) {
  return resolveServerListener('web', {host, port, deploymentEndpoints,allowLegacyHttp80});
}

function parseDecimal(value, maximum, label, { nonzero = false } = {}) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new InvalidWebdirRequest(`${label} is not canonical decimal`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (nonzero ? 1 : 0) || parsed > maximum) {
    throw new InvalidWebdirRequest(`${label} is outside its unsigned range`);
  }
  return parsed;
}

export function parseOriginalWebdirRequestUrl(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.length === 0 || requestUrl.length > 2048) {
    throw new InvalidWebdirRequest("request target length is invalid");
  }
  let parsed;
  try {
    parsed = new URL(requestUrl, "http://webdir.pet.qq.com");
  } catch {
    throw new InvalidWebdirRequest("request target is invalid");
  }
  if (parsed.pathname !== ORIGINAL_WEBDIR_PATH || parsed.hash !== "") {
    throw new InvalidWebdirRequest("request path is invalid");
  }
  const actualKeys = [...parsed.searchParams.keys()];
  if (
    actualKeys.length !== EXPECTED_QUERY_KEYS.length ||
    actualKeys.some((key, index) => key !== EXPECTED_QUERY_KEYS[index]) ||
    EXPECTED_QUERY_KEYS.some((key) => parsed.searchParams.getAll(key).length !== 1)
  ) {
    throw new InvalidWebdirRequest("request query shape is invalid");
  }
  const productName = parsed.searchParams.get("productname");
  if (!productName || productName.length > 128 || productName.includes("\0")) {
    throw new InvalidWebdirRequest("productname is invalid");
  }
  if (parsed.searchParams.get("cmd") !== "39169") {
    throw new InvalidWebdirRequest("cmd is invalid");
  }
  return Object.freeze({
    productName,
    uin: parseDecimal(parsed.searchParams.get("uin"), 0xffffffff, "uin"),
    localver: parseDecimal(parsed.searchParams.get("localver"), 0xffff, "localver"),
    kernelver: parseDecimal(parsed.searchParams.get("kernelver"), 0xffff, "kernelver"),
    rt: parseDecimal(parsed.searchParams.get("rt"), 0xffffffff, "rt"),
  });
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

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function sendPlain(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=us-ascii",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  });
  response.end(body);
}

// One route, two contracts. The HTML pages authenticate with the WebLogic cookie and send
// no query identity; the Flash market carries its own PET_UIN/PET_ID/PET_SIGN/time and the
// flash=1 marker. cmd=store exists in both, so the split is by explicit request shape:
// any query identity or the flash marker takes the request out of the HTML contract (the
// strict care parser owns it, including its rejection), and an HTML request never falls
// back to the Flash contract after the HTML parser refused it.
const MARKET_HTML_COMMANDS=new Set(['frame','shop','pay','use','store','save']);
const MARKET_FLASH_QUERY_KEYS=Object.freeze(['PET_UIN','PET_ID','PET_SIGN','time','flash']);
function isMarketHtmlTarget(target) {
  if(typeof target!=='string'||target.length>4096||!/^\/fcgi-bin\/market\?[^#\s]*$/.test(target))return false;
  try {
    const q=new URL(target,'http://web.pet.qq.com').searchParams;
    if(MARKET_FLASH_QUERY_KEYS.some(key=>q.has(key)))return false;
    const cmd=q.get('cmd');
    return cmd!==null&&MARKET_HTML_COMMANDS.has(cmd);
  } catch {return false;}
}

export class OriginalWebdirServer {
  constructor({ profiles, host, port, deploymentEndpoints, playMenu,careResources,careHandler,careCatalogueHandler,qqcomJumpHandler,toolbarResources,toolbarHandler,marketPages,marketHtmlHandler,gameplayHandler,legacyCommunityEntries,legacyCommunityResources,desktopGame,petShowHandler,petInfoHandler,friendHandler,wearableHandler,adoptPageHandler,dynamicProfile } = {}) {
    const binding = assertEndpoint(host, port, deploymentEndpoints,Boolean(legacyCommunityResources));
    ({host, port} = binding);
    this.deployment = binding.config;
    this.businessAddresses=this.deployment?.mode==='remote'?new BusinessAddresses(this.deployment):null;
    this.authority = this.deployment?.mode === 'remote'
      ? new URL(this.deployment.public.webOrigin).host : ORIGINAL_WEBDIR_AUTHORITY;
    if(legacyCommunityResources!==undefined){
      if(typeof legacyCommunityResources.resolve!=='function')throw new TypeError('INVALID_LEGACY_COMMUNITY_RESOURCES');
      this.legacyCommunityResources=legacyCommunityResources;
      if(this.deployment?.mode==='local'){
        this.businessAddresses=new BusinessAddresses(this.deployment,{allowLoopback:true});
        this.authority=new URL(this.deployment.public.webOrigin).host;
        this.localLegacyNamespace=true;
      }
    }
    if (playMenu !== undefined && !(playMenu instanceof PlayMenuResources)) throw new TypeError('INVALID_PLAY_RESOURCES');
    this.playMenu = playMenu;
    if(qqcomJumpHandler!==undefined && typeof qqcomJumpHandler!=='function')throw new TypeError('INVALID_WEB_LOGIN_CONFIG');
    this.qqcomJumpHandler=qqcomJumpHandler;
    if(careResources!==undefined&&(!(careResources instanceof CareResources)||typeof careHandler!=='function'))throw new TypeError('INVALID_CARE_HTTP');
    this.careResources=careResources;this.careHandler=careHandler;
    this.businessResources=new PetBusinessResources();
    this.gameplayResources=new GameplayResources();
    this.supplementGames=gameplayHandler?new SupplementGames({deployment:deploymentEndpoints}):null;
    if(gameplayHandler!==undefined&&typeof gameplayHandler!=='function')throw new TypeError('INVALID_GAMEPLAY_HANDLER');
    this.gameplayHandler=gameplayHandler;
    if(careCatalogueHandler!==undefined&&typeof careCatalogueHandler!=='function')throw new TypeError('INVALID_CARE_CATALOGUE');
    this.careCatalogueHandler=careCatalogueHandler;
    if(toolbarResources&&(!(toolbarResources instanceof DesktopToolbarResources)||typeof toolbarHandler!=='function'))throw new TypeError('INVALID_TOOLBAR_HTTP');
    this.toolbarResources=toolbarResources;this.toolbarHandler=toolbarHandler;
    // The HTML market capability is duck-typed on purpose: the page service copy and the
    // desktop catalogue are separate default-off modules, so this server only requires the
    // resolve() contract and stays testable with a stub.
    if(marketPages!==undefined&&typeof marketPages?.resolve!=='function')throw new TypeError('INVALID_MARKET_PAGES');
    if(marketHtmlHandler!==undefined&&typeof marketHtmlHandler!=='function')throw new TypeError('INVALID_MARKET_HTML');
    if(legacyCommunityEntries!==undefined&&(typeof legacyCommunityEntries?.resolve!=='function'
        ||!marketPages||typeof marketHtmlHandler!=='function'))throw new TypeError('LEGACY_ENTRY_REQUIRES_MARKET');
    this.legacyCommunityEntries=legacyCommunityEntries;
    if(desktopGame!==undefined&&typeof desktopGame?.resolve!=='function')throw new TypeError('INVALID_DESKTOP_GAME');
    // An account that adopts while the server runs has no record in the configured document.
    // The hook derives its start parameters from the live store instead of the process being
    // restarted or the document being edited by hand.
    if(dynamicProfile!==undefined&&typeof dynamicProfile!=='function')throw new TypeError('INVALID_DYNAMIC_PROFILE');
    this.dynamicProfile=dynamicProfile;
    // The in-game rename contract (PetInfo panel → babyinfo cmd=10/11/12); always wired by
    // the local-login assembly, and matched by exact host and path in the request router.
    if(petInfoHandler!==undefined&&typeof petInfoHandler!=='function')throw new TypeError('INVALID_PETINFO_HTTP');
    this.petInfoHandler=petInfoHandler;
    if(friendHandler!==undefined&&typeof friendHandler!=='function')throw new TypeError('INVALID_FRIEND_HTTP');
    this.friendHandler=friendHandler;
    if(petShowHandler!==undefined&&typeof petShowHandler!=='function')throw new TypeError('INVALID_PETSHOW_HTTP');
    this.petShowHandler=petShowHandler;
    // The first-adoption page the client's own browser is navigated to when its start parameters
    // carry no pet, on the exact host and path that navigation names.
    if(adoptPageHandler!==undefined&&typeof adoptPageHandler!=='function')throw new TypeError('INVALID_ADOPT_PAGE_HTTP');
    this.adoptPageHandler=adoptPageHandler;
    if(wearableHandler!==undefined&&typeof wearableHandler!=='function')throw new TypeError('INVALID_WEARABLE_HTTP');
    this.wearableHandler=wearableHandler;
    this.marketPages=marketPages;this.marketHtmlHandler=marketHtmlHandler;this.desktopGame=desktopGame;
    this.profileDirectory = profiles instanceof OriginalWebdirProfileDirectory
      ? profiles
      : new OriginalWebdirProfileDirectory(profiles);
    if (this.deployment) this.profileDirectory = this.profileDirectory.withGameEndpoint(this.deployment.public.game);
    if(this.deployment)this.profileDirectory=this.profileDirectory.withResourceHost(new URL(this.deployment.public.webOrigin).host);
    this.options = Object.freeze({ host, port });
    this.server = null;
    this.started = false;
    this.ready = false;
    this.stopped = false;
    this.requestCount = 0;
    this.successCount = 0;
    this.rejectedCount = 0;
    this.rejectionReasons = new Map();
    this.lastRejectedRequest = null;
  }

  #recordRejection(code, request, bodyBytes = 0) {
    this.rejectedCount += 1;
    this.rejectionReasons.set(code, (this.rejectionReasons.get(code) ?? 0) + 1);
    // A public caller controls path segments and query *names* as well as values.
    // None of those raw strings belong in a remote deployment's status report.
    const shape=this.deployment?.mode==='remote'||request.headers.host==='feed.pet.qq.com'?{
      method:['GET','HEAD','POST','OPTIONS'].includes(request.method)?request.method:'OTHER',
      authorityMatches:request.headers.host===this.authority,
      requestTargetLength:typeof request.url==='string'?request.url.length:null,
      pathname:request.url?.startsWith('/websmartdir?')?'/websmartdir':null,queryKeys:Object.freeze([]),bodyBytes,
    }:requestShape(request,bodyBytes,this.authority);
    this.lastRejectedRequest = Object.freeze({code,...shape});
  }

  #handle(request, response) {
    this.requestCount += 1;
    // Public namespaces retain the original authority as an internal route discriminator.
    const remoteAdopt = (this.deployment?.mode === 'remote'||this.localLegacyNamespace) && isAdoptTarget(request.url);
    const business=this.businessAddresses?.resolve(request.url);
    const community=this.remoteCommunity?.matches(request.url)||
      (business?.authority==='pet.qq.com'&&this.remoteCommunity?.matches(business.target));
    // KernelTenio 22A28 emits an explicit :80 on initial HTTP downloads.
    // Admit that spelling only for this configured loopback's pinned static
    // catalog; it cannot open a business API or an undeclared resource route.
    const nativeDefaultPort=Boolean(this.legacyCommunityResources)&&this.deployment?.listen.web.port===80
      &&request.headers.host===this.authority+':80';
    const legacyRaw=this.legacyCommunityResources?.resolve(nativeDefaultPort?this.authority:request.headers.host,request.url)
      ??((nativeDefaultPort||request.headers.host===this.authority)?this.supplementGames?.nativeResource(request.url):null);
    if ((this.deployment?.mode === 'remote'||this.localLegacyNamespace) && ((request.headers.host !== this.authority&&!(nativeDefaultPort&&legacyRaw))
        || (!request.url?.startsWith('/websmartdir?') && !remoteAdopt && !business && !community && !legacyRaw))) {
      request.resume();
      this.#recordRejection('DEPLOYMENT_ROUTE_NOT_AVAILABLE', request);
      sendPlain(response, 404, 'route unavailable');
      return;
    }
    if(legacyRaw){
      request.resume();
      if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid resource request');return;}
      response.writeHead(200,{'Content-Type':legacyRaw.contentType,'Content-Length':legacyRaw.body.length,'Cache-Control':'no-store',Connection:'close'});
      response.end(legacyRaw.body);this.successCount++;return;
    }
    if(community){
      if(business)request.url=business.target;
      this.remoteCommunity.handle(request,response);return;
    }
    if(business){
      const resource=this.legacyCommunityResources?.resolve(business.authority,business.target)
        ??this.remoteCommunity?.resource(business.authority,business.target);
      if(resource){
        request.resume();
        if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid resource request');return;}
        this.businessAddresses.wrapResponse(response,business.authority);
        response.writeHead(200,{'Content-Type':resource.contentType,'Cache-Control':'no-store',Connection:'close'});response.end(resource.body);return;
      }
      // First-load PV and unavailable legacy preload pages have no local business state.
      // Do not forward it or retain request headers, identifiers or query values.
      if((business.authority==='web.pet.qq.com'&&(business.target==='/pv.html'||/^\/preloading\.html\?rt=-?\d{1,10}$/.test(business.target)))
          ||(business.authority==='report.pet.qq.com'&&business.target.startsWith('/reportmsg?'))){
        request.resume();
        if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid page request');return;}
        response.writeHead(204,{'Cache-Control':'no-store',Connection:'close'});response.end();return;
      }
      if(!this.businessAddresses.accepts(request)){
        request.resume();sendPlain(response,403,'request origin unavailable');return;
      }
        if(business.redirect){
          request.resume();
          if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid page request');return;}
          response.writeHead(302,{Location:business.redirect,'Cache-Control':'no-store','Content-Length':0,Connection:'close'});response.end();return;
        }
      this.businessAddresses.wrapResponse(response,business.authority);
      request.headers={...request.headers,host:business.authority};request.url=business.target;
    }
    if (remoteAdopt && !isSameOriginAdoption(request, new URL(this.deployment.public.webOrigin).origin)) {
      request.resume();
      this.#recordRejection('ADOPTION_ORIGIN_REJECTED', request);
      sendPlain(response, 403, 'request origin unavailable');
      return;
    }
    if(this.toolbarResources?.matches(request.headers.host,request.url)) {
      if(this.toolbarResources.handle(request,response,this.toolbarHandler))this.successCount++;
      else {this.rejectedCount++;this.rejectionReasons.set('TOOLBAR_REJECTED',(this.rejectionReasons.get('TOOLBAR_REJECTED')??0)+1);}
      return;
    }
    if(this.gameplayHandler&&request.headers.host==='web.pet.qq.com'&&request.url==='/gameplay/notifications'){
      request.resume();if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid notice request');return;}
      let state;try{state=this.gameplayHandler({operation:'notice-state'},request.headers.cookie??'');}catch{sendPlain(response,403,'notice session unavailable');return;}
      if(state.result!==0){sendPlain(response,403,'notice session unavailable');return;}
      const target=state.onlineGifts>0||state.growth>0||state.announcements>0?'http://act.pet.qq.com/newsub/desktop_gifts.html':
        state.sign>0?'http://pet.qq.com/app/pet_notice.html':'http://act.pet.qq.com/newsub/desktop_task.html?src=0';
      response.writeHead(302,{Location:target,'Cache-Control':'no-store','Content-Length':0,'X-Frame-Options':'SAMEORIGIN',Connection:'close'});response.end();return;
    }
    // Keep all authentication URLs out of generic rejected-request projection,
    // including when the optional handler is disabled or the request is invalid.
    if(request.headers.host==='ptlogin2.qq.com') {
      if(this.qqcomJumpHandler) {
        if(this.qqcomJumpHandler(request,response))this.successCount++;
        else {this.rejectedCount++;this.rejectionReasons.set('WEB_LOGIN_REJECTED',(this.rejectionReasons.get('WEB_LOGIN_REJECTED')??0)+1);}
      } else {request.resume();sendPlain(response,404,'web login unavailable');}
      return;
    }
    // The original SendMsg uses one bounded raw String POST at this exact path.
    // Route it before the generic GET-only webdir reader, retaining origin checks
    // above and the Root-bound authentication in the friend handler.
    if(this.friendHandler&&request.headers.host==='feed.pet.qq.com'&&request.url==='/fcgi-bin/desktopfeed'&&request.method==='POST') {
      const chunks=[];let size=0,finished=false;
      const reject=(status)=>{if(finished)return;finished=true;sendPlain(response,status,'invalid friend message request');};
      const length=Number(request.headers['content-length']??0);
      if(request.headers['transfer-encoding']||!Number.isSafeInteger(length)||length<1||length>4096){request.resume();reject(400);return;}
      request.on('data',chunk=>{size+=chunk.length;if(size>4096)reject(413);else if(!finished)chunks.push(chunk);});
      request.on('error',()=>reject(400));
      request.on('end',()=>{
        if(finished)return;
        if(size!==length){reject(400);return;}
        try {
          const xml=this.friendHandler('feed.pet.qq.com',request.url,Buffer.concat(chunks));
          const body=Buffer.from(xml,'utf8');finished=true;
          response.writeHead(200,{'Content-Type':'text/xml; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;
        }catch{reject(400);}
      });
      return;
    }
    if(this.gameplayHandler&&request.headers.host==='web.pet.qq.com'&&request.url.startsWith('/fcgi-bin/revival?')){
      request.resume();
      // Flash URLLoader sends GET when URLRequest.method is POST but data is
      // null. Both empty-body transports carry the same bound query identity.
      if(!['GET','POST'].includes(request.method)||request.headers['transfer-encoding']||Number(request.headers['content-length']??0)!==0){sendPlain(response,400,'invalid game request');return;}
      try{const q=parseReliveRequest(request.url),result=this.gameplayHandler(q.request,q.cookie),body=Buffer.from(JSON.stringify(result));
        response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Connection:'close'});response.end(body);this.successCount++;
      }catch{sendPlain(response,400,'invalid game request');}return;
    }
    let bodyBytes = 0;
    let completed = false;
    request.on("data", (chunk) => {
      bodyBytes += chunk.length;
      if (bodyBytes > 0 && !completed) {
        completed = true;
        this.#recordRejection("BODY_NOT_ALLOWED", request, bodyBytes);
        sendPlain(response, 400, "invalid webdir request");
      }
    });
    request.on("end", () => {
      if (completed) return;
      completed = true;
      if (request.method !== "GET") {
        this.#recordRejection("METHOD_NOT_ALLOWED", request, bodyBytes);
        sendPlain(response, 405, "invalid webdir request");
        return;
      }
      try {
        const legacyGame=this.supplementGames&&parseSupplementLegacyRequest(request.headers.host,request.url);
        if(legacyGame){let result;try{result=this.gameplayHandler(legacyGame,request.headers.cookie??'');}catch{result={result:-1,msg:'请先登录宠物。'};}
          const resource=encodeSupplementLegacyResponse(legacyGame,result);response.writeHead(200,{'Content-Type':resource.contentType,'Cache-Control':'no-store',Connection:'close'});response.end(resource.body);this.successCount++;return;}
        const gameResource=this.supplementGames?.resolve(request.headers.host,request.url);
        if(gameResource){response.writeHead(200,{'Content-Type':gameResource.contentType,'Cache-Control':'no-store',Connection:'close'});response.end(gameResource.body);this.successCount++;return;}
        if(this.gameplayHandler&&['web.pet.qq.com','pet.qq.com','act.pet.qq.com'].includes(request.headers.host)) {
          const page=this.gameplayResources.resolve(request.headers.host,request.url);
          if(page){response.writeHead(200,{'Content-Type':page.contentType,'Content-Length':page.body.length,'Cache-Control':'no-store',Connection:'close'});response.end(page.body);this.successCount++;return;}
          if(request.url.startsWith('/gameplay/api?')) {
            if(request.headers['x-qqpet-gameplay']!=='1')throw new InvalidWebdirRequest('gameplay request is unavailable');
            let result;try{result=this.gameplayHandler(parseGameplayRequest(request.url),request.headers.cookie??'');}
            catch{result={result:1,msg:'登录状态或请求无效，请重新打开面板'};}
            const body=Buffer.from(JSON.stringify(result));response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store',Connection:'close'});
            response.end(body);this.successCount++;return;
          }
        }
        const businessResource=this.businessResources.resolve(request.headers.host,request.url);
        if(businessResource){response.writeHead(200,{'Content-Type':businessResource.contentType,'Content-Length':businessResource.body.length,
          'Cache-Control':'no-store',Connection:'close'});response.end(businessResource.body);this.successCount++;return;}
        if(this.legacyCommunityResources){
          const resource=this.legacyCommunityResources.resolve(request.headers.host,request.url);
          if(resource!==null){
            response.writeHead(200,{'Content-Type':resource.contentType,'Content-Length':resource.body.length,'Cache-Control':'no-store',Connection:'close'});
            response.end(resource.body);this.successCount++;return;
          }
        }
        if(this.legacyCommunityEntries) {
          const resource=this.legacyCommunityEntries.resolve(request.headers.host,request.url);
          if(resource!==null) {
            if(resource.redirect){
              response.writeHead(302,{Location:resource.redirect,'Content-Length':0,
                'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Connection:'close'});
              response.end();this.successCount++;return;
            }
            response.writeHead(200,{'Content-Type':resource.contentType,'Content-Length':resource.body.length,
              'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
              'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'self'",
              Connection:'close'});
            response.end(resource.body);this.successCount++;return;
          }
        }
        if(this.desktopGame) {
          const resource=this.desktopGame.resolve(request.headers.host,request.url);
          if(resource!==null) {
            response.writeHead(200,{'Content-Type':resource.contentType,'Content-Length':resource.body.length,
              'Cache-Control':'no-store',Connection:'close'});
            response.end(resource.body);this.successCount++;return;
          }
        }
        // The HTML market set and its API claim web.pet.qq.com only; the Flash store
        // contract on the same host stays with the care handler below.
        if(this.marketPages&&request.headers.host==='web.pet.qq.com') {
          const resource=request.url.startsWith('/common/market/')?this.marketPages.resolve(request.url):null;
          if(resource!==null) {
            response.writeHead(200,{'Content-Type':resource.contentType,'Content-Length':resource.body.length,
              'Cache-Control':'no-store',Connection:'close'});
            response.end(resource.body);this.successCount++;return;
          }
          if(isMarketHtmlTarget(request.url)) {
            if(typeof this.marketHtmlHandler!=='function')
              throw new InvalidWebdirRequest('market html is unavailable');
            const body=Buffer.from(JSON.stringify(this.marketHtmlHandler('web.pet.qq.com',request.url,
              request.headers.cookie??'')),'utf8');
            response.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,
              'Cache-Control':'no-store',Connection:'close'});
            response.end(body);this.successCount++;return;
          }
        }
        // The wearable category is served on the shop host ahead of the care fallback: the
        // list endpoint, the hash-named artwork, and nothing else under that prefix. The
        // carrier page takes one query of its own (the column it was opened from), so the
        // page is matched with or without it.
        if(this.wearableHandler&&request.headers.host==='web.pet.qq.com'
            &&(request.url.startsWith('/fcgi-bin/wearables?')||request.url==='/fcgi-bin/wearables'
               ||request.url==='/wearables'||request.url==='/wearables/'||request.url.startsWith('/wearables?')
               ||request.url.startsWith('/wearable/'))) {
          const served=this.wearableHandler('web.pet.qq.com',request.url);
          if(served!==null) {
            response.writeHead(200,{'Content-Type':served.contentType,'Content-Length':served.body.length,
              'Cache-Control':'no-store',Connection:'close'});
            response.end(served.body);this.successCount++;return;
          }
          throw new InvalidWebdirRequest('wearable route is invalid');
        }
        // The first-adoption page and its submission route claim the /tuoq path on the shop host.
        // It is matched ahead of the care fallback for the same reason the two above are: the page
        // is a same-origin resource of this host, not a care request. The submission route is
        // matched with and without a query. The handler still verifies the issuer's credential
        // and account pairing before committing; the deployment adapter conveys no identity.
        if(this.adoptPageHandler&&(request.headers.host==='web.pet.qq.com'||remoteAdopt)
            &&isAdoptTarget(request.url)) {
          const served=this.adoptPageHandler('web.pet.qq.com',request.url,request.headers.cookie??'');
          if(served!==null) {
            response.writeHead(200,{'Content-Type':served.contentType,'Content-Length':served.body.length,
              'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
              'X-Frame-Options':'DENY',Connection:'close'});
            response.end(served.body);this.successCount++;return;
          }
          throw new InvalidWebdirRequest('adopt page route is invalid');
        }
        // The PetInfo panel's rename/read contract claims the exact babyinfo path on the same
        // host; it is matched before the care fallback so the two never fight over a route.
        if(this.petShowHandler&&request.headers.host==='web.pet.qq.com'&&
          (request.url.startsWith('/fcgi-bin/petshow?')||request.url.startsWith('/petinfo-image/'))) {
          const {body,contentType}=this.petShowHandler('web.pet.qq.com',request.url);
          response.writeHead(200,{'Content-Type':contentType,'Content-Length':body.length,'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;return;
        }
        if(this.petInfoHandler&&request.headers.host==='web.pet.qq.com'
            &&request.url.startsWith('/fcgi-bin/babyinfo?')) {
          const body=Buffer.from(this.petInfoHandler('web.pet.qq.com',request.url),'utf8');
          response.writeHead(200,{'Content-Type':'text/xml; charset=utf-8','Content-Length':body.length,
            'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;return;
        }
        if(this.friendHandler&&request.headers.host==='feed.pet.qq.com'
            &&(request.url.startsWith('/fcgi-bin/desktopfeed?')||request.url==='/fcgi-bin/desktopfeed'
              ||request.url==='/crossdomain.xml')) {
          const xml=request.url==='/crossdomain.xml'
            ?'<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" secure="false" /></cross-domain-policy>'
            :this.friendHandler('feed.pet.qq.com',request.url);
          const json=typeof xml!=='string',body=Buffer.from(json?JSON.stringify(xml):xml,'utf8');
          response.writeHead(200,{'Content-Type':json?'application/json; charset=utf-8':'text/xml; charset=utf-8','Content-Length':body.length,
            'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;return;
        }
        if(this.careCatalogueHandler&&request.headers.host==='img.pet.qq.com'&&request.url==='/desktopshoplist.xml') {
          const body=Buffer.from(this.careCatalogueHandler(),'utf8');
          response.writeHead(200,{'Content-Type':'text/xml; charset=utf-8','Content-Length':body.length,
            'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;return;
        }
        if(this.careResources&&['x.pet.qq.com','web.pet.qq.com','img.pet.qq.com'].includes(request.headers.host)) {
          const resource=this.careResources.resolve(request.headers.host,request.url);
          let body,contentType;
          if(resource)({body,contentType}=resource);
          else if(['x.pet.qq.com','web.pet.qq.com'].includes(request.headers.host)) {
            body=Buffer.from(JSON.stringify(this.careHandler(request.headers.host,request.url)),'utf8');
            contentType='application/json; charset=utf-8';
          }else throw new InvalidWebdirRequest('request path is invalid');
          response.writeHead(200,{'Content-Type':contentType,'Content-Length':body.length,'Cache-Control':'no-store',Connection:'close'});
          response.end(body);this.successCount++;return;
        }
        if (this.playMenu && (request.headers.host === 'pet.qq.com'
            || (request.headers.host === 'img.pet.qq.com' && request.url === '/crossdomain.xml'))) {
          const resource = this.playMenu.resolve(request.url);
          if (!resource) throw new InvalidWebdirRequest('request path is invalid');
          response.writeHead(200, { 'Content-Type': resource.contentType,
            'Content-Length': resource.body.length, 'Cache-Control': 'no-store', Connection: 'close' });
          response.end(resource.body);
          this.successCount += 1;
          return;
        }
        if (request.headers.host !== this.authority) {
          throw new InvalidWebdirRequest("request authority is invalid");
        }
        const query = parseOriginalWebdirRequestUrl(request.url);
        let payload;
        try {
          payload = this.profileDirectory.resolve(query.productName, query.uin);
        } catch (error) {
          if (!(error instanceof OriginalWebdirProfileError) || typeof this.dynamicProfile !== 'function') throw error;
          const derived = this.dynamicProfile(query.productName, query.uin);
          if (derived === null || derived === undefined) throw error;
          payload = Object.freeze({versioninfo: derived});
        }
        const wire = Buffer.from(JSON.stringify(payload), "utf8");
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": wire.length,
          Connection: "close",
        });
        response.end(wire);
        this.successCount += 1;
      } catch (error) {
        this.#recordRejection(rejectionCode(error), request, bodyBytes);
        sendPlain(response, error instanceof OriginalWebdirProfileError ? 404 : 400, "invalid webdir request");
      }
    });
    request.on("error", () => {
      if (!completed) this.#recordRejection("REQUEST_STREAM_ERROR", request, bodyBytes);
    });
  }

  async start() {
    if (this.started) throw new Error("OriginalWebdirServer has already been started");
    this.started = true;
    const handle=(request,response)=>this.#handle(request,response);
    this.server = this.businessAddresses?createNativePetInfoHttpServer(handle):http.createServer(handle);
    if(!this.businessAddresses){
      this.server.maxHeadersCount = 32;
      this.server.requestTimeout = 10_000;
      this.server.headersTimeout = 10_000;
    }
    await listen(this.server, this.options.host, this.options.port);
    this.ready = true;
    return this.health();
  }

  health() {
    return Object.freeze({
      ready: this.ready,
      profile: "original-webdir-0x9901",
      endpoint: Object.freeze({ ...this.options, transport: "http" }),
      clientProcessesStarted: 0,
    });
  }

  summary() {
    return Object.freeze({
      ...this.health(),
      profileCount: this.profileDirectory.size,
      requestCount: this.requestCount,
      successCount: this.successCount,
      rejectedCount: this.rejectedCount,
      rejectionReasons: Object.freeze(Object.fromEntries(this.rejectionReasons)),
      lastRejectedRequest: this.lastRejectedRequest,
      privacy: Object.freeze({
        accountPresent: false,
        uinPresent: false,
        petIdPresent: false,
        petNamePresent: false,
        credentialPresent: false,
        ticketPresent: false,
      }),
    });
  }

  async stop() {
    if (this.stopped) return this.summary();
    this.stopped = true;
    this.ready = false;
    await this.remoteCommunity?.stop();
    await close(this.server);
    return this.summary();
  }
}

export async function startOriginalWebdirServer(options) {
  const server = new OriginalWebdirServer(options);
  await server.start();
  return server;
}
