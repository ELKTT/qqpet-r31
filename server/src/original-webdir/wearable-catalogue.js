import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inspectImage} from './wearable-image.js';

// The wearable registry as the server serves it: the 885 registered 装扮 rows, browsable in the
// shop's own part categories, with a bounded page size. Every entry is registered-not-sellable:
// the original wearable contract (equip, duration, part slots, pink-diamond rules) is not closed
// locally, so nothing here is purchasable or usable, and an entry without real artwork says so
// instead of showing a broken or substitute image.
//
// This module reads only the deployed configuration and its hash-named artwork; it never parses
// a reference workbook and never imports the analysis extractor.
export const WEARABLE_PAGE_SIZE=40;
export const WEARABLE_PARTS=Object.freeze(['头部','身体','脚部','右手','左手','背部','颈部','面部','背景']);
// The verified artwork is kept as bytes, not as a path: what was verified is what is served, so
// replacing a file on disk after its verification cannot reach a response. The bounded cache is
// what keeps a request from re-reading the whole directory; the first read of a hash verifies.
export const WEARABLE_ICON_CACHE_LIMIT=1024;
const ICON_NAME=/^[a-f0-9]{64}$/;

const uint=(value,max)=>Number.isInteger(value)&&value>=0&&value<=max;
const text=(value,max=80)=>typeof value==='string'&&value.length<=max;

export class WearableCatalogueError extends Error {
  constructor(code){super(code);this.name='WearableCatalogueError';this.code=code;}
}

export class WearableCatalogue {
  // sha256 -> {contentType, body} of artwork this catalogue verified itself.
  #iconCache=new Map();
  constructor({document,assetsRoot}={}) {
    if(!document||typeof document!=='object'||document.schemaVersion!==1||!Array.isArray(document.items))
      throw new WearableCatalogueError('INVALID_WEARABLE_DOCUMENT');
    if(typeof assetsRoot!=='string'||assetsRoot.length===0)
      throw new WearableCatalogueError('INVALID_WEARABLE_ASSETS');
    this.assetsRoot=path.resolve(assetsRoot);
    this.items=document.items.map((item)=>{
      if(!item||typeof item!=='object'||!text(item.name,64)||item.name.length===0)
        throw new WearableCatalogueError('INVALID_WEARABLE_ITEM');
      if(!WEARABLE_PARTS.includes(item.part))
        throw new WearableCatalogueError('INVALID_WEARABLE_PART');
      if(item.iconSha256!==null&&!/^[a-f0-9]{64}$/.test(item.iconSha256??''))
        throw new WearableCatalogueError('INVALID_WEARABLE_ICON');
      if(item.iconSha256&&!['image/png','image/gif','image/jpeg'].includes(item.iconContentType))
        throw new WearableCatalogueError('INVALID_WEARABLE_ICON_TYPE');
      if(item.status!=='registered-awaiting-wearable-contract')
        throw new WearableCatalogueError('INVALID_WEARABLE_STATUS');
      return Object.freeze({
        name:item.name,part:item.part,duration:text(item.duration,16)?item.duration:'',
        suit:text(item.suit,64)?item.suit:'',detail:text(item.detail,200)?item.detail:'',
        levelMin:item.levelMin===null?null:(uint(item.levelMin,65535)?item.levelMin:null),
        levelMax:item.levelMax===null?null:(uint(item.levelMax,65535)?item.levelMax:null),
        pinkDiamond:item.pinkDiamond===null?null:(uint(item.pinkDiamond,255)?item.pinkDiamond:null),
        iconSha256:item.iconSha256??null,iconContentType:item.iconContentType??null,
        iconState:item.iconState==='ok'?'ok':'missing',
        status:item.status,
      });
    });
    if(new Set(this.items.map((item)=>item.name)).size!==this.items.length)
      throw new WearableCatalogueError('DUPLICATE_WEARABLE_NAME');
    this.parts=Object.freeze(Object.fromEntries(WEARABLE_PARTS.map((part)=>[part,
      this.items.filter((item)=>item.part===part).length])));
  }
  static load({configFile,assetsRoot}) {
    let document;
    try { document=JSON.parse(readFileSync(configFile,'utf8')); }
    catch (error) { throw new WearableCatalogueError('WEARABLE_CONFIG_UNREADABLE'); }
    return new WearableCatalogue({document,assetsRoot});
  }
  // A bounded page of one part, or of every part when none is named. The page carries the part
  // counts and the not-sellable reason so the page never has to invent either.
  list({part=null,page=1}={}) {
    if(part!==null&&!WEARABLE_PARTS.includes(part))throw new WearableCatalogueError('INVALID_WEARABLE_PART');
    if(!uint(page-1,10000))throw new WearableCatalogueError('INVALID_WEARABLE_PAGE');
    const matching=part===null?this.items.filter((item)=>item.part!==null):this.items.filter((item)=>item.part===part);
    const start=(page-1)*WEARABLE_PAGE_SIZE;
    const slice=matching.slice(start,start+WEARABLE_PAGE_SIZE);
    return Object.freeze({
      part,page,pageSize:WEARABLE_PAGE_SIZE,total:matching.length,
      pageCount:Math.max(1,Math.ceil(matching.length/WEARABLE_PAGE_SIZE)),
      parts:this.parts,
      status:'registered-awaiting-wearable-contract',
      reason:'装扮的原版穿戴系统（装备、时长、部位、粉钻）在本地的发送/响应/状态闭环未接通，因此本分类仅登记展示：不可购买、不可使用。',
      items:Object.freeze(slice.map((item)=>Object.freeze({
        ...item,
        icon:item.iconSha256?`/wearable/${item.iconSha256}.png`:null,
      }))),
    });
  }
  // The artwork bytes, resolved by content hash only: a name is never turned into a path here.
  // The bytes have to be the registered image itself before any of them is served: the file's
  // own SHA-256 must be the hash it is addressed by, and its content must be an image of the
  // registered type — a hash mismatch, a file that is not an image at all and a truncated image
  // are all refused, and a file name that merely looks like a hash cannot turn content into
  // image/png. The verified buffer is what is cached and served next time, so a request never
  // serves bytes that were not verified, and the directory is not re-read per request.
  resolveIcon(sha256) {
    if(typeof sha256!=='string'||!ICON_NAME.test(sha256))return null;
    const item=this.items.find((entry)=>entry.iconSha256===sha256&&entry.iconState==='ok');
    if(!item)return null;
    const verified=this.#verifiedIcon(item,sha256);
    if(verified===null)return null;
    return {contentType:verified.contentType,body:Buffer.from(verified.body)};
  }
  #verifiedIcon(item,sha256) {
    const cached=this.#iconCache.get(sha256);
    if(cached!==undefined)return cached;
    let bytes;
    try { bytes=readFileSync(path.join(this.assetsRoot,`${sha256}.png`)); }
    catch { return null; }
    if(createHash('sha256').update(bytes).digest('hex')!==sha256)return null;
    const inspected=inspectImage(bytes);
    if(inspected.type===null||inspected.type!==item.iconContentType)return null;
    const verified=Object.freeze({contentType:inspected.type,body:bytes});
    if(this.#iconCache.size>=WEARABLE_ICON_CACHE_LIMIT)
      this.#iconCache.delete(this.#iconCache.keys().next().value);
    this.#iconCache.set(sha256,verified);
    return verified;
  }
  get iconCacheSize() {return this.#iconCache.size;}
}
