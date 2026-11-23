import {parseDeploymentEndpoints} from './endpoints.js';
import {parsePetShowRequest} from '../protocol/petshow-http.js';

// Old authority is a protocol discriminator, never an upstream to fetch. These paths
// dispatch only to the application's existing handlers on the same process.
export const BUSINESS_AUTHORITIES=Object.freeze({web:'web.pet.qq.com',x:'x.pet.qq.com',
  pet:'pet.qq.com',img:'img.pet.qq.com',act:'act.pet.qq.com',client:'client.pet.qq.com',
  resource:'resource.pet.qq.com',qqlogin:'ptlogin2.qq.com',pay:'pay.qq.com',
  forum:'pet.gamebbs.qq.com',id:'id.qq.com',aq:'aq.qq.com',feed:'feed.pet.qq.com',report:'report.pet.qq.com',
  face:'qqface.pet.qq.com',voice:'voice.qq.com',coins:'168.qq.com',show:'show.pet.qq.com',portal:'portal.pet.qq.com',blog:'t.qq.com',
  gw:'gw.pet.qq.com',flashdownload:'download.macromedia.com',flashsite:'www.macromedia.com'});
const PREFIX='/_qqpet/';
const escaped=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export class BusinessAddresses {
  constructor(configuration,{allowLoopback=false}={}){
    const config=parseDeploymentEndpoints(configuration);
    if(config.mode!=='remote'&&!(allowLoopback&&config.mode==='local'))throw new TypeError('REMOTE_BUSINESS_MODE_REQUIRED');
    this.origin=new URL(config.public.webOrigin).origin;
    this.authority=new URL(config.public.webOrigin).host;
    this.communityOrigin=new URL(config.internal.communityOrigin).origin;
  }
  base(host){
    const entry=Object.entries(BUSINESS_AUTHORITIES).find(([,value])=>value===host);
    if(!entry)throw new TypeError('BUSINESS_AUTHORITY_UNKNOWN');
    return this.origin+PREFIX+entry[0];
  }
  resolve(target){
    if(typeof target!=='string'||target.length>8192||/[\x00-\x20\\#]/.test(target))return null;
    if(target==='/crossdomain.xml')return {authority:'img.pet.qq.com',target};
    if(/^\/gameplay\/(?:vip|care|hospital|home)(?:\?[^#]*)?$/.test(target))
      return {authority:'web.pet.qq.com',target,redirect:this.base('web.pet.qq.com')+target};
    const short=/^\/(task|notice|gifts)(\?[^#]*)?$/.exec(target);
    if(short){
      if(target==='/task?src=2')return {authority:'web.pet.qq.com',target:'/gameplay/notifications',redirect:this.base('web.pet.qq.com')+'/gameplay/notifications'};
      const entries={task:['act.pet.qq.com','/newsub/desktop_task.html'],notice:['act.pet.qq.com','/newsub/desktop_gifts.html'],gifts:['act.pet.qq.com','/newsub/desktop_gifts.html']};
      const [authority,pathname]=entries[short[1]];let suffix=short[2]??'';
      if(short[1]==='notice'){
        const query=new URLSearchParams(suffix.slice(1));
        if([...query.keys()].some(k=>!['v','rt'].includes(k)||query.getAll(k).length!==1)
          ||[...query.values()].some(v=>!/^[-A-Za-z0-9_.]{0,64}$/.test(v)))return null;
        // The native menu still supplies the old sign-page version argument.
        query.delete('v');suffix=query.size?'?'+query.toString():'';
      }
      return {authority,target:pathname+suffix,redirect:this.base(authority)+pathname+suffix};
    }
    if(!target.startsWith(PREFIX))return null;
    const match=/^\/_qqpet\/([a-z]+)(\/[^?]*)(\?.*)?$/.exec(target);
    if(!match||!Object.hasOwn(BUSINESS_AUTHORITIES,match[1]))return null;
    if(!match||/%(?:2f|5c|2e|00|25)/i.test(match[2])||match[2].split('/').some(x=>x==='.'||x==='..')||match[2].startsWith('//'))return null;
    const path=match[2];
    // Management and authentication-control paths are never part of the business namespace.
    if(/^\/(?:admin|v1|login|register|tuoq|community\/handoff)(?:\/|$)/.test(path))return null;
    return {authority:BUSINESS_AUTHORITIES[match[1]],target:path+(match[3]??''),prefix:PREFIX+match[1]};
  }
  accepts(request){
    if(request.headers.origin!==undefined&&request.headers.origin!==this.origin)return false;
    if(request.headers['sec-fetch-site']==='cross-site')return false;
    let sameOrigin=false;
    if(request.headers.referer!==undefined){
      try{const ref=new URL(request.headers.referer);if(ref.origin!==this.origin||ref.username||ref.password)return false;sameOrigin=true;}catch{return false;}
    }
    // Native query-authenticated requests already carry a non-ambient secret. Cookie-only
    // browser actions must demonstrate same-origin dispatch, including old JSONP callers.
    const url=new URL(request.url,this.origin);
    // FeedLogic opens this public HTML shell from the tray through PET://$SUB$.
    // It has no browser Origin/Referer on that first navigation. State and saves
    // remain separate Root-bound /gameplay/api requests with normal origin checks.
    const nativeCarePage=request.method==='GET'&&url.pathname===PREFIX+'web/fcgi-bin/numen'
      &&url.searchParams.getAll('cmd').length===1&&url.searchParams.get('cmd')==='2';
    const nativeHomePage=request.method==='GET'&&url.pathname===PREFIX+'web/cgi-bin/homestead_shop'
      &&url.searchParams.getAll('cmd').length===1&&['0','1'].includes(url.searchParams.get('cmd'));
    // NpcList's treatment action is a public page navigation, without Referer.
    // Diagnosis and purchases still use the separate authenticated gameplay API.
    const nativeHospitalPage=request.method==='GET'&&url.pathname===PREFIX+'web/fcgi-bin/hospital'
      &&url.searchParams.getAll('cmd').length===1&&url.searchParams.get('cmd')==='1';
    const nativeMedicineBox=request.method==='GET'&&url.pathname===PREFIX+'web/gameplay/medicine-box'&&url.search==='';
    const nativeNoticePage=request.method==='GET'&&url.pathname===PREFIX+'web/gameplay/notifications'&&url.search==='';
    const nativeGameList=request.method==='GET'&&url.pathname===PREFIX+'x/petclient'
      &&url.searchParams.getAll('cmd').length===1&&url.searchParams.get('cmd')==='GetGames';
    const api=!nativeCarePage&&!nativeHomePage&&!nativeHospitalPage&&!nativeMedicineBox&&!nativeNoticePage&&!nativeGameList&&url.pathname.startsWith(PREFIX)&&!/\.(?:html?|js|css|xml|json|swf|png|gif|jpe?g|ico|htc|zip)$/i.test(url.pathname);
    const cookieSign=/(?:^|;\s*)PET_SIGN=([a-f0-9]{64})(?:;|$)/i.exec(request.headers.cookie??'');
    // PetInfo.swf uses the original lowercase petsign query field for cmd=10/11/12.
    // It has no browser Origin/Referer. Recognize that field only on its exact route;
    // the existing handler still verifies the ticket's bound Root and pet ownership.
    const nativePetInfo=url.pathname===PREFIX+'web/fcgi-bin/babyinfo'
      &&['10','11','12'].includes(url.searchParams.get('cmd'));
    const nativeFriend=request.method==='GET'&&url.pathname===PREFIX+'feed/fcgi-bin/desktopfeed'
      &&['1','2','3','5','6','7','8','10'].includes(url.searchParams.get('cmd'));
    // SendMsg carries its non-ambient petsign in a bounded POST body. The exact
    // friend handler verifies that sign against the live Root before reading or
    // writing anything. It does not authenticate this action using the Cookie.
    const nativeFriendMessage=request.method==='POST'&&url.pathname===PREFIX+'feed/fcgi-bin/desktopfeed'&&url.search==='';
    const nativeRelive=['GET','POST'].includes(request.method)&&url.pathname===PREFIX+'web/fcgi-bin/revival'
      &&/^[a-f0-9]{64}$/i.test(url.searchParams.get('PET_SIGN')??'');
    const querySecret=Boolean(cookieSign)&&[...url.searchParams].some(([k,v])=>
      (/^(?:PET_SIGN|sign)$/i.test(k)||((nativePetInfo||nativeFriend)&&k==='petsign'))&&v.toLowerCase()===cookieSign[1].toLowerCase());
    // PetDecoration's original GET has petid/level and no sign or browser headers.
    // Its handler only exposes basic artwork for an already-bound live pet. Validate
    // the exact read shape; it cannot authorize a rename or another Cookie-only API.
    let portraitRead=false;
    if(request.method==='GET'&&url.pathname===PREFIX+'web/fcgi-bin/petshow'){
      try{parsePetShowRequest('web.pet.qq.com',url.pathname.slice((PREFIX+'web').length)+url.search);portraitRead=true;}catch{}
    }
    return !api||portraitRead||nativeFriendMessage||nativeRelive||!/(?:^|;\s*)PET_SIGN=/.test(request.headers.cookie??'')||querySecret||sameOrigin
      ||request.headers.origin===this.origin||request.headers['x-qqpet-request']==='business';
  }
  rewrite(body,contentType,host){
    if(!Buffer.isBuffer(body))body=Buffer.from(body??'');
    if(!/(?:text\/|javascript|json|xml)/i.test(contentType??''))return body;
    // Latin-1 is a byte-preserving carrier: existing GB2312 resource bytes are untouched.
    let text=body.toString('latin1');
    // Generated market control messages target this application's community page.
    // Keep the exact configured old origin boundary, not a blanket localhost rewrite.
    text=text.replace(new RegExp(escaped(this.communityOrigin)+'(?=[/"\'\\s<]|$)','g'),this.origin);
    for(const authority of Object.values(BUSINESS_AUTHORITIES)){
      const base=this.base(authority);
      text=text.replace(new RegExp('https?://'+escaped(authority)+'(?=/)','g'),base);
      text=text.replace(new RegExp('https?://'+escaped(authority)+'(?=["\'\\s<]|$)','g'),this.origin);
    }
    text=text.replace(/document\.domain\s*=\s*(['"])qq\.com\1\s*;?/g,'');
    // Keep the HTML rendering-mode declaration. Removing it makes the native browser
    // use quirks box sizing and breaks the original fixed task-page geometry. The short
    // declaration retains standards mode without an external DTD dependency.
    text=text.replace(/<!DOCTYPE\b[^>]*>/gi,declaration=>
      /^<!DOCTYPE\s+html\b/i.test(declaration)?'<!DOCTYPE html>':'');
    // Root-relative generated URLs retain their virtual authority; ordinary relative paths
    // naturally stay within the public namespace. Never rewrite protocol-relative URLs.
    const prefix=new URL(this.base(host)).pathname;
    text=text.replace(/(["'])\/(?!\/|_qqpet\/)(?=(?:fcgi-bin|legacy-community|common|toolbar|newsub|static|client|wp|wearable|wearables|petinfo-image|community\/care-image)(?:\/|[?"']))/g,'$1'+prefix+'/');
    return Buffer.from(text,'latin1');
  }
  wrapResponse(response,host){
    const head=response.writeHead.bind(response),end=response.end.bind(response);
    let pending=null;
    response.writeHead=(status,headers)=>{pending={status,headers:{...headers}};return response;};
    response.end=(body)=>{
      if(pending){
        const type=pending.headers['Content-Type']??pending.headers['content-type']??'';
        const transformed=this.rewrite(body,type,host);
        const location=pending.headers.Location??pending.headers.location??response.getHeader?.('Location');
        if(location!==undefined){
          const target=this.location(location,host);
          response.removeHeader?.('Location');delete pending.headers.Location;delete pending.headers.location;
          if(target===null){head(502,{'Content-Length':0,Connection:'close'});return end();}
          pending.headers.Location=target;
        }
        delete pending.headers['content-length'];pending.headers['Content-Length']=transformed.length;
        pending.headers['Referrer-Policy']='same-origin';
        head(pending.status,pending.headers);return end(transformed);
      }
      return end(body);
    };
  }
  location(value,host){
    if(typeof value!=='string'||/[\x00-\x20\\]/.test(value))return null;
    try{
      const url=new URL(value,this.base(host)+'/');
      if(url.username||url.password||!['http:','https:'].includes(url.protocol))return null;
      if(url.origin===this.origin)return url.href;
      if(!Object.values(BUSINESS_AUTHORITIES).includes(url.hostname)||url.port)return null;
      return this.base(url.hostname)+url.pathname+url.search+url.hash;
    }catch{return null;}
  }
}
