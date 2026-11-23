import https from 'node:https';
import {X509Certificate,createPrivateKey,createPublicKey,timingSafeEqual} from 'node:crypto';
import {parseDeploymentEndpoints} from './endpoints.js';

const MAX_BODY=4096;
const failure=()=>({ok:false,error:'AUTH_FAILED'});
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const token=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);

// This adapter belongs to the explicit login compatibility assembly. It exposes no
// private control, registration, administrator, database or browser-cookie endpoint.
export function remoteLoginReply(service,request) {
  let passwordBytes,result;
  try {
    if(exact(request,['op'])&&request.op==='ready')return {ready:true};
    if(exact(request,['op','account','passwordHex'])&&request.op==='login') {
      if(typeof request.account!=='string'||request.account.length<1||request.account.length>128||
          typeof request.passwordHex!=='string'||!/^(?:[a-f0-9]{2}){1,128}$/.test(request.passwordHex))return failure();
      passwordBytes=Buffer.from(request.passwordHex,'hex');
      const password=new TextDecoder('utf-8',{fatal:true}).decode(passwordBytes);
      result=service.authenticate({account:request.account,password});
      if(result.petless)return {ok:true,uin:result.uin,petless:true,adoptToken:result.adoptToken};
    } else if(exact(request,['op','adoptToken','gender'])&&request.op==='adopt'&&token(request.adoptToken)&&['male','female'].includes(request.gender)) {
      result=service.adoptViaToken(request.adoptToken,request.gender);
    } else if(exact(request,['op','adoptToken'])&&request.op==='petless-boot'&&token(request.adoptToken)) {
      const boot=service.petlessBoot(request.adoptToken);
      return {ok:true,uin:boot.uin??0,signHex:boot.signHex,generation:boot.generation};
    } else return failure();
    return {ok:true,uin:result.uin,petIdHex:result.petIdBytes.toString('hex'),signHex:result.ticket.toString('hex'),nicknameHex:result.nickname.toString('hex')};
  } catch {return failure();}
  finally {
    passwordBytes?.fill(0);
    result?.ticket?.fill(0);result?.nickname?.fill(0);result?.petIdBytes?.fill(0);
    if(request&&typeof request==='object')for(const key of Object.keys(request))delete request[key];
  }
}

export function validateLoginTls(config,tls) {
  try {
    const certificate=new X509Certificate(tls.cert),key=createPrivateKey(tls.key);
    const a=certificate.publicKey.export({type:'spki',format:'der'}),b=createPublicKey(key).export({type:'spki',format:'der'});
    if(a.length!==b.length||!timingSafeEqual(a,b)||!certificate.checkIP(new URL(config.public.loginOrigin).hostname)||
        Date.parse(certificate.validFrom)>Date.now()||Date.parse(certificate.validTo)<=Date.now())throw new Error();
    return {cert:tls.cert,key:tls.key,minVersion:'TLSv1.2'};
  }catch{throw new Error('INVALID_LOGIN_TLS');}
}

export class RemoteLoginServer {
  #peers=new Map(); #sockets=new Set(); #window=0; #count=0;
  constructor({deploymentEndpoints,tls,service}) {
    this.config=parseDeploymentEndpoints(deploymentEndpoints);
    if(this.config.listen.login.port<1024)throw new Error('LOGIN_PORT_MUST_BE_UNPRIVILEGED');
    this.authority=new URL(this.config.public.loginOrigin).host;
    const options=validateLoginTls(this.config,tls);
    this.server=https.createServer({...options,maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(req,res)=>this.#handle(service,req,res));
    this.server.maxConnections=64;
    this.server.setTimeout(10000,socket=>socket.destroy());
    this.server.on('connection',socket=>{this.#sockets.add(socket);socket.on('close',()=>this.#sockets.delete(socket));});
    this.server.on('tlsClientError',()=>{});
    this.server.on('clientError',(_error,socket)=>socket.destroy());
    this.server.on('checkContinue',(req,res)=>this.#send(res,400,failure()));
  }
  #allow(peer) {
    const now=Date.now();
    if(now-this.#window>=60000){this.#window=now;this.#count=0;this.#peers.clear();}
    const count=this.#peers.get(peer)??0;
    if(count>=12||this.#count>=120||(!this.#peers.has(peer)&&this.#peers.size>=128))return false;
    this.#peers.set(peer,count+1);this.#count++;return true;
  }
  #send(res,status,value) {
    const body=Buffer.from(JSON.stringify(value),'utf8');
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','Connection':'close','X-Content-Type-Options':'nosniff'});
    res.end(body,()=>body.fill(0));
  }
  #handle(service,req,res) {
    const length=req.headers['content-length'];
    if(req.method!=='POST'||req.url!=='/v1/login'||req.headers.host!==this.authority||
        req.headers.origin!==undefined||req.headers.cookie!==undefined||req.headers['transfer-encoding']!==undefined||
        req.headers['content-type']!=='application/json'||typeof length!=='string'||!/^[1-9][0-9]{0,3}$/.test(length)||Number(length)>MAX_BODY) {
      this.#send(res,400,failure());req.resume();return;
    }
    if(!this.#allow(req.socket.remoteAddress)){this.#send(res,429,failure());req.resume();return;}
    const body=Buffer.alloc(Number(length));let offset=0,finished=false;
    const clear=()=>{finished=true;body.fill(0);};
    req.on('aborted',clear);req.on('error',clear);
    req.on('data',chunk=>{
      if(finished)return;
      if(offset+chunk.length>body.length){clear();req.destroy();return;}
      chunk.copy(body,offset);offset+=chunk.length;chunk.fill(0);
    });
    req.on('end',()=>{
      if(finished)return;
      try {
        if(offset!==body.length)throw new Error();
        const request=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
        const reply=remoteLoginReply(service,request);
        this.#send(res,200,reply);
        for(const key of Object.keys(reply))delete reply[key];
      }catch{this.#send(res,400,failure());}
      finally{clear();}
    });
  }
  start() {
    return new Promise((resolve,reject)=>{
      const failed=error=>{this.server.removeListener('listening',ready);reject(error);};
      const ready=()=>{this.server.removeListener('error',failed);resolve();};
      this.server.once('error',failed);this.server.once('listening',ready);
      this.server.listen(this.config.listen.login.port,this.config.listen.login.ipv4);
    });
  }
  async stop() {
    for(const socket of this.#sockets)socket.destroy();
    if(this.server.listening)await new Promise(resolve=>this.server.close(resolve));
    this.#peers.clear();
  }
}
