// The original HTML market contract (NEW-QQPet/QQPenguin/common/market).
//
// Kept separate from the Flash care contract in care-http.js on purpose: the
// locked pages send no PET_UIN/PET_ID/PET_SIGN/time at all, expect string
// envelopes (`result:'0'`), use 8 items per page for the shop and 6 for the
// store, and serialise their cart as seven colon-separated fields per line. No
// branch here may widen the Flash parser or the store Flash route.
import {parseWardrobeSave} from './wardrobe-market.js';
const MAX_TARGET=4096;
// Page sizes come from the locked pages: shop.htm rebuilds links from an 8-item
// page, store.htm from a 6-item page (market.js PageManager uses the same size).
export const PAGE_SIZE=Object.freeze({shop:8,store:6});
export const CART_KINDS=32;      // cart.js limit_kind
export const CART_QUANTITY=99;   // cart.js limit_num
export const ORDER_CODES=Object.freeze({balance:-1101,qd:-1102,qb:-1103,qb2:-1104,qd2:-1105});

export class MarketHtmlError extends Error {
  constructor(code,message){super(message);this.name='MarketHtmlError';this.code=code;}
}

const uint=(s,max)=>/^(?:0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=BigInt(max);
const positive=(s,max)=>/^[1-9][0-9]*$/.test(s)&&BigInt(s)<=BigInt(max);

// Bounds come from shop.htm/store.htm's original aPics/aSubPics arrays. The two
// columns use different indices (shop dress=2, store dress=0; function=3/2).
export const MENU_KIND=1;
export const MENU_SUBKINDS=Object.freeze([0,1,2]);
export const MARKET_MENU_BOUNDS=Object.freeze({shop:Object.freeze([4,2,8,0,0]),store:Object.freeze([9,2,2,0])});
export function marketEconomySubkind(operation,kind,subkind) {
  if(kind===MENU_KIND&&MENU_SUBKINDS.includes(subkind))return subkind;
  if(subkind===0&&((operation==='shop'&&kind===3)||(operation==='store'&&kind===2)))return 2;
  return null;
}
function menuCategory(operation,kind,subkind) {
  if(!uint(kind,0xffffffff)||!uint(subkind,0xffffffff))
    throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list query is invalid');
  const bounds=MARKET_MENU_BOUNDS[operation];
  if(!bounds||Number(kind)>=bounds.length||Number(subkind)>bounds[Number(kind)])
    throw new MarketHtmlError('MARKET_HTML_LIST_UNSUPPORTED','this catalogue category is not served here');
  return {kind:Number(kind),subkind:Number(subkind)};
}

// The HTML pages request web.pet.qq.com/fcgi-bin/market synchronously (call.js).
// Identity is deliberately not part of this parser: the caller must establish the
// authenticated pet and the active Root before any write operation runs.
export function parseMarketHtmlRequest(authority,target,{wardrobeEnabled=false}={}) {
  if(authority!=='web.pet.qq.com'||typeof target!=='string'||target.length>MAX_TARGET
      ||!/^\/fcgi-bin\/market\?[^#\s]*$/.test(target))throw new MarketHtmlError('MARKET_HTML_ROUTE_INVALID','the market HTML route is invalid');
  const q=new URL(target,'http://'+authority).searchParams;
  // The locked pages rebuild their page links with ajax=1 already present and then
  // append ajax=1 again, so only that one proven same-value duplicate is tolerated.
  // A conflicting value, or a duplicate of any other key, stays rejected; unknown
  // keys are ignored and no identity is ever read from the query.
  for(const key of new Set(q.keys())) {
    const values=q.getAll(key);
    if(values.length>1&&!(key==='ajax'&&values.every(v=>v==='1')))
      throw new MarketHtmlError('MARKET_HTML_QUERY_DUPLICATE','a query key is repeated');
  }
  const cmd=q.get('cmd');
  if(cmd==='save'&&wardrobeEnabled)return parseWardrobeSave(q);
  if(cmd==='frame') {
    // Compat initialization for the market frame page. The locked frame.htm issues
    // `syn_call(base + window.location.search + "&ajax=1")`, so a served page copy builds
    // the same request from an explicit business whitelist (rule R13) instead of
    // forwarding the panel's own control parameters: the host's generation counter stays a
    // panel control value and never reaches the API.
    for(const key of q.keys())if(!['cmd','ajax','panel','kind','subkind','page'].includes(key))
      throw new MarketHtmlError('MARKET_HTML_QUERY_INVALID','an unknown query key is not accepted here');
    if(q.get('ajax')!=='1')throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list query is invalid');
    const panel=q.has('panel')?q.get('panel'):'store';
    if(panel!=='store'&&panel!=='shop')throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the panel value is invalid');
    const kind=q.has('kind')?q.get('kind'):'1',subkind=q.has('subkind')?q.get('subkind'):'0',page=q.has('page')?q.get('page'):'1';
    const category=menuCategory(panel,kind,subkind);
    if(!positive(page,0xffffffff))throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list query is invalid');
    return Object.freeze({operation:'frame',panel,kind:category.kind,subkind:category.subkind,page:Number(page)});
  }
  if(cmd==='shop'||cmd==='store') {
    // The sender's own key is `spec` (shop.htm:420 rebuilds the link as `...&spec=<value>`);
    // the store page never sends it, so the whitelist is per command.
    const allowed=['cmd','ajax','kind','subkind','page',...(cmd==='shop'?['spec']:[])];
    for(const key of q.keys())if(!allowed.includes(key))
      throw new MarketHtmlError('MARKET_HTML_QUERY_INVALID','an unknown query key is not accepted here');
    if(q.get('ajax')!=='1')throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list query is invalid');
    const category=menuCategory(cmd,q.get('kind'),q.has('subkind')?q.get('subkind'):'0');
    const page=q.has('page')?q.get('page'):'1';
    if(!positive(page,0xffffffff))throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list query is invalid');
    // Only the two values the locked branch distinguishes are accepted; the default is the
    // one the locked empty envelope shows. Which items either value selects is not backed by
    // any catalogue field yet, so the item set is not filtered here.
    const spec=q.has('spec')?q.get('spec'):null;
    if(spec!==null&&spec!=='102'&&spec!=='103')
      throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the spec value is invalid');
    return Object.freeze({operation:cmd,pageSize:PAGE_SIZE[cmd],kind:category.kind,subkind:category.subkind,
      page:Number(page),spec:spec===null?null:spec});
  }
  if(cmd==='pay') {
    for(const key of q.keys())if(!['cmd','items','pay','type'].includes(key))
      throw new MarketHtmlError('MARKET_HTML_QUERY_INVALID','an unknown query key is not accepted here');
    // Only the local yuanbao wallet is executable; Q-point and Q-coin payment
    // keep the client's own failure pages instead of being converted.
    if(q.get('pay')!=='yb')throw new MarketHtmlError('MARKET_HTML_PAY_UNSUPPORTED','only yuanbao payment is supported');
    const lines=parseMarketHtmlItems(q.get('items'));
    return Object.freeze({operation:'cart',lines});
  }
  if(cmd==='use') {
    if(!positive(q.get('id'),0x7fffffff))throw new MarketHtmlError('MARKET_HTML_ITEM_INVALID','the item id is invalid');
    for(const key of q.keys())if(!['cmd','id','kind','subkind','page','flush'].includes(key))
      throw new MarketHtmlError('MARKET_HTML_QUERY_INVALID','an unknown query key is not accepted here');
    const flush=q.has('flush')?q.get('flush'):null;
    if(flush!==null&&flush!=='no'&&flush!=='yes')
      throw new MarketHtmlError('MARKET_HTML_QUERY_INVALID','the flush value is invalid');
    const hasContext=q.has('kind')||q.has('subkind')||q.has('page');
    if(hasContext) {
      // store.htm: use inside a list page, then refresh that list.
      const kind=q.get('kind'),subkind=q.get('subkind'),page=q.get('page');
      if(!uint(kind,0xffffffff)||!uint(subkind,0xffffffff)||!positive(page,0xffffffff))
        throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','the list context is incomplete');
      const category=menuCategory('store',kind,subkind);
      if(marketEconomySubkind('store',category.kind,category.subkind)===null)
        throw new MarketHtmlError('MARKET_HTML_LIST_UNSUPPORTED','this category has no usable inventory');
      return Object.freeze({operation:'use',context:'list',gid:Number(q.get('id')),kind:category.kind,subkind:category.subkind,
        page:Number(page),flush});
    }
    // feed.htm: the immediate-use prompt asks with flush=no and no list context at all.
    if(flush!=='no')throw new MarketHtmlError('MARKET_HTML_LIST_INVALID','a list context or flush=no is required');
    return Object.freeze({operation:'use',context:'prompt',gid:Number(q.get('id')),kind:null,subkind:null,page:null,flush});
  }
  throw new MarketHtmlError('MARKET_HTML_ROUTE_INVALID','the market command is not implemented');
}

// items is either the quick-buy pair `cid:count` (quicklybuy.html) or the cart's
// `id:num:price:price_vip:type:name:sell_pay` lines joined by `|` (cart.js
// ShopItem). Only the identity and the count are taken from the client; the
// display price, type and name are ignored and the catalogue decides the rest.
export function parseMarketHtmlItems(value) {
  if(typeof value!=='string'||value.length===0||value.length>4096)
    throw new MarketHtmlError('MARKET_HTML_ITEMS_INVALID','the item list is invalid');
  const lines=value.split('|');
  if(lines.length>CART_KINDS)throw new MarketHtmlError('MARKET_HTML_ITEMS_INVALID','the cart holds too many kinds');
  const items=[];
  for(const line of lines) {
    const fields=line.split(':');
    if(fields.length!==2&&fields.length!==7)
      throw new MarketHtmlError('MARKET_HTML_ITEMS_INVALID','an item line has the wrong field count');
    const [cid,count]=fields;
    if(!positive(cid,0x7fffffff)||!positive(count,CART_QUANTITY))
      throw new MarketHtmlError('MARKET_HTML_ITEMS_INVALID','an item line is out of range');
    // The seven-field form must still be well formed, including its name field.
    if(fields.length===7&&(!uint(fields[2],0x7fffffff)||!uint(fields[3],0x7fffffff)||!uint(fields[4],0xffffffff)
        ||fields[5].length>64||fields[6]!=='yb'))
      throw new MarketHtmlError('MARKET_HTML_ITEMS_INVALID','an item line is malformed');
    items.push(Object.freeze({cid:Number(cid),count:Number(count)}));
  }
  return Object.freeze(items);
}

// The page escapes nothing itself, so server-side text is escaped before it can
// enter the original HTML/JS (market.js parses the payload with eval).
export function escapeMarketHtmlText(value) {
  return String(value).replace(/[\\'"<>&\r\n]/gu,(c)=>({'\\':'\\\\',"'":'\\u0027','"':'\\u0022','<':'\\u003c','>':'\\u003e','&':'\\u0026','\r':'\\r','\n':'\\n'}[c]));
}

const asText=(value)=>String(value);
const userBlock=(user)=>({uin:asText(user?.uin??'0'),spec:asText(user?.spec??'102'),vip:asText(user?.vip??'0'),level:asText(user?.level??'0')});

const countText=(value)=>String(Number.parseInt(String(value??''),10)||0);
const scalar=(value)=>{const parsed=Number.parseInt(String(value??''),10);return Number.isSafeInteger(parsed)?parsed:0;};

// Design 3.2: the HTML pages read a product the Flash care contract never needed. The
// catalogue and inventory views stop at `cid/name/desc/pic/effects/price`; the pages
// additionally branch on `struct`, index the icon with `kind`, size the cart line with
// `ckind` and pick the 食品/清洁 tab with `subkind`. All of it is derived here from the
// list context instead of being pushed into the shared Flash domain output.
//
// Text is escaped for the locked consumer: market.js parses the payload with own eval,
// so a name that carries a quote, a backslash or a `<` would otherwise end the literal.
export function projectMarketHtmlItem(item,subkind) {
  const source=item&&typeof item==='object'?item:{};
  // The three served sub-pages keep their own page-side identity: kind drives the menu
  // highlight and ckind the icon column, so the third one is never rendered as 食品.
  const sub=MENU_SUBKINDS.includes(Number(subkind))?Number(subkind):0;
  const text=(value)=>escapeMarketHtmlText(value===undefined||value===null?'':String(value));
  return Object.freeze({
    cid:text(source.cid),gid:text(source.gid??'0'),name:text(source.name),desc:text(source.desc),
    info:text(source.info??source.desc),
    level_min:scalar(source.level_min),level_max:scalar(source.level_max),
    charm:scalar(source.charm),intel:scalar(source.intel),strong:scalar(source.strong),
    clean:scalar(source.clean),starve:scalar(source.starve),mood:scalar(source.mood),
    // shop.htm treats every value except 0/3 as a badge filename. Local rows have
    // no promotion flag; an omitted value becomes hot_undefined.gif in that consumer.
    pic:text(source.pic),pic_flag:0,num:countText(source.num??'0'),
    price:text(source.price??'0'),price_vip:text(source.price_vip??source.price??'0'),
    sell_pay:text(source.sell_pay??'yb'),sell_vip:scalar(source.sell_vip),
    usable:source.usable===false?'0':'1',
    // The locked pages test `spec!="100"` before they warn about a species mismatch
    // (market.js SpeciesWrong, store.htm's use button, frame.js's try-on): an absent field
    // is not "no restriction" to them, it compares unequal to every value and to `100`
    // alike. The local food/clean catalogue carries no species field at all, so the
    // adapter states the unrestricted value explicitly; a catalogue that does carry one
    // keeps its own value.
    spec:text(source.spec??'100'),
    struct:'FeedConf',kind:asText(sub+1),ckind:sub===0?11:sub===1?12:13,subkind:sub,
  });
}

// The list envelope the locked pages expect. Every scalar is a string: the empty
// page in shop.htm/store.htm uses `result:'0'`, `total:'0'`, `start:'0'`, and
// market.js uses start/total arithmetically with the page size above.
export function projectMarketHtmlList({operation,kind,subkind,itemSubkind=subkind,page,items,total,user,yb,spec,projectItem=projectMarketHtmlItem}) {
  const size=PAGE_SIZE[operation];
  if(!size)throw new MarketHtmlError('MARKET_HTML_ROUTE_INVALID','the list operation is invalid');
  const list=(Array.isArray(items)?items:[]).map((item)=>projectItem(item,itemSubkind));
  // market.js PageManager computes `this.start + items.length - 1` and `Math.ceil(total/size)`,
  // so start and total must be numbers: a string start would concatenate ('8'+8-1 === 87) and the
  // next page would render empty items without navigating. result stays the string '0'.
  const start=(page-1)*size;
  const data={param:{kind:asText(kind??0),subkind:asText(subkind??0),page:asText(page)},user:userBlock(user),
    total:Number.isSafeInteger(total)?total:0,start,items:list};
  if(operation==='shop')data.param.filter=asText(spec??'102');   // the locked default
  else data.yb=asText(yb??0);
  return {result:'0',data};
}

// A rejected write keeps the client's own failure page: -1101 opens fail_yb.htm
// and the Q-point/Q-coin codes keep their pages. The message is a local business
// message, never a rewritten "insufficient balance" claim.
export function projectMarketHtmlFailure(code,msg) {
  return {result:Number(code),ret:1,msg:typeof msg==='string'&&msg.length>0&&msg.length<=64?msg:'操作失败'};
}

const decimalText=(value)=>/^(?:0|[1-9][0-9]*)$/u.test(String(value??''));

export function projectMarketHtmlSuccess({code=0,msg,yb,total,purchased,refreshRequired=false}) {
  const data={};
  if(Number.isSafeInteger(yb))data.yb=asText(yb);
  if(Number.isSafeInteger(total))data.total=asText(total);
  if(typeof msg==='string'&&msg.length>0&&msg.length<=64)data.msg=msg;
  if(refreshRequired)data.refreshRequired=true;
  // Local extension, not an original contract field: after a committed purchase the
  // service copy needs the persisted inventory gid to offer "use immediately" on the
  // real row instead of the gid='0' the store page carries before the buy.
  if(Array.isArray(purchased)&&purchased.length>0&&purchased.length<=CART_KINDS
      &&purchased.every((row)=>row&&decimalText(row.cid)&&decimalText(row.gid)&&decimalText(row.num)))
    data.purchased=purchased.map((row)=>({cid:asText(row.cid),gid:asText(row.gid),num:asText(row.num)}));
  return {result:code,ret:0,data};
}

// The market frame page's compat initialization. frame.htm only needs the two iframe
// parameters plus the wallet and the user block; its own two columns then fetch their
// lists with cmd=shop / cmd=store. `cart` is the page's "open the cart immediately"
// flag and stays '0' here: the panel is opened by an explicit user action.
export function projectMarketHtmlFrame({panel='store',kind=1,subkind=0,page=1,uin,yb,level,spec='102',vip='0',avatar=[]}) {
  const one={kind:asText(kind),subkind:asText(subkind),page:asText(page)};
  const other=kind===1?one:{kind:'1',subkind:'0',page:'1'};
  return {result:'0',data:{cart:'0',shop:{...(panel==='shop'?one:other)},store:{...(panel==='store'?one:other)},yb:asText(yb??0),avatar,shows:[],
    user:{uin:asText(uin??'0'),spec:asText(spec),vip:asText(vip),level:asText(level??'0')},panel}};
}
