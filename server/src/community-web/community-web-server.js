import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CommunityDirectory,pendingCommunityDirectory} from './community-directory.js';
import {acceptsCommunityResourceQuery} from './community-resource-query.js';

const PREFIX = '/community/assets/';

// Deliberately independent of the original production service: explicit opt-in only.
export class CommunityWebServer {
  constructor({resources, enabled = false, port = 18089, publicOrigin=null, directory = pendingCommunityDirectory(),session=null,navigation=null,previews=new Map(),care=null,careResources=null,market=null,handoff=null}) {
    if (enabled !== true) throw new TypeError('COMMUNITY_COMPATIBILITY_NOT_ENABLED');
    if (!resources || !Number.isInteger(port) || port < 1024 || port > 65535)
      throw new TypeError('INVALID_COMMUNITY_OPTIONS');
    this.resources = resources;
    if (!(directory instanceof CommunityDirectory)) throw new TypeError('INVALID_COMMUNITY_DIRECTORY');
    this.directory = directory;
    this.session=session;this.handoff=handoff;
    this.navigation=navigation;
    this.previews=previews;
    this.care=care;this.careResources=careResources;
    // The market panel is published only through the shared market service's own
    // readiness: a constructor argument is not evidence that the service is up, so the
    // capability carries the page to load and a read-only ready() asked per state request.
    if(market!==null&&market!==undefined
        &&(typeof market!=='object'||typeof market.ready!=='function'
          ||typeof market.frame!=='string'
          ||!/^http:\/\/web\.pet\.qq\.com\/common\/market\/[A-Za-z0-9_.-]+\.htm\?[!-~]+$/.test(market.frame)
          ||/gen=/i.test(market.frame)))throw new TypeError('INVALID_MARKET_CAPABILITY');
    this.market=market??null;
    this.port = port;
    this.origin=publicOrigin??`http://127.0.0.1:${port}`;
    if(!/^http:\/\/(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$/.test(this.origin))throw new TypeError('INVALID_COMMUNITY_ORIGIN');
    this.authority=new URL(this.origin).host;
    this.counts = {requests:0, rejected:0, missingResources:0};
    this.missing = new Set();
    this.served = new Set();
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async prepare() {
    this.page = await readFile(new URL('../../assets/community-web/clientmain.html', import.meta.url));
    this.bridge = await readFile(new URL('../../assets/community-web/bridge.js', import.meta.url));
    this.apiNames = JSON.parse(await readFile(new URL('../../assets/community-web/api-names.json',import.meta.url),'utf8'));
  }
  async start() {
    await this.prepare();
    await new Promise((resolve,reject) => {
      const failed = err => reject(err);
      this.server.once('error', failed);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', failed);
        resolve();
      });
    });
    return `http://127.0.0.1:${this.port}/clientmain.html`;
  }

  stop() {
    this.care?.close();
    this.handoff?.close();this.session?.close();
    if(!this.server.listening)return Promise.resolve();
    return new Promise((resolve,reject) => this.server.close(err => err ? reject(err) : resolve()));
  }

  handle(req,res) {
    let session=this.handoff?this.handoff.forCookie(req.headers.cookie):this.session;
    this.counts.requests++;
    const reply = (status,type,body) => {
      res.writeHead(status, {'Content-Type':type,'Cache-Control':'no-store',
        'Content-Length':Buffer.byteLength(body),'Connection':'close',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      // Node suppresses HEAD bytes on the wire; adapters still need the representation
      // here to compute the Content-Length after an address transformation.
      res.end(body);
    };
    if (!['GET','HEAD','POST'].includes(req.method) || req.headers.host !== this.authority
        || typeof req.url !== 'string' || req.url.length > 2048 || !req.url.startsWith('/')) {
      this.counts.rejected++;
      return reply(400,'text/plain','REQUEST_REJECTED');
    }
    let url;
    try { url = new URL(req.url, this.origin); }
    catch { return reply(400,'text/plain','REQUEST_REJECTED'); }
    if(req.method==='POST') {
      if((!session && !(this.handoff && ['/community/handoff','/community/launch'].includes(url.pathname))) || !['/community/handoff','/community/launch','/community/enter','/community/path','/community/change-scene','/community/jump-scene','/community/page','/community/care','/community/entry-target'].includes(url.pathname)
          || url.search || req.headers['x-qqpet-community']!=='1'
          || (req.headers.origin && req.headers.origin!==this.origin)
          || !Number.isInteger(Number(req.headers['content-length'])) || Number(req.headers['content-length'])>2048) {
        this.counts.rejected++;return reply(400,'text/plain','REQUEST_REJECTED');
      }
      let size=0,chunks=[],finished=false;
      const fail=()=>{if(finished)return;finished=true;this.counts.rejected++;reply(400,'text/plain','REQUEST_REJECTED');};
      req.setTimeout(5000,fail);req.on('error',fail);
      req.on('data',chunk=>{if(finished)return;size+=chunk.length;if(size>2048)fail();else chunks.push(chunk);});
      req.on('end',()=>{
        if(finished)return;finished=true;
        const body=Buffer.concat(chunks).toString('utf8');chunks=[];
        if(this.handoff)session=this.handoff.forCookie(req.headers.cookie);
        if(url.pathname==='/community/handoff') {
          let value;try{value=JSON.parse(body);}catch{return reply(400,'text/plain','INVALID_HANDOFF');}
          let result;try{result=this.handoff?.request(value);}catch{}
          return reply(result?200:403,'application/json',JSON.stringify(result??{error:'COMMUNITY_OWNER_INACTIVE'}));
        }
        if(url.pathname==='/community/launch') {
          const token=this.handoff?this.handoff.redeem(body):session?.redeem(body);
          if(!token)return reply(403,'text/plain','LOCAL_LAUNCH_EXPIRED');
          res.setHeader('Set-Cookie',`qqpet_community=${token}; Path=/community/; HttpOnly; SameSite=Strict`);
          res.setHeader('Location','/clientmain.html');return reply(303,'text/plain','');
        }
        if(!session)return reply(403,'text/plain','COMMUNITY_OWNER_INACTIVE');
        let choice;try {choice=JSON.parse(body);}catch {return reply(400,'text/plain','INVALID_ENTRY');}
        if(url.pathname==='/community/entry-target') {
          const target=session.entryTarget(req.headers.cookie,choice,this.navigation);
          return reply(target?200:403,'application/json',JSON.stringify(target??{error:'ENTRY_TARGET_UNAVAILABLE'}));
        }
        if(url.pathname==='/community/page') {
          const page=session.openPage(req.headers.cookie,choice,this.navigation);
          return reply(page?200:403,'application/json',JSON.stringify(page??{error:'PAGE_REJECTED'}));
        }
        if(url.pathname==='/community/care') {
          if(!this.care || !session.sceneInfo(req.headers.cookie,this.navigation))return reply(403,'application/json','{"result":1,"msg":"社区业务尚未连接"}');
          try {return reply(200,'application/json',JSON.stringify(this.care.request(choice)));}
          catch {this.counts.careFailure=(this.counts.careFailure??0)+1;return reply(409,'application/json','{"result":1,"msg":"操作未完成，存档未提交，请稍后重试"}');}
        }
        if(url.pathname==='/community/change-scene' || url.pathname==='/community/jump-scene') {
          const scene=session.changeScene(req.headers.cookie,choice,this.navigation,url.pathname==='/community/jump-scene');
          return reply(scene?200:403,'application/json',JSON.stringify(scene??{error:'SCENE_REJECTED'}));
        }
        if(url.pathname==='/community/path') {
          const path=session.findPath(req.headers.cookie,choice,this.navigation);
          return reply(path?200:403,'application/json',JSON.stringify(path?{path}:{error:'PATH_REJECTED'}));
        }
        const entered=session.enter(req.headers.cookie,choice,this.directory);
        if(!entered)return reply(403,'text/plain','ENTRY_REJECTED');
        return reply(200,'application/json',JSON.stringify(entered));
      });
      return;
    }
    if(url.pathname==='/community/market/state.json') {
      const market=this.market;
      if(!market) return reply(200,'application/json',JSON.stringify({enabled:false}));
      // Readiness is asked of the market service itself, so a stopped or unreachable
      // service publishes no entry; the panel then keeps its original placeholder.
      let settled=false;
      const publish=(ready)=>{
        if(settled)return;
        settled=true;
        reply(200,'application/json',JSON.stringify(ready===true?{enabled:true,frame:market.frame}:{enabled:false}));
      };
      try {
        const result=market.ready();
        if(result&&typeof result.then==='function')result.then(publish,()=>publish(false));
        else publish(result);
        return;
      } catch {return publish(false);}
    }
    if(url.pathname==='/community/session.json') {
      const pet=session?.profile(req.headers.cookie);
      return reply(pet?200:401,'application/json',JSON.stringify(pet?{pet}:{error:'LOCAL_LAUNCH_REQUIRED'}));
    }
    if(url.pathname==='/community/scene.json') {
      const scene=session?.sceneInfo(req.headers.cookie,this.navigation);
      return reply(scene?200:403,'application/json',JSON.stringify(scene??{error:'SCENE_UNAVAILABLE'}));
    }
    if (url.pathname === '/clientmain.html' || url.pathname === '/')
      return reply(200,'text/html; charset=utf-8',this.page);
    if (url.pathname === '/community/bridge.js') return reply(200,'text/javascript; charset=utf-8',this.bridge);
    if(url.pathname.startsWith('/community/care-image/')) {
      const r=this.careResources?.resolve('img.pet.qq.com','/'+url.pathname.slice('/community/care-image/'.length));
      return r?reply(200,r.contentType,r.body):reply(404,'text/plain','NOT_FOUND');
    }
    if (url.pathname === '/community/bootstrap.json')
      return reply(200,'application/json',JSON.stringify({main:PREFIX+this.resources.main,
        apiNames:this.apiNames,
        directory:this.directory.snapshot(),
        scenes:Object.fromEntries(Object.entries(this.resources.sceneConfigurations()).map(([kind,entries])=>
          [kind,Object.fromEntries(Object.entries(entries).map(([id,name])=>[id,PREFIX+name]))])),
        configuration:Object.fromEntries(['miniMap','worldMap','navigation'].map(kind=>{
          const preview={miniMap:'generated/mini-map.xml',worldMap:'generated/world-map.xml'}[kind];
          const name=this.previews.has(preview)?preview:this.resources.mapConfiguration(kind);return [kind,name?PREFIX+name:null];
        }))}));
    if (url.pathname === '/community/diagnostics.json')
      return reply(200,'application/json',JSON.stringify({counts:this.counts,missing:[...this.missing],served:[...this.served]}));
    if (url.pathname === '/community/resource') {
      if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has('name'))
        return reply(400,'text/plain','RESOURCE_QUERY_INVALID');
      const requested=url.searchParams.get('name');
      const key = this.previews.has(requested)?requested:this.resources.resolve(requested);
      if (!key) { this.counts.missingResources++;this.recordMissing(url.searchParams.get('name')); }
      return reply(key ? 200 : 404, 'application/json', JSON.stringify({path:key ? PREFIX+key : null}));
    }
    if (url.pathname.startsWith(PREFIX)) {
      if(!acceptsCommunityResourceQuery(url.pathname,url.search)) {
        this.counts.rejected++;return reply(400,'text/plain','RESOURCE_QUERY_INVALID');
      }
      let name;
      try { name = decodeURIComponent(url.pathname.slice(PREFIX.length)); } catch { name = ''; }
      const resource = this.previews.get(name) || this.resources.get(name);
      if (resource) {
        if(this.served.size < 64)this.served.add(this.previews.has(name)?name:this.resources.resolve(name));
        return reply(200, resource.contentType, resource.body);
      }
      this.counts.missingResources++;
    }
    this.recordMissing(url.pathname);
    reply(404,'text/plain','NOT_FOUND');
  }

  recordMissing(name) {
    if (this.missing.size < 64) this.missing.add(createHash('sha256').update(String(name)).digest('hex'));
  }
}
