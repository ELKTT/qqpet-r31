import http from 'node:http';
import {once} from 'node:events';
import {parseDeploymentEndpoints} from './endpoints.js';
import {BusinessAddresses} from './business-addresses.js';

// Original WinINet reporters and Download configurations use a separate, fixed port 80.
// This remote-only listener serves catalogued resource bytes and discards report requests.
// It never records headers/targets, interprets identities or forwards to an upstream.
export class LegacyHttpServer {
  constructor({configuration,resources=null,careResources=null,testPort}={}) {
    const config=parseDeploymentEndpoints(configuration);
    if(config.mode!=='remote')throw Error('LEGACY_HTTP_REQUIRES_REMOTE');
    this.host=config.listen.web.ipv4;this.port=testPort??80;
    if(testPort!==undefined&&(this.host!=='127.0.0.1'||!Number.isInteger(testPort)||testPort<1024||testPort>65535))throw Error('LEGACY_HTTP_TEST_BINDING_INVALID');
    if(this.port===config.listen.web.port)throw Error('LEGACY_HTTP_PORT_COLLISION');
    this.authority=new URL(config.public.webOrigin).hostname;
    this.addresses=new BusinessAddresses(config);
    this.resources=resources;this.careResources=careResources;
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.server.requestTimeout=5000;this.server.headersTimeout=5000;this.server.maxRequestsPerSocket=1;
    this.server.on('clientError',(_error,socket)=>socket.destroy());
  }
  handle(req,res) {
    const reply=(status,type,body=Buffer.alloc(0))=>{req.resume();res.writeHead(status,{'Content-Type':type,'Content-Length':body.length,
      'Cache-Control':'no-store',Connection:'close'});res.end(body);};
    if(![this.authority,this.authority+':80'].includes(req.headers.host)||req.method!=='GET'
      ||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0
      ||typeof req.url!=='string'||req.url.length>2048||!req.url.startsWith('/')||/[\\#\x00-\x20]/.test(req.url))return reply(400,'text/plain');
    if(/^\/reportmsg(?:\?|$)/.test(req.url))return reply(204,'text/plain');
    // Only the catalog can decide whether a requested path exists. No filesystem lookup.
    if(!req.url.includes('?')&&!/%(?:2f|5c|2e|25|00)/i.test(req.url)) {
      const prefix='/common/petsoc/';
      const file=req.url.startsWith(prefix)?this.resources?.get(req.url.slice(prefix.length)):
        this.careResources?.resolve('img.pet.qq.com',req.url);
      if(file)return reply(200,file.contentType,this.addresses.rewrite(file.body,file.contentType,'resource.pet.qq.com'));
    }
    return reply(404,'text/plain');
  }
  async start(){this.server.listen(this.port,this.host);await once(this.server,'listening');}
  async stop(){if(this.server.listening){this.server.closeIdleConnections();await new Promise((resolve,reject)=>this.server.close(e=>e?reject(e):resolve()));}}
}
