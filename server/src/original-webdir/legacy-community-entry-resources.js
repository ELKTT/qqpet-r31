// User-authorized replacement for the missing legacy outer page; default off.
// It reads inventory through the existing Root-bound HTML API, never a query identity.
import {readFile} from 'node:fs/promises';
import {MARKET_FRAME_URL} from './market-page-resources.js';

// Keep the virtual authority explicit so BusinessAddresses can map the
// redirect into /_qqpet/web when the native browser uses the loopback origin.
const ITEMS_TARGET=MARKET_FRAME_URL;

const FILES=Object.freeze([
  ['/index5.html','index5.html','text/html; charset=utf-8'],
  ['/legacy-community/items.js','items.js','application/javascript; charset=utf-8'],
  ['/legacy-community/items.css','items.css','text/css; charset=utf-8'],
]);
const ENTRY=/^\/index5\.html(?:\?localtime=[0-9]{1,20}(?:\.[0-9]{1,9})?)?$/;

export function legacyCommunityEntryEnabled(options) {
  const enabled=options.has('--enable-legacy-community-entry-compatibility');
  if(enabled&&!options.has('--enable-html-market-compatibility'))throw new TypeError('LEGACY_ENTRY_REQUIRES_MARKET_SWITCH');
  return enabled;
}

export class LegacyCommunityEntryResources {
  constructor(entries) {
    if(!Array.isArray(entries)||entries.length!==FILES.length)throw new TypeError('INVALID_LEGACY_ENTRY_RESOURCES');
    this.routes=new Map();
    for(const [index,entry] of entries.entries()) {
      const [route,,contentType]=FILES[index];
      if(!entry||entry.path!==route||entry.contentType!==contentType||!Buffer.isBuffer(entry.body)
          ||entry.body.length===0||entry.body.length>128*1024)throw new TypeError('INVALID_LEGACY_ENTRY_RESOURCE');
      this.routes.set(route,{contentType,body:Buffer.from(entry.body)});
    }
  }
  resolve(authority,target) {
    if(authority!=='web.pet.qq.com'||typeof target!=='string'||target.length>256)return null;
    // The missing original outer page now opens the existing common/market
    // warehouse. Its exact same-origin destination never inherits query data.
    // Retain the earlier authored assets for the recorded compatibility archive.
    if(ENTRY.test(target))return {redirect:ITEMS_TARGET};
    const route=target;
    const entry=this.routes.get(route);
    return entry?{contentType:entry.contentType,body:Buffer.from(entry.body)}:null;
  }
}

export async function loadLegacyCommunityEntryResources({enabled=false}={}) {
  if(typeof enabled!=='boolean')throw new TypeError('INVALID_LEGACY_ENTRY_OPTION');
  if(!enabled)return undefined;
  const entries=[];
  for(const [route,name,contentType] of FILES) {
    const body=await readFile(new URL('./legacy-community-assets/'+name,import.meta.url));
    entries.push({path:route,contentType,body});
  }
  return new LegacyCommunityEntryResources(entries);
}
