// The served market pages ask for their product icons through their own authority:
// market.js writes `<img src="/community/care-image/wp/<pic>.gif">` (service copy rule R6)
// and the pages are served from web.pet.qq.com. This alias makes that exact, already
// hash-verified catalogue entry reachable there. It matches one fixed path shape and then
// looks the registered entry up by key: no path join, no directory lookup, no remote
// fetch, and no other path of the catalogue is exposed on this authority.
const CARE_IMAGE_ALIAS = /^\/community\/care-image(\/wp\/[a-f0-9]{64}\.gif)$/;

import {createHash} from 'node:crypto';

// Explicit catalogue resources; never fetch a remote path on demand.
export class CareResources {
  constructor(entries) {
    if(!Array.isArray(entries)||entries.length===0||entries.length>1200)throw new TypeError('INVALID_CARE_RESOURCES');
    this.routes=new Map();
    for(const e of entries) {
      const gif=/^\/wp\/[a-f0-9]{64}\.gif$/.test(e.path),png=/^\/client\/worudy_new\/(study|work)\/[1-9][0-9]{0,9}\.png$/.test(e.path);
      const pngBytes=Buffer.isBuffer(e.body)&&e.body.subarray(0,8).toString('hex')==='89504e470d0a1a0a';
      // A reference icon may be JPEG bytes under a .gif route; the served type follows the
      // bytes, never the name, and the magic is still required.
      const jpegBytes=Buffer.isBuffer(e.body)&&e.body.length>=3&&e.body[0]===0xff&&e.body[1]===0xd8&&e.body[2]===0xff;
      if((!gif&&!png)||this.routes.has(e.path)||!Buffer.isBuffer(e.body)||e.body.length>1024*1024
          ||e.body.length<24||createHash('sha256').update(e.body).digest('hex')!==e.sha256
          ||(gif?!pngBytes&&!jpegBytes&&!['GIF87a','GIF89a'].includes(e.body.subarray(0,6).toString()):!pngBytes))
        throw new TypeError('INVALID_CARE_RESOURCE');
      this.routes.set(e.path,{contentType:pngBytes?'image/png':(jpegBytes?'image/jpeg':'image/gif'),body:Buffer.from(e.body)});
    }
  }
  resolve(authority,target) {
    if(!['x.pet.qq.com','web.pet.qq.com','img.pet.qq.com'].includes(authority))return null;
    if(target==='/crossdomain.xml')return {contentType:'text/x-cross-domain-policy',body:Buffer.from(
      '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" secure="false" /></cross-domain-policy>')};
    let path=null;
    if(authority==='img.pet.qq.com')path=target;
    else if(authority==='web.pet.qq.com') {
      const match=CARE_IMAGE_ALIAS.exec(target);
      path=match?match[1]:null;
    }
    const r=path===null?null:this.routes.get(path);
    return r?{contentType:r.contentType,body:Buffer.from(r.body)}:null;
  }
}
