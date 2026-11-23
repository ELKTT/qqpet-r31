// Service copies of the original HTML market pages (NEW-QQPet/QQPenguin/common/market).
//
// The authoritative client tree stays read-only: every byte that is served comes
// from a pinned manifest entry, is re-hashed at startup, and is transformed by the
// byte-anchored rules in this file. A rule whose anchor does not match the locked
// bytes exactly throws instead of shipping a half-rewritten page.
//
// Scope: resource loading, the served URL space and the R1..R10 byte rules of the
// HTML-MARKET-ACCESS design (plus the generated R10/R11/R12 client script). The
// HTTP layer (cache headers, security headers, cookies, the market API route) is
// the caller's responsibility, not this module's.
import {readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nativeAvatarPreviewRules,loadNativeAvatarPreviewMovie} from './market-avatar-preview.js';
import {wardrobeMarketRules} from './wardrobe-market-pages.js';

// The market pages live at http://web.pet.qq.com/common/market/<rel>; the service
// copy answers the same origin-form path on whatever host the caller uses.
export const MARKET_URL_PREFIX = '/common/market/';
export const MARKET_SOURCE_PREFIX = 'common/market/';
export const MARKET_AUTHORITY = 'NEW-QQPet/QQPenguin/common/market';
// The market frame page, and the one entry URL both entries open: the desktop sub-window
// wraps it in PET://$SUB$[...]$SIZE$[800,600], the community panel loads it in an iframe.
// Its own query is the business initialisation the page forwards (rule R13); the panel
// adds its control generation counter and never sends it on.
export const MARKET_FRAME_PATH = '/common/market/frame.htm';
export const MARKET_FRAME_URL = `http://web.pet.qq.com${MARKET_FRAME_PATH}?cmd=frame&panel=store&kind=1&subkind=0&page=1`;
// The generated cross-origin control script (authored here, not in the client).
export const MARKET_GENERATED_PATH = `${MARKET_SOURCE_PREFIX}market-confirm.js`;
const GENERATED_TRANSFORM = 'generated';
// Exactly the origin the pages talk to; never a wildcard.
const CONTROL_ORIGIN = 'http://127.0.0.1:18089';
const MAX_TARGET = 2048;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;

const CONTENT_TYPES = Object.freeze({
  '.htm': 'text/html; charset=gb2312',
  '.html': 'text/html; charset=gb2312',
  '.js': 'text/javascript; charset=gb2312',
  '.css': 'text/css; charset=gb2312',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.swf': 'application/x-shockwave-flash',
  '.htc': 'text/x-component',
});
const QUERY_TYPES = new Set(['.htm', '.html']);

// Every key the locked pages actually put on a page URL. `gen` is part of the
// frame URL contract (R11 reads it from the frame's own query); it is validated
// as a single unsigned integer below.
const ALLOWED_QUERY_KEYS = new Set(['cmd', 'ajax', 'kind', 'subkind', 'page', 'spec', 'id',
  'flush', 'panel', 'pay', 'type', 'items', 'v', 'rt', 'src', 'gen']);
const UNSIGNED = /^(?:0|[1-9][0-9]{0,8})$/;
// Printable ASCII without the percent sign: the locked pages never percent-encode
// or quote a query value, so an encoded one is not a page URL.
const QUERY_VALUE = /^[\x21-\x24\x26-\x7e]+$/;

export class MarketPageError extends TypeError {
  constructor(code, context) {
    super(code);
    this.name = 'MarketPageError';
    this.code = code;
    if (context !== undefined) this.context = context;
  }
}

const contentTypes = (ext) => CONTENT_TYPES[ext] ?? null;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const isPlainSegment = (segment) =>
  Boolean(segment) && segment !== '.' && segment !== '..' && !segment.startsWith('.') && !segment.includes('.svn');

// ---------------------------------------------------------------------------
// Generated client script: market-confirm.js
//
// ASCII only: the whole market tree is served as GB2312, so every character this
// script prints is written as a \uXXXX escape in the served bytes. Responsibilities:
//  - R10: one-shot pay/use submissions (ready -> submitting -> settled | unknown),
//    never re-issued automatically, with the "result unconfirmed" hint.
//  - R11: the only two cross-origin control messages (ready / close).
//  - R12: the exit hint tells the user to use the window's own close button.
// ---------------------------------------------------------------------------
const CONFIRM_SCRIPT = `(function(){
var MARKET_ORIGIN="${CONTROL_ORIGIN}";
var MARKET_BASE="http://web.pet.qq.com/fcgi-bin/market";
var MARKET_LOCAL="/fcgi-bin/market";
var MARKET_FRAME_KEYS=["cmd","panel","kind","subkind","page"];
var MARKET_CONFIRM_PAGES=["quicklybuy.html","shoppingcart.html"];
var COLUMN_WINDOWS={shop:"right_frame",store:"left_frame"};
var HINT_UNKNOWN="\\u7ed3\\u679c\\u672a\\u786e\\u8ba4\\uff0c\\u8bf7\\u5237\\u65b0\\u4ed3\\u5e93\\u540e\\u518d\\u64cd\\u4f5c";
var HINT_SETTLED="\\u8be5\\u64cd\\u4f5c\\u5df2\\u63d0\\u4ea4\\uff0c\\u8bf7\\u5237\\u65b0\\u9875\\u9762\\u540e\\u518d\\u64cd\\u4f5c";
var HINT_SUBMITTING="\\u8be5\\u64cd\\u4f5c\\u6b63\\u5728\\u63d0\\u4ea4\\uff0c\\u8bf7\\u52ff\\u91cd\\u590d\\u64cd\\u4f5c";
var HINT_CLOSE="\\u8bf7\\u4f7f\\u7528\\u7a97\\u53e3\\u81ea\\u5e26\\u7684\\u5173\\u95ed\\u6309\\u94ae\\u5173\\u95ed\\u5ba0\\u7269\\u5546\\u57ce\\u3002";
var HINT_CONFIRMED="\\u5df2\\u5904\\u7406\\uff0c\\u8bf7\\u5237\\u65b0\\u4ed3\\u5e93\\u786e\\u8ba4";
var HINT_NOPOST="\\u5546\\u57ce\\u9875\\u9762\\u65e0\\u6cd5\\u901a\\u77e5\\u5bbf\\u4e3b\\uff0c\\u8bf7\\u5173\\u95ed\\u9762\\u677f\\u540e\\u91cd\\u8bd5\\u3002";
var states={};
var frameReadySent=false;
var columnState={shop:false,store:false};
function marketOn(target,name,fn){
  try{
    if(target.addEventListener){target.addEventListener(name,fn,false);return true;}
    if(target.attachEvent){target.attachEvent("on"+name,function () {return fn(window.event);});return true;}
  }catch(e){}
  return false;
}
function marketParam(name){
  var search=String(window.location.search||"");
  if(search.charAt(0)==="?")search=search.substring(1);
  var parts=search.split("&");
  for(var i=0;i<parts.length;++i){
    var eq=parts[i].indexOf("=");
    if(eq<1)continue;
    if(parts[i].substring(0,eq)===name)return parts[i].substring(eq+1);
  }
  return "";
}
function marketUrl(u){
  if(typeof u!=="string") return null;
  if(/[\\s\\\\#]/.test(u)) return null;
  if(u.indexOf(MARKET_BASE+"?")===0) return MARKET_LOCAL+u.substring(MARKET_BASE.length);
  if(u.indexOf(MARKET_LOCAL+"?")===0) return u;
  return null;
}
// The frame page's own initialization request. The host puts the panel's generation
// counter in the page URL; that value only correlates the ready/close control messages, so
// the business request is rebuilt from the explicit business keys and forwards nothing
// else. Exactly one ajax=1 is added, whatever the page URL carried.
function qqpetFrameDataUrl(){
  var search=String(window.location.search||"");
  if(search.charAt(0)==="?")search=search.substring(1);
  var parts=search.split("&"),out=MARKET_BASE+"?ajax=1";
  for(var i=0;i<parts.length;++i){
    var eq=parts[i].indexOf("=");
    if(eq<1)continue;
    if(!marketContains(MARKET_FRAME_KEYS,parts[i].substring(0,eq)))continue;
    out+="&"+parts[i];
  }
  if(out.indexOf("&cmd=")<0)out+="&cmd=frame";
  return out;
}
function marketGen(){
  var m=/[?&]gen=([0-9]{1,9})(?:&|$)/.exec(String(window.location.search||""));
  return m?parseInt(m[1],10):0;
}
function marketHint(msg){
  var fn=null;
  try{ if(typeof window.market_alt==="function") fn=window.market_alt; }catch(e){}
  if(!fn){ try{ if(window.parent && window.parent!==window && typeof window.parent.market_alt==="function") fn=window.parent.market_alt; }catch(e){} }
  if(fn){ try{ fn(String(msg)); return; }catch(e){} }
  try{ if(typeof window.alert==="function") window.alert(String(msg)); }catch(e){}
}
function marketPost(message){
  var target=null;
  try{ target=window.parent; }catch(e){ return false; }
  if(!target || typeof target.postMessage!=="function") return false;
  try{ target.postMessage(JSON.stringify(message),MARKET_ORIGIN); return true; }catch(e){ return false; }
}
function marketUsable(text,status){
  if(status!==200) return false;
  if(typeof text!=="string" || text.length===0) return false;
  var parsed=null;
  try{ if(typeof GetJSON==="function") parsed=GetJSON(text); }catch(e){ parsed=null; }
  if(parsed && typeof parsed==="object"){
    try{ return ("result" in parsed); }catch(e){ return false; }
  }
  return /\\{[\\s\\S]*["']?result["']?\\s*:/.test(text);
}
function marketIsSubmit(url){
  return /[?&]cmd=(?:pay|use)(?:&|$)/.test(String(url));
}
function marketSubmitKey(url){
  var normalized=marketUrl(url);
  return normalized===null?String(url):normalized;
}
function marketConfirmationPage(url){
  var name=String(url===undefined||url===null?"":url).replace(/[?#][\\s\\S]*$/,"");
  var slash=name.lastIndexOf("/");
  if(slash>=0)name=name.substring(slash+1);
  return marketContains(MARKET_CONFIRM_PAGES,name);
}
// Native WebBrowser document modes predate ES5 Array#indexOf. Keep this
// initializer self-contained so it also runs before either frame is loaded.
function marketContains(values,value){
  for(var i=0;i<values.length;++i)if(values[i]===value)return true;
  return false;
}
// A submission belongs to one explicit user confirmation. Opening the purchase or cart
// confirmation again is a new confirmation and may repeat a settled submission; a result
// dialog, an error dialog or the immediate-use dialog is not, so none of them may unlock
// the submission they belong to. A list that re-renders itself from a server response is
// not a confirmation either, so the store list's own Flush keeps the submission closed;
// the user's own way to the next operation is the list page's normal navigation (a
// category, tab or page link reloads the document) and any other row, whose submission has
// its own identity. An unconfirmed result stays blocked until the page is reloaded.
function marketResetSettled(){
  for(var key in states){ if(states[key]==="settled") delete states[key]; }
}
function marketWrapSynCall(){
  var base=window.syn_call;
  if(typeof base!=="function" || base.__qqpetGuarded) return false;
  var guarded=function(url,lock_name,call_back_func,call_back_arg){
    if(!marketIsSubmit(url)) return base.apply(this,arguments);
    var key=marketSubmitKey(url);
    var state=states[key]||"ready";
    if(state==="submitting"){ marketHint(HINT_SUBMITTING); return null; }
    if(state==="unknown"){ marketHint(HINT_UNKNOWN); return null; }
    if(state==="settled"){ marketHint(HINT_SETTLED); return null; }
    states[key]="submitting";
    var follow=call_back_func;
    var settle=function(resp_text,resp_status,arg){
      states[key]=marketUsable(resp_text,resp_status)?"settled":"unknown";
      if(states[key]==="unknown"){ marketHint(HINT_UNKNOWN); return undefined; }
      return (typeof follow==="function")?follow(resp_text,resp_status,arg):undefined;
    };
    try{ return base.call(this,url,lock_name,settle,call_back_arg); }
    catch(e){
      // A usable server reply has already settled the write. A later page/render
      // failure must not downgrade that confirmed result to an unknown payment.
      if(states[key]==="settled"){
        marketHint(HINT_CONFIRMED);
        return null;
      }
      states[key]="unknown";
      marketHint(HINT_UNKNOWN);
      return null;
    }
  };
  guarded.__qqpetGuarded=true;
  window.syn_call=guarded;
  return true;
}
function marketWrapOpenSub(){
  var base=window.openSub;
  if(typeof base!=="function" || base.__qqpetGuarded) return false;
  var guarded=function(url){
    if(marketConfirmationPage(url)) marketResetSettled();
    return base.apply(this,arguments);
  };
  guarded.__qqpetGuarded=true;
  window.openSub=guarded;
  return true;
}
// The purchase response carries the persisted gid of the row that was just bought. The
// immediate-use dialog needs that identity: the list row carries gid 0 before the buy, and
// using it would feed the wrong number to the use request. A missing, ambiguous or
// non-positive gid is not a row, and the caller then reports the committed order only.
function qqpetPurchasedRow(data,item){
  var rows=(data&&data.purchased)||[];
  if(!rows.length) return null;
  var cid=(item&&item.cid!==undefined&&item.cid!==null)?String(item.cid):"";
  var hit=null;
  for(var i=0;i<rows.length;++i){
    var row=rows[i];
    if(!row)continue;
    if(cid&&String(row.cid)!==cid)continue;
    if(!/^[1-9][0-9]{0,9}$/.test(String(row.gid))) return null;
    if(hit) return null;
    hit={gid:String(row.gid),num:/^[1-9][0-9]{0,3}$/.test(String(row.num))?String(row.num):"1"};
  }
  return hit;
}
function marketReady(){
  if(marketPost({qqpet:"market",type:"ready",gen:marketGen()})) return;
  marketHint(HINT_NOPOST);
}
function marketClose(){
  var parent=null;
  try{
    parent=window.parent;
    if(parent && parent!=window && typeof parent.qqpetMarketClose==="function" && parent.qqpetMarketClose!==marketClose){
      parent.qqpetMarketClose(); return;
    }
  }catch(e){}
  // WebLogic's sub-window consumes browser event 263 (WindowClosing) and hides
  // its own window. MSHTML exposes DOM methods as COM objects, and distinct
  // wrappers for the same IHTMLWindow2 compare equal only with loose equality.
  // Do not require JavaScript's function type for the native close method.
  try{
    if(parent==window){
      window.close(); return;
    }
  }catch(e){}
  if(!marketPost({qqpet:"market",type:"close",gen:marketGen()})){ marketHint(HINT_CLOSE); return; }
  var timer=window.setTimeout(function(){ timer=null; marketHint(HINT_CLOSE); },1500);
  var cancel=function(){ if(timer!==null){ window.clearTimeout(timer); timer=null; } };
  marketOn(window,"pagehide",cancel);
  marketOn(window,"unload",cancel);
}
// Readiness is the frame's own initialization result plus the two columns' own reported
// results, never the load event and never an element that merely exists: a failed
// initialization leaves no usable envelope and no columns, and then no ready is sent at
// all and the host's own timeout and retry take over.
function qqpetFrameReady(){
  if(frameReadySent) return false;
  if(typeof window.frameInit!=="function") return false;   // the columns report, they never open the panel
  var envelope=null,left=null,right=null;
  try{
    if(window.bfail!==false) return false;
    envelope=window.json;
    if(!envelope || String(envelope.result)!=="0") return false;
    left=document.getElementById("left_frame");
    right=document.getElementById("right_frame");
    if(!left || !right || !left.src || !right.src) return false;
  }catch(e){ return false; }
  if(columnState.shop!==true || columnState.store!==true) return false;
  frameReadySent=true;
  marketReady();
  return true;
}
function marketWrapFrameInit(){
  var base=window.frameInit;
  if(typeof base!=="function" || base.__qqpetGuarded) return false;
  var guarded=function(){
    var out=base.apply(this,arguments);
    qqpetFrameReady();
    return out;
  };
  guarded.__qqpetGuarded=true;
  window.frameInit=guarded;
  return true;
}
// The two columns are same-origin children of the frame page and report their own
// initialization result explicitly: the element existing, its load having fired and an
// empty envelope being usable are all true for a column whose script or data failed. The
// frame page accepts a report only from the window it created, for the generation it was
// opened with, and only the two column names it owns.
function marketSelfOrigin(){
  return String(window.location.protocol)+"//"+String(window.location.host);
}
// The column's product rendering reports into this: the locked fill_item() tolerates its own
// failures (an empty catch and a silently skipped write when the target container is
// missing), so a page whose product never appeared would otherwise look exactly like a page
// that rendered. The flag belongs to this document's one initialization render and is
// consulted by the single report the column makes at the end of the page.
var columnRenderFailed=false;
function qqpetColumnRenderFail(){ columnRenderFailed=true; }
function qqpetColumnRenderFailed(){ return columnRenderFailed===true; }
function marketParentGen(){
  try{
    var m=/[?&]gen=([0-9]{1,9})(?:&|$)/.exec(String(window.parent.location.search||""));
    return m?parseInt(m[1],10):0;
  }catch(e){ return 0; }
}
function qqpetColumnResult(column, ok){
  var target=null;
  try{ target=window.parent; }catch(e){ return false; }
  if(!target || target===window || typeof target.postMessage!=="function") return false;
  try{
    target.postMessage(JSON.stringify({qqpet:"market",type:"column",column:String(column),ok:ok===true,gen:marketParentGen()}),marketSelfOrigin());
    return true;
  }catch(e){ return false; }
}
// The frame page's side of the column contract: a report is accepted only from the window
// it created, for the generation it was opened with, and only for the two columns it owns.
// Whether a column succeeded is decided by the column's own page, at the point where its
// initialization and the rendering the page needs are both done (rules R16/R17).
function onQQPetColumnReport(event){
  if(event.origin!==marketSelfOrigin()) return;
  if(typeof event.data!=="string" || event.data.length>256) return;
  var msg=null;
  try{ msg=JSON.parse(event.data); }catch(e){ return; }
  if(!msg || msg.qqpet!=="market" || msg.type!=="column") return;
  if(msg.gen!==marketGen()) return;
  var name=COLUMN_WINDOWS[msg.column];
  if(name===undefined) return;
  var expected=null;
  try{ expected=window.frames?window.frames[name]:null; }catch(e){ expected=null; }
  if(!expected || event.source!==expected) return;
  columnState[msg.column]=msg.ok===true;
  qqpetFrameReady();
}
window.qqpetMarketClose=marketClose;
window.qqpetMarketReady=marketReady;
window.qqpetPurchasedRow=qqpetPurchasedRow;
// frame.htm's own request sender (rule R13) runs in the page scope, so the builder has to
// be a page global like the callbacks above.
window.qqpetFrameDataUrl=qqpetFrameDataUrl;
// The columns' own page reports through this one, from the point where its initialization
// and its necessary rendering both completed (rules R16/R17), and asks the render-failure
// flag that the page's own rendering records (rules R18/R19).
window.qqpetColumnResult=qqpetColumnResult;
window.qqpetColumnRenderFail=qqpetColumnRenderFail;
window.qqpetColumnRenderFailed=qqpetColumnRenderFailed;
window.api_on_close=function(){ return false; };
window.qqpetMarketState=function(){
  var copy={};
  for(var key in states) copy[key]=states[key];
  return copy;
};
function marketBootstrap(){
  marketWrapSynCall();
  marketWrapOpenSub();
  marketWrapFrameInit();
  marketOn(window,"message",onQQPetColumnReport);
  qqpetFrameReady();
}
marketBootstrap();
marketOn(window,"load",marketBootstrap);
})();
`;

export function marketConfirmScript() {
  const body = Buffer.from(CONFIRM_SCRIPT, 'latin1');
  // A single stray non-ASCII byte would silently re-encode the page charset.
  for (const byte of body) if (byte > 0x7e && byte !== 0x0a) throw new MarketPageError('MARKET_PAGE_SCRIPT_NOT_ASCII');
  return body;
}

// ---------------------------------------------------------------------------
// R1..R10 byte rules. Anchors are the locked authoritative bytes (GB2312 bytes
// are written as \x escapes). Every insertion is ASCII: URLs and script tags
// literally, added text as JS \uXXXX escapes in scripts and as numeric character
// entities in HTML.
// ---------------------------------------------------------------------------
const block = (...lines) => lines.join('\r\n');
const E = (find, replace, count = 1) => ({find, replace, count});

// shop.htm / store.htm category menus: the pages build their links from the array
// index (kind == i). Keep all original array positions and render every entry;
// the wearable entry is projected in its original slot by R20 below.
const MENU_LOOP_HEAD = (name) =>
  `    for(var i=0; i<a${name}.length; ++i)\r\n    {\r\n        if(json.data.param.kind == i)`;

// R8/R12: exiting the whole market is the host's decision. qqpetMarketClose() is
// defined by the generated script (parent delegation, then the ready/close control
// message, then the local hint telling the user to use the window close button).
// R8 also carries the error-display compat: frame.js opens every failure through
// OpenErrDiv, which needs showMsg before it can pick a fail_* page.
const CLOSE_CALL = 'window.qqpetMarketClose();';

// The one entry rule R20 adds to each served category menu, in ASCII bytes: the tag, the URL and
// the icon file are literal, the label is written as numeric character references (装扮登记,
// two integers per character) and the id is what a harness (or a later rule) can point at without
// depending on the icon file name.
const WEARABLE_MENU_ENTRY = (from, icon) =>
  `    document.writeln('<li ><a id="qqpet_wearable_entry" href="/wearables?from=${from}">`
  + `<img src="2009/shop/images/menu/${icon}.gif" alt="&#35013;&#25198;&#30331;&#35760;" /></a></li>');`;


export const MARKET_PAGE_RULES = [
  {id: 'R1', file: 'frame.htm', edits: [
    // The errmsg.js script is not in the authoritative set (0 hits tree-wide).
    E('\t<script type="text/javascript" src="http://web.pet.qq.com/js/errmsg.js"></script>\r\n', ''),
  ]},
  {id: 'R2', file: 'frame.htm', edits: [
    // The avatar preview Flash is never instantiated; the 342x260 sizing
    // placeholder stays so the 345+455 layout does not move.
    E(block(
      ' <object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"',
      '             id="avatarPreview" width="342" height="260"',
      '             codebase="http://download.macromedia.com/pub/shockwave/cabs/flash/swflash.cab">',
      '         <param name="movie" value="" />',
      '         <param name="quality" value="high" />',
      '         <param name="allowScriptAccess" value="sameDomain" />',
      '         <param name="wmode" value="transparent" />',
      '         <embed src="" quality="high" width="342" height="260" wmode="transparent"',
      '             name="avatarPreview" align="middle"',
      '             play="true" loop="false" quality="high" allowScriptAccess="sameDomain"',
      '             type="application/x-shockwave-flash"',
      '             pluginspage="http://www.macromedia.com/go/getflashplayer">',
      '         </embed>',
      '</object>'),
      ' <div id="avatar_screen" style="width:342px;height:260px;"></div>'),
    E('        avatarPreview.api_on_getavatar(v1,v2,v3);', '        return 0;'),
    E('        nTask=window.external.api_getavatar(nSeat,nResID);', '        nTask=0;'),
    E(block(
      '\t\tif(nResult == 1)',
      '\t\t{',
      '\t\t    try{',
      '\t\t    window.frames["left_frame"].update_self();',
      '\t\t    }',
      '\t\t    catch(e){}\t\t',
      '\t\t}'), '\t\treturn 0;'),
    E(block(
      '\tfunction api_on_updatepetinfor(petinfor)',
      '\t{',
      '\t\tvar ret;',
      '\t\ttry{',
      '\t\t\tret = eval("ret="+petinfor);',
      '\t\t\tif(user.level == ret.petlevel)',
      '\t\t\t{',
      '\t\t\t\treturn;',
      '\t\t\t}',
      '\t\t\telse',
      '\t\t\t{',
      '\t\t\t\tuser.level = ret.petlevel;',
      '\t\t\t\tsetAvatar();',
      '\t\t\t}',
      '\t\t\t\t',
      '\t\t}',
      '\t\tcatch(e)',
      '\t\t{',
      '\t\t\t//alert("petinfor is not valid");',
      '\t\t\treturn;',
      '\t\t}',
      '\t\t',
      '\t\t',
      '\t}') + '\r\n',
      '\tfunction api_on_updatepetinfor(petinfor)\r\n\t{\r\n\t\treturn 0;\r\n\t}\r\n'),
    E('avatarPreview.LoadMovie(0,window.external.api_getuserroot()+"\\\\common\\\\avatarpreview.swf") ;\r\n', ''),
  ]},
  {id: 'R2', file: 'frame.js', edits: [
    E('\t\tavatarPreview.changeAvartar(strAvatar);',
      '\t\tif(window.avatarPreview && avatarPreview.changeAvartar)\r\n\t\t\tavatarPreview.changeAvartar(strAvatar);'),
  ]},
  {id: 'R4', file: 'shop.htm', edits: [
    // Paging must stay on the same origin and keep the leading slash: the original
    // strips it and rebuilds a file:/// URL.
    E(block(
      '\t\tvar wpath = window.location.pathname;',
      "\t\tif(wpath.charAt(0) == '/')",
      '\t\t{',
      '\t\t\twpath = wpath.substring(1);',
      '\t\t}',
      '\t\ttheManager = new PageManager(ipagesize, json.data, fill_item, fill_link, "file:///"+wpath+"?cmd=shop&ajax=1&kind="+json.data.param.kind+"&subkind="+json.data.param.subkind+"&page=");'),
      '\t\ttheManager = new PageManager(ipagesize, json.data, fill_item, fill_link, window.location.pathname+"?cmd=shop&ajax=1&kind="+json.data.param.kind+"&subkind="+json.data.param.subkind+"&page=");'),
  ]},
  {id: 'R4', file: 'store.htm', edits: [
    E('            if(item.struct == "AvatarConf" || item.kind == "31" || item.kind == "4" || item.kind == "7" || item.kind == "8" || item.kind == "9" )',
      '            if(item.usable == "0") { tmpI.SetParam("title", ""); tmpI.SetParam("classname", "bsy"); }\r\n'
      +'            else if(item.struct == "AvatarConf" || item.kind == "31" || item.kind == "4" || item.kind == "7" || item.kind == "8" || item.kind == "9" )'),
    E(block(
      '\t\tvar wpath = window.location.pathname;',
      "\t\tif(wpath.charAt(0) == '/')",
      '\t\t{',
      '\t\t\twpath = wpath.substring(1);',
      '\t\t}',
      '\t    theManager = new PageManager(ipagesize, json.data, fill_item, fill_link, "file:///"+wpath+"?cmd=store&ajax=1&kind="+json.data.param.kind+"&subkind="+json.data.param.subkind+"&page=");'),
      '\t    theManager = new PageManager(ipagesize, json.data, fill_item, fill_link, window.location.pathname+"?cmd=store&ajax=1&kind="+json.data.param.kind+"&subkind="+json.data.param.subkind+"&page=");'),
  ]},
  {id: 'R5', file: 'call.js', edits: [
    // Single URL conversion point: call.js is the only place the pages issue HTTP.
    E('var call_locks = [];\r\n',
      'var call_locks = [];\r\n'
      + 'function market_url(u)\r\n'
      + '{\r\n'
      + '        var remote = "http://web.pet.qq.com/fcgi-bin/market";\r\n'
      + '        var local = "/fcgi-bin/market";\r\n'
      + '        if(typeof u != "string" || /[\\s\\\\#]/.test(u))\r\n'
      + '        {\r\n'
      + '                return null;\r\n'
      + '        }\r\n'
      + '        if(u.indexOf(remote+"?") == 0)\r\n'
      + '        {\r\n'
      + '                return local+u.substring(remote.length);\r\n'
      + '        }\r\n'
      + '        if(u.indexOf(local+"?") == 0)\r\n'
      + '        {\r\n'
      + '                return u;\r\n'
      + '        }\r\n'
      + '        return null;\r\n'
      + '}\r\n'
      + 'function market_reject()\r\n'
      + '{\r\n'
      + '        var msg = "\\u5df2\\u62d2\\u7edd\\u975e\\u672c\\u5730\\u5e02\\u573a\\u5730\\u5740\\u7684\\u8bf7\\u6c42";\r\n'
      + '        try{\r\n'
      + '                if(typeof market_alt == "function")\r\n'
      + '                {\r\n'
      + '                        market_alt(msg, "");\r\n'
      + '                        return null;\r\n'
      + '                }\r\n'
      + '        }\r\n'
      + '        catch(e){}\r\n'
      + '        try{\r\n'
      + '                if(window.parent && window.parent != window && typeof window.parent.market_alt == "function")\r\n'
      + '                {\r\n'
      + '                        window.parent.market_alt(msg, "");\r\n'
      + '                        return null;\r\n'
      + '                }\r\n'
      + '        }\r\n'
      + '        catch(e){}\r\n'
      + '        try{\r\n'
      + '                if(typeof alert == "function")\r\n'
      + '                {\r\n'
      + '                        alert(msg);\r\n'
      + '                }\r\n'
      + '        }\r\n'
      + '        catch(e){}\r\n'
      + '        return null;\r\n'
      + '}\r\n'),
    E('function syn_call(url,lock_name,call_back_func,call_back_arg)\r\n{\r\n',
      'function syn_call(url,lock_name,call_back_func,call_back_arg)\r\n{\r\n'
      + '        url = market_url(url);\r\n'
      + '        if(url === null)\r\n'
      + '        {\r\n'
      + '                return market_reject();\r\n'
      + '        }\r\n'),
    E('        xmlHttpReq.open("GET", url, false);\r\n',
      '        xmlHttpReq.open("GET", url, false);\r\n'
      + '        xmlHttpReq.setRequestHeader("X-QQPet-Community", "1");\r\n'),
    // A throwing transport must not leave the lock pinned at 1 (the page would go
    // silently dead); the exception itself keeps propagating as before.
    E('        xmlHttpReq.send(null); \r\n}',
      '        try\r\n'
      + '        {\r\n'
      + '                xmlHttpReq.send(null); \r\n'
      + '        }\r\n'
      + '        catch(e)\r\n'
      + '        {\r\n'
      + '                call_locks[lock_name] = 0;\r\n'
      + '                throw e;\r\n'
      + '        }\r\n}'),
  ]},
  {id: 'R6', file: 'market.js', edits: [
    // Only the wp/ product images exist in the care resource catalogue (the other
    // img.pet.qq.com namespaces are not), so only that branch is routed through the
    // same-origin care-image route; the rest keep their original addresses.
    E(block(
      '    if(item.struct == "FeedConf")',
      '\t\tif(item.kind == "13")',
      "\t\t\tpicstr = 'wp/'+ item.pic +'_s.gif\"';",
      '\t\telse',
      "\t\t\tpicstr = 'wp/'+ item.pic +'.gif\"';"),
      block(
        '    if(item.struct == "FeedConf")',
        '\t{',
        '\t\theadstr = \'><img src="/community/care-image/\';',
        '\t\tif(item.kind == "13")',
        "\t\t\tpicstr = 'wp/'+ item.pic +'_s.gif\"';",
        '\t\telse',
        "\t\t\tpicstr = 'wp/'+ item.pic +'.gif\"';",
        '\t}')),
  ]},
  {id: 'R7', file: 'feed.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
    E('http://img.pet.qq.com/2009/alert/images/', '2009/alert/images/', 2),
  ]},
  {id: 'R9', file: 'feed.htm', edits: [
    E('\twindow.location = "pet://$SUB$[http://web.pet.qq.com/vippay.html]";\r\n',
      '\twindow.location = "pet://$SUB$[http://web.pet.qq.com/gameplay/vip]";\r\n'),
  ]},
  {id: 'R8', file: 'frame.js', edits: [
    E('\twindow.close();\r\n', `\t${CLOSE_CALL}\r\n`),
    // OpenErrDiv reads `strmsg = showMsg(obj)` before it selects any fail_* page, and
    // presented.html reaches the same function as parent.showMsg. The original came
    // from the remote /js/errmsg.js, which is in no authoritative set (0 hits
    // tree-wide), so the minimal compat implementation of design 2.4 lives here: read
    // the message, cap it at 200 characters and entity-escape it, because sAlert
    // (2009/alert/alert.js) assigns the result to innerHTML.
    E('function OpenErrDiv(obj, repay, bfatal)\r\n{\r\n',
      block(
        'function showMsg(obj){',
        "    var msg=(obj && (obj.msg || obj.errmsg)) ? String(obj.msg || obj.errmsg) : '\\u64cd\\u4f5c\\u672a\\u5b8c\\u6210';",
        '    return escHtml(msg.substring(0,200));',
        '}',
        'function escHtml(text){',
        "    return String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')",
        "        .replace(/\"/g,'&quot;').replace(/'/g,'&#39;').replace(/\\r/g,'&#13;').replace(/\\n/g,'&#10;');",
        '}',
        '',
        'function OpenErrDiv(obj, repay, bfatal)\r\n{\r\n')),
  ]},
  {id: 'R8', file: 'frame.htm', edits: [
    E('"window.close()"', '"qqpetMarketClose()"'),
  ]},
  {id: 'R8', file: 'store.htm', edits: [
    E('\t\t\t\twindow.parent.close();\r\n', `\t\t\t\t${CLOSE_CALL}\r\n`),
  ]},
  {id: 'R7', file: 'fail_yb.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
  ]},
  {id: 'R9', file: 'fail_yb.htm', edits: [
    E(block(
      'function on_btn_pay()',
      '{',
      '    var local_arg = parent.globe_arg;',
      '    if(gType == "qb")',
      '    {',
      '        if(document.getElementById("qbqd").checked )',
      '            local_arg.payway = "qbqd";',
      '        else',
      '            local_arg.payway = "qb";',
      '    }',
      '    else{',
      '        if(document.getElementById("qdqb").checked )',
      '            local_arg.payway = "qdqb";',
      '        else',
      '            local_arg.payway = "qd";',
      '    }',
      '    parent.repay(local_arg);\t',
      '}') + '\r\n',
      'function on_btn_pay()\r\n{\r\n    parent.market_alt("\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a");\r\n}\r\n'),
    E('\t  <p ><input name="cmd" type="radio" value="3"  checked="checked" onclick="show(kb2,kb1);web_setPayType(\'qd\')">Q\xb5\xe3\xd6\xa7\xb8\xb6 &nbsp;&nbsp;&nbsp;<input name="cmd" type="radio" value="2" onclick="show(kb1,kb2);web_setPayType(\'qb\')">Q\xb1\xd2\xd6\xa7\xb8\xb6</p>\r\n',
      '\t  <p >&#24403;&#21069;&#20165;&#25903;&#25345;&#20803;&#23453;&#25903;&#20184;&#65292;&#20854;&#20182;&#25903;&#20184;&#26041;&#24335;&#26242;&#26410;&#25509;&#36890;&#12290;</p>\r\n'),
    E('\t  <div id="kb1" style="display:none"><input id="qbqd" type="checkbox" checked="checked"><span id="textspan">Q\xb1\xd2\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xca\xb9\xd3\xc3Q\xb5\xe3\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3</span></div>\r\n'
      + '\t  <div id="kb2" ><input id="qdqb" type="checkbox" checked="checked"><span id="textspan">Q\xb5\xe3\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xca\xb9\xd3\xc3Q\xb1\xd2\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3</span></div>\r\n',
      ''),
  ]},
  {id: 'R7', file: 'fail_qb.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
  ]},
  {id: 'R9', file: 'fail_qb.htm', edits: [
    E('<a href="PET://$IE$[http://pay.qq.com/zft/paycenter_fo.shtml]"  >',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
  ]},
  {id: 'R7', file: 'fail_qb_2.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
  ]},
  {id: 'R9', file: 'fail_qb_2.htm', edits: [
    E('    var local_arg = parent.globe_arg;\r\n    local_arg.payway = "qbqd";\r\n    parent.repay(local_arg);\t\r\n',
      '    parent.market_alt("\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a");\r\n'),
    E('<a href="PET://$IE$[http://pay.qq.com/zft/paycenter_fo.shtml]">',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
  ]},
  {id: 'R7', file: 'fail_qd.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
  ]},
  {id: 'R9', file: 'fail_qd.htm', edits: [
    E('<a href="PET://$IE$[http://pay.qq.com/paycenter/paycenter_qb.shtml?cm=qqcard]">',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
    E('<a href="PET://$IE$[http://pay.qq.com/zft/paycenter_fo_tenpay.shtml]">',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
    E('<a href="PET://$IE$[http://pay.qq.com/zft/paycenter_fo.shtml]">',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
  ]},
  {id: 'R7', file: 'fail_qd_2.htm', edits: [
    E(' <link rel="stylesheet" href="http://img.pet.qq.com/2009/tips/style/main.css" type="text/css" media="all"/>\r\n', ''),
  ]},
  {id: 'R9', file: 'fail_qd_2.htm', edits: [
    E('    var local_arg = parent.globe_arg;\r\n    local_arg.payway = "qdqb";\r\n    parent.repay(local_arg);\t\r\n',
      '    parent.market_alt("\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a");\r\n'),
    E('<a href="PET://$IE$[http://pay.qq.com/zft/paycenter_fo.shtml]" >',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')" >'),
  ]},
  {id: 'R9', file: 'shoppingcart.html', edits: [
    // Only 元宝 payment remains selectable; the removed radio ids are no longer
    // referenced by showPrice(), whose unreachable Q点 branch is dropped with them.
    E('\t       <input type="radio" name="payradio" onclick="change_pay(0)" />Q\xb1\xd2\xd6\xa7\xb8\xb6\r\n'
      + '\t\t   <input type="radio" id="radio_qd" name="payradio" onclick="change_pay(1)" />Q\xb5\xe3\xd6\xa7\xb8\xb6\r\n',
      ''),
    E('\t\t   <input type="radio" id="showta" name="payradio"  onclick="change_pay(3)" />\xcb\xfb\xc8\xcb\xd6\xa7\xb8\xb6\r\n', ''),
    E('\t\t\t\t$("radio_qd").checked = true;\r\n                change_pay(1);\r\n', ''),
    // The mixed-payment hints of the removed radios are the only remaining
    // non-元宝 payment labels in the served bytes, so they are emptied too; the
    // third branch (支付QQ号码) also carried its own real_buy() submit control.
    E('        strout +=\' />Q\xb1\xd2\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xd3\xc3Q\xb5\xe3\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3\';\r\n',
      '        strout +=\'\';\r\n'),
    E('        strout +=\' />Q\xb5\xe3\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xd3\xc3Q\xb1\xd2\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3\';\r\n',
      '        strout +=\'\';\r\n'),
    E('         strout = \'\xd6\xa7\xb8\xb6QQ\xba\xc5\xc2\xeb\xa3\xba<input id="input_otheruin" type="text" size="12" maxlength="12" value="" onkeypress="input_is_num();" onpaste="return false;" /><input type="image" src="2009/shop/images/cs_03.gif" onclick="real_buy()" />\';\r\n',
      '         strout = \'\';\r\n'),
    E('<a href="pet://$IE$[http://pay.qq.com]">',
      '<a href="javascript:parent.market_alt(\'\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a\')">'),
  ]},
  {id: 'R9', file: 'quicklybuy.html', edits: [
    E('     <p class="radiotd"><input type="radio" name="payradio" onclick="change_pay(0)" />Q\xb1\xd2\xd6\xa7\xb8\xb6\r\n',
      '     <p class="radiotd">\r\n'),
    E(block(
      '\t    <script type="text/javascript"> ',
      '\t\tif(xxx.item.sell_pay == "yb")',
      '\t\t{',
      '\t\t\tpay_check = 2;',
      '\t\t\tdocument.write(\'<input type="radio" name="payradio" onclick="change_pay(1)" />Q\xb5\xe3\xd6\xa7\xb8\xb6\');',
      '\t\t    document.write(\'<input type="radio" name="payradio" onclick="change_pay(2)" checked="checked" />\xd4\xaa\xb1\xa6\xd6\xa7\xb8\xb6\');',
      '\t\t}',
      '\t\telse',
      '\t\t{',
      '\t\t\tpay_check = 1;',
      '\t\t\tdocument.write(\'<input type="radio" name="payradio" onclick="change_pay(1)" checked="checked" />Q\xb5\xe3\xd6\xa7\xb8\xb6\');',
      '\t\t\tdocument.write(\'<input type="radio" name="payradio" onclick="change_pay(2)" disabled />\xd4\xaa\xb1\xa6\xd6\xa7\xb8\xb6\');',
      '\t\t}',
      '\t\t</script>'),
      block(
        '\t    <script type="text/javascript"> ',
        '\t\tpay_check = 2;',
        '\t\tdocument.write(\'<input type="radio" name="payradio" checked="checked" />\xd4\xaa\xb1\xa6\xd6\xa7\xb8\xb6\');',
        '\t\t</script>')),
    E('\t    <input type="radio" name="payradio" onclick="change_pay(3)" />\xcb\xfb\xc8\xcb\xd6\xa7\xb8\xb6\r\n', ''),
    // See shoppingcart.html: the mixed-payment hint labels of the removed radios
    // are emptied so the served page carries no non-元宝 payment label.
    E('        strout +=\' />Q\xb1\xd2\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xd3\xc3Q\xb5\xe3\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3\';\r\n',
      '        strout +=\'\';\r\n'),
    E('        strout +=\' />Q\xb5\xe3\xd3\xe0\xb6\xee\xb2\xbb\xd7\xe3\xd3\xc3Q\xb1\xd2\xd6\xa7\xb8\xb6\xb2\xbb\xd7\xe3\xb7\xd1\xd3\xc3\';\r\n',
      '        strout +=\'\';\r\n'),
    E('         strout = \'\xd6\xa7\xb8\xb6QQ\xba\xc5\xc2\xeb\xa3\xba<input id="input_otheruin" type="text" size="12" maxlength="12" value="" onkeypress="input_is_num();"  />\';\r\n',
      '         strout = \'\';\r\n'),
    // 索要 (pay for another account) is not a local payment path: local hint only.
    E(block(
      "        if(strpayway == 'suoyao')",
      '        {',
      '\t\t\tvar otheruin = document.getElementById("input_otheruin").value;',
      '             if( isNaN(parseInt(otheruin))|| parseInt(otheruin) < 10000 )',
      '            {',
      '                parent.market_alt2("\xd6\xa7\xb8\xb6QQ\xba\xc5\xb2\xbb\xca\xc7\xba\xcf\xb7\xa8\xb5\xc4QQ\xba\xc5");',
      '                return;',
      '            }',
      "            strurl = 'http://web.pet.qq.com/fcgi-bin/suoyao?cmd=ask&pay='+otheruin+'&items='+xxx.item.cid +\":\" + xxnum;",
      '            //parent.market_alt(strurl+":\xcb\xf7\xd2\xaa\xce\xb4\xca\xb5\xcf\xd6");',
      '            parent.DoSuoyao(strurl, false);',
      '        }') + '\r\n',
      '        if(strpayway == \'suoyao\')\r\n        {\r\n            parent.market_alt2("\\u8be5\\u529f\\u80fd\\u5c1a\\u672a\\u63a5\\u901a");\r\n            return;\r\n        }\r\n'),
  ]},
  {id: 'R13', file: 'frame.htm', edits: [
    // frame.htm:131 forwards the whole page query into the API request. The page URL also
    // carries the panel's generation counter, which is a control value and not business
    // input, so the request is rebuilt from the explicit whitelist in the generated script:
    // cmd/panel/kind/subkind/page travel, one ajax=1 is added, nothing else does.
    E('\tsyn_call("http://web.pet.qq.com/fcgi-bin/market"+window.location.search+"&ajax=1", "frame_data", CallBackFrame,"");\r\n',
      '\tsyn_call(qqpetFrameDataUrl(), "frame_data", CallBackFrame,"");\r\n'),
  ]},
  {id: 'R14', file: 'frame.js', edits: [
    // CallBackBuy hands the list row to the immediate-use dialog. That row still carries
    // gid 0 (it is not in the inventory yet) while feed.htm sends its gid as the use id, so
    // the row is first resolved against the purchased rows of this response. Without a
    // single positive gid the order is only reported and no dialog opens on a stale row.
    E(block(
      '\t\t\t    if(typeof(aaa.url)=="object" && aaa.url.kind && (aaa.url.kind=="1" || aaa.url.kind=="2"))',
      '\t\t\t    {',
      '\t\t\t\t\tOpenFeedDiv(aaa.url);',
      '\t\t\t    }',
      '\t\t\t    else',
      '\t\t\t    {',
      '\t\t\t\t    market_alt_ok("\xb9\xba\xc2\xf2\xb3\xc9\xb9\xa6");',
      '\t\t\t\t}') + '\r\n',
      block(
        '\t\t\t    if(typeof(aaa.url)=="object" && aaa.url.kind && (aaa.url.kind=="1" || aaa.url.kind=="2"))',
        '\t\t\t    {',
        '\t\t\t\t\tvar qqpet_buy_row = qqpetPurchasedRow(buyjson.data, aaa.url);',
        '\t\t\t\t\tif(qqpet_buy_row)',
        '\t\t\t\t\t{',
        '\t\t\t\t\t\taaa.url.gid = qqpet_buy_row.gid;',
        '\t\t\t\t\t\taaa.url.num = qqpet_buy_row.num;',
        '\t\t\t\t\t\tOpenFeedDiv(aaa.url);',
        '\t\t\t\t\t}',
        '\t\t\t\t\telse',
        '\t\t\t\t\t{',
        '\t\t\t\t\t\tmarket_alt_ok("\\u5df2\\u5904\\u7406\\uff0c\\u8bf7\\u5237\\u65b0\\u4ed3\\u5e93\\u786e\\u8ba4");',
        '\t\t\t\t\t}',
        '\t\t\t    }',
        '\t\t\t    else',
        '\t\t\t    {',
        '\t\t\t\t    market_alt_ok("\xb9\xba\xc2\xf2\xb3\xc9\xb9\xa6");',
        '\t\t\t\t}') + '\r\n'),
  ]},
  {id: 'R15', file: 'frame.htm', edits: [
    // The locked frameInit() sets bfail for a business failure (result != '0') and then
    // clears it again on the next line, so the failure branch ends up looking exactly like
    // the empty-envelope branch that frame.htm itself treats as fatal a few lines below.
    // The failure keeps its flag and leaves the rest of the success path unrun.
    E(block(
      "\t\tif(json.result!='0')",
      '\t\t{',
      '\t\t\tmarketerr = json;',
      '\t\t\tjson = emptyjson;',
      '\t\t\tbfail = true;',
      '\t\t}',
      '\t\tbfail = false;') + '\r\n',
      block(
        "\t\tif(json.result!='0')",
        '\t\t{',
        '\t\t\tmarketerr = json;',
        '\t\t\tjson = emptyjson;',
        '\t\t\tbfail = true;',
        '\t\t\treturn;',
        '\t\t}',
        '\t\tbfail = false;') + '\r\n'),
  ]},
  {id: 'R16', file: 'shop.htm', edits: [
    // The column reports success only here, where the locked page's own necessary rendering
    // has completed: the head's synchronous fetch and initShop() created the manager, and
    // this body statement rendered the page through JSTemplate and the DOM. A missing
    // template script, a throwing fill_*, an unusable success envelope or a failed
    // initialization all end before this line, so none of them can be reported as a
    // successful column by a later script or by the load event. Rendering failures that the
    // page itself tolerates are reported by rule R18 into the flag this line consults.
    E('\ttheManager.GoPage(json.data.param.page);\r\n',
      '\ttheManager.GoPage(json.data.param.page);\r\n\tqqpetColumnResult("shop", !qqpetColumnRenderFailed());\r\n'),
  ]},
  {id: 'R17', file: 'store.htm', edits: [
    E('\ttheManager.GoPage(json.data.param.page);\r\n',
      '\ttheManager.GoPage(json.data.param.page);\r\n\tqqpetColumnResult("store", !qqpetColumnRenderFailed());\r\n'),
  ]},
  {id: 'R18', file: 'shop.htm', edits: [
    // fill_item() is where a product becomes visible, and the locked page tolerates two
    // failures inside it: its own try/catch is empty, and a missing mall_showcon silently
    // skips the write. Both are recorded for this render, so the one report the column
    // makes cannot claim success for a page whose product never appeared. The catch stays a
    // catch (the page keeps running and keeps its own prompts) and the write path is
    // unchanged: only the outcome is remembered.
    E(block(
      '\t\t    if(dest_div)',
      '\t\t        dest_div.innerHTML = strFillItem;',
      '\t\t}',
      '\t\t',
      '\t\t}',
      '\t\tcatch(e)',
      '\t\t{',
      '\t\t}') + '\r\n',
      block(
        '\t\t    if(dest_div)',
        '\t\t        dest_div.innerHTML = strFillItem;',
        '\t\t    else',
        '\t\t        qqpetColumnRenderFail();',
        '\t\t}',
        '\t\t',
        '\t\t}',
        '\t\tcatch(e)',
        '\t\t{',
        '\t\t\tqqpetColumnRenderFail();',
        '\t\t}') + '\r\n'),
  ]},
  {id: 'R19', file: 'store.htm', edits: [
    E(block(
      '\t\t    if(dest_div)',
      '\t\t        dest_div.innerHTML = strFillItem;',
      '\t\t}',
      '\t\t}',
      '\t\tcatch(e)',
      '\t\t{',
      '\t\t}') + '\r\n',
      block(
        '\t\t    if(dest_div)',
        '\t\t        dest_div.innerHTML = strFillItem;',
        '\t\t    else',
        '\t\t        qqpetColumnRenderFail();',
        '\t\t}',
        '\t\t}',
        '\t\tcatch(e)',
        '\t\t{',
        '\t\t\tqqpetColumnRenderFail();',
        '\t\t}') + '\r\n'),
  ]},
  // R20: the registered wearable category is a page of this service (/wearables), and neither
  // trimmed menu reaches it: the loops above dropped every entry but 喂养, which is exactly why
  // the category could only be opened by typing its URL. Each page's own category list gets one
  // more entry, written by the same document.writeln the list is built with and linking with a
  // plain <li><a href> like every other category — no script, no fetch, no API the old market
  // browser does not have, so the click navigates the column the way the 喂养 entry does.
  // The artwork is the icon the page's own array already uses for that slot (shop.htm: mall_08,
  // store.htm: mall_24), the label travels as numeric character entities so the served bytes stay
  // ASCII, and `from` is what the page answers with its own way back to the column that was left.
  // The original category slot now reaches the existing registered dress page.
  // Every other original main/sub-category remains visible in its original order.
  ...[['shop.htm','shop',2,'mall_08'],['store.htm','store',0,'mall_24']].map(([file,column,index,icon]) => ({
    id:'R20',file,edits:[E(MENU_LOOP_HEAD('Pics'),
      MENU_LOOP_HEAD('Pics').replace('        if(json.data.param.kind == i)', block(
        `        if(i == ${index})`,
        '        {',
        WEARABLE_MENU_ENTRY(column,icon),
        '            continue;',
        '        }',
        '        if(json.data.param.kind == i)')))],
  })),
  {id:'R21',file:'store.htm',edits:[E(
    'links:["","PET://$SUB$[http://act.pet.qq.com/cgi-bin/magic_feed?cmd=6&type=1&pageno=1]", "PET://$SUB$[http://act.pet.qq.com/cgi-bin/magic_feed?cmd=6&type=2&pageno=1]"]',
    'links:["","store.htm?cmd=store&ajax=1&kind=2&subkind=1", "store.htm?cmd=store&ajax=1&kind=2&subkind=2"]') ]},
];

// R10: the confirmation lifecycle script is appended to every page that can submit
// a pay/use request (frame.htm reaches frame.js's DoBuy/repay through syn_call).
const CONFIRM_SCRIPT_TAG = '<script type="text/javascript" src="market-confirm.js"></script>\r\n';
const CONFIRM_SCRIPT_PAGES = Object.freeze([
  'frame.htm', 'feed.htm', 'shop.htm', 'store.htm', 'shoppingcart.html', 'quicklybuy.html',
]);

for (const file of CONFIRM_SCRIPT_PAGES) {
  MARKET_PAGE_RULES.push({id: 'R10', file, edits: [E('</head>', CONFIRM_SCRIPT_TAG + '</head>')]});
}
for (const rule of MARKET_PAGE_RULES) Object.freeze(rule);
Object.freeze(MARKET_PAGE_RULES);

function pageRules({nativeAvatarPreview=false,wardrobeEnabled=false}={}) {
  if(typeof nativeAvatarPreview!=='boolean')throw new MarketPageError('MARKET_AVATAR_PREVIEW_OPTION_INVALID');
  if(typeof wardrobeEnabled!=='boolean'||(wardrobeEnabled&&!nativeAvatarPreview))throw new MarketPageError('WARDROBE_REQUIRES_NATIVE_PREVIEW');
  const rules=nativeAvatarPreview?nativeAvatarPreviewRules(MARKET_PAGE_RULES,{wardrobeEnabled}):MARKET_PAGE_RULES;
  return wardrobeEnabled?wardrobeMarketRules(rules):rules;
}
export function marketPageTransformRules(options) {
  return pageRules(options).map(({id, file, edits}) =>
    Object.freeze({id, file, transform: `${MARKET_SOURCE_PREFIX}${file}`,
      hits: edits.reduce((total, edit) => total + edit.count, 0)}));
}

// The pinned transform field of a manifest entry: 'none', 'generated' or the
// comma-joined rule ids that touch the file, in rule order.
export function marketPageTransformOf(source, options) {
  if (source === MARKET_GENERATED_PATH) return GENERATED_TRANSFORM;
  const ids = pageRules(options).filter((rule) => `${MARKET_SOURCE_PREFIX}${rule.file}` === source)
    .map((rule) => rule.id);
  return ids.length ? [...new Set(ids)].join(',') : 'none';
}

// Apply one file's rules to the locked bytes. Anchors are matched against the
// original buffer, so every hit count and every modified window is reported in
// original byte coordinates; the rewritten buffer is assembled from those windows.
function transformSource(source, sourcePath, options) {
  const applicable = pageRules(options).filter((rule) => `${MARKET_SOURCE_PREFIX}${rule.file}` === sourcePath);
  const windows = [];
  for (const rule of applicable) {
    for (const edit of rule.edits) {
      const find = Buffer.from(edit.find, 'latin1');
      const replace = Buffer.from(edit.replace, 'latin1');
      if (!find.length) throw new MarketPageError('MARKET_PAGE_ANCHOR_EMPTY', {rule: rule.id, source: sourcePath});
      let from = 0;
      let hits = 0;
      for (;;) {
        const at = source.indexOf(find, from);
        if (at < 0) break;
        windows.push({rule: rule.id, start: at, end: at + find.length, replace});
        from = at + find.length;
        hits += 1;
      }
      if (hits !== edit.count)
        throw new MarketPageError(`MARKET_PAGE_ANCHOR_MISMATCH:${rule.id}`,
          {source: sourcePath, expected: edit.count, actual: hits});
    }
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const parts = [];
  let cursor = 0;
  for (const window of windows) {
    if (window.start < cursor)
      throw new MarketPageError('MARKET_PAGE_ANCHOR_OVERLAP', {source: sourcePath, rule: window.rule});
    parts.push(source.subarray(cursor, window.start), window.replace);
    cursor = window.end;
  }
  parts.push(source.subarray(cursor));
  return {body: Buffer.concat(parts), windows};
}

function parseQuery(query) {
  const seen = new Map();
  for (const pair of query.split('&')) {
    const equals = pair.indexOf('=');
    if (equals <= 0) return false;
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (!ALLOWED_QUERY_KEYS.has(key)) return false;
    if (!QUERY_VALUE.test(value)) return false;
    if (key === 'ajax' && value !== '1') return false;
    if (key === 'gen' && !UNSIGNED.test(value)) return false;
    const values = seen.get(key);
    if (values) {
      // The locked pages rebuild a page link with ajax=1 already present and then
      // append ajax=1 again; only that proven same-value duplicate is tolerated.
      if (!(key === 'ajax' && value === '1' && values.every((seenValue) => seenValue === '1'))) return false;
      values.push(value);
    } else {
      seen.set(key, [value]);
    }
  }
  return true;
}

export class MarketPageResources {
  #files = new Map();
  #audit = [];
  #treeSha256 = '';

  constructor(entries, audit = [], options) {
    pageRules(options);
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES)
      throw new MarketPageError('MARKET_PAGE_CATALOGUE_INVALID');
    let total = 0;
    const digestLines = [];
    for (const entry of entries) {
      const source = entry?.source;
      if (typeof source !== 'string' || !source.startsWith(MARKET_SOURCE_PREFIX)
          || !source.split('/').every(isPlainSegment))
        throw new MarketPageError('MARKET_PAGE_SOURCE_INVALID');
      const type = contentTypes(path.posix.extname(source).toLowerCase());
      if (!type || this.#files.has(source)) throw new MarketPageError('MARKET_PAGE_SOURCE_INVALID', {source});
      if (!Buffer.isBuffer(entry.body) || entry.body.length > MAX_SOURCE_BYTES
          || (total += entry.body.length) > MAX_TOTAL_BYTES)
        throw new MarketPageError('MARKET_PAGE_SOURCE_INVALID', {source});
      const transform = typeof entry.transform === 'string' ? entry.transform : '';
      if (transform !== GENERATED_TRANSFORM && transform !== marketPageTransformOf(source, options))
        throw new MarketPageError('MARKET_PAGE_TRANSFORM_INVALID', {source});
      // Byte-identical and rewritten files are both hash-checked against the pin.
      if (sha256(entry.body) !== entry.sha256)
        throw new MarketPageError('MARKET_PAGE_SOURCE_CHANGED', {source});
      this.#files.set(source, {contentType: type, body: Buffer.from(entry.body), transform,
        query: QUERY_TYPES.has(path.posix.extname(source).toLowerCase())});
      digestLines.push(`${source} ${entry.sha256}`);
    }
    this.#treeSha256 = sha256(Buffer.from(digestLines.sort().join('\n'), 'latin1'));
    this.#audit = audit.map((item) => Object.freeze({...item}));
  }

  // target is the origin-form path plus query of the served URL space. A malformed
  // or unknown target resolves to null and never throws.
  resolve(target) {
    if (typeof target !== 'string' || !target.length || target.length > MAX_TARGET) return null;
    if (/[\x00-\x20\x7f\\#]/.test(target)) return null;
    const [pathname, query, extra] = target.split('?');
    if (extra !== undefined) return null;
    if (!pathname.startsWith(MARKET_URL_PREFIX)) return null;
    const relative = pathname.slice(MARKET_URL_PREFIX.length);
    if (!relative || !relative.split('/').every(isPlainSegment)) return null;
    const file = this.#files.get(MARKET_SOURCE_PREFIX + relative);
    if (!file) return null;
    if (query !== undefined) {
      // Pages may carry a whitelisted query; images, scripts and styles never do.
      if (!file.query) return null;
      if (!parseQuery(query)) return null;
    }
    return {contentType: file.contentType, body: Buffer.from(file.body)};
  }

  get manifestSummary() {
    let transformed = 0;
    for (const file of this.#files.values()) if (file.transform !== 'none') transformed += 1;
    return Object.freeze({
      sourceCount: this.#files.size,
      transformedCount: transformed,
      byteIdenticalCount: this.#files.size - transformed,
      authorityTreeSha256: this.#treeSha256,
    });
  }

  // Audit view of the rewrite: per source file the rule id, the original byte
  // window of every replacement and the replacement length. Used by the tests (and
  // by the implementation report) to prove that the untouched bytes are untouched.
  audit() {
    return this.#audit.map((item) => ({...item, windows: item.windows.map((window) => [...window])}));
  }
}

export async function loadMarketPageResources(authorityRoot, manifest, options) {
  pageRules(options);
  if (manifest?.schemaVersion !== 1 || manifest.authority !== MARKET_AUTHORITY
      || !Array.isArray(manifest.entries) || manifest.entries.length < 1
      || manifest.entries.length > MAX_ENTRIES)
    throw new MarketPageError('MARKET_PAGE_MANIFEST_INVALID');
  const root = await realpath(authorityRoot);
  const generated = marketConfirmScript();
  const entries = [];
  const audit = [];
  const seen = new Set();
  for (const manifestEntry of manifest.entries) {
    const source = manifestEntry?.source;
    if (typeof source !== 'string' || !source.startsWith(MARKET_SOURCE_PREFIX) || seen.has(source))
      throw new MarketPageError('MARKET_PAGE_SOURCE_INVALID');
    seen.add(source);
    if (manifestEntry.transform === GENERATED_TRANSFORM) {
      if (source !== MARKET_GENERATED_PATH
          || manifestEntry.bytes !== generated.length || manifestEntry.sha256 !== sha256(generated))
        throw new MarketPageError('MARKET_PAGE_SOURCE_CHANGED', {source});
      entries.push({source, body: generated, sha256: manifestEntry.sha256, transform: GENERATED_TRANSFORM});
      audit.push({source, rule: GENERATED_TRANSFORM, transform: GENERATED_TRANSFORM,
        sourceBytes: 0, bodyBytes: generated.length, windows: []});
      continue;
    }
    // Containment exactly like community-resources.js: resolve symlinks first and
    // then require the real path to stay inside the authority root and to be the
    // path the manifest pinned.
    let filename;
    try {
      filename = await realpath(path.join(root, source));
    } catch (error) {
      throw new MarketPageError('MARKET_PAGE_SOURCE_MISSING', {source, cause: error?.code});
    }
    const relative = path.relative(root, filename).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative !== source)
      throw new MarketPageError('MARKET_PAGE_SOURCE_OUTSIDE_AUTHORITY', {source});
    const body = await readFile(filename);
    if (body.length > MAX_SOURCE_BYTES)
      throw new MarketPageError('MARKET_PAGE_SOURCE_OVERSIZED', {source, actual: body.length});
    if (body.length !== manifestEntry.bytes)
      throw new MarketPageError('MARKET_PAGE_SOURCE_SIZE_CHANGED', {source, expected: manifestEntry.bytes, actual: body.length});
    if (sha256(body) !== manifestEntry.sha256)
      throw new MarketPageError('MARKET_PAGE_SOURCE_CHANGED', {source});
    const {body: transformed, windows} = transformSource(body, source, options);
    entries.push({source, body: transformed, sha256: sha256(transformed), transform: marketPageTransformOf(source, options)});
    audit.push({source, rule: marketPageTransformOf(source, options), transform: marketPageTransformOf(source, options),
      sourceBytes: body.length, bodyBytes: transformed.length,
      windows: windows.map((window) => [window.start, window.end, window.replace.length, window.rule])});
  }
  if(options?.nativeAvatarPreview){
    const movie=await loadNativeAvatarPreviewMovie(root,options.deploymentEndpoints);
    entries.push(movie);
    audit.push({source:movie.source,rule:'AVATAR-PREVIEW-HTTP',transform:'none',
      sourceBytes:movie.inputBytes,bodyBytes:movie.body.length,inputSha256:movie.inputSha256,
      outputSha256:movie.sha256,changes:movie.changes,windows:[]});
  }
  return new MarketPageResources(entries, audit, options);
}
