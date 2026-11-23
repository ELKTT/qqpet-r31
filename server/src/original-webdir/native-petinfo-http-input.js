import http from 'node:http';
import net from 'node:net';
import {gbkEncode} from '../accounts/account-service.js';

const PATH='/_qqpet/web/fcgi-bin/babyinfo?';
const MAX_LINE=8192;

// PetInfo m16/m22 append names without URI escaping. Normalize only their raw
// non-ASCII bytes before Node's strict HTTP parser; route/auth/state checks still
// run on the resulting request. No names, credentials or request bytes are logged.
export function normalizeNativePetInfoLine(line){
  if(!Buffer.isBuffer(line)||line.length>MAX_LINE)return line;
  const text=line.toString('latin1');
  const match=/^GET (\/_qqpet\/web\/fcgi-bin\/babyinfo\?[^\x00-\x20\x7f#]+) (HTTP\/1\.[01])$/.exec(text);
  if(!match||!/[\x80-\xff]/.test(match[1]))return line;
  const fields=match[1].slice(PATH.length).split('&');
  const command=fields.filter(f=>f.startsWith('cmd='));
  if(command.length!==1||!['cmd=11','cmd=12'].includes(command[0]))return line;
  const nameKey=command[0]==='cmd=11'?'pet_name':'master_name',normalized=[];
  for(const field of fields){
    if(!/[\x80-\xff]/.test(field)){normalized.push(field);continue;}
    const at=field.indexOf('='),key=field.slice(0,at),value=field.slice(at+1);
    if(at<0||key!==nameKey||value.length>256)return line;
    const bytes=Buffer.from(value,'latin1');let decoded;
    try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch{
      try{decoded=new TextDecoder('gbk',{fatal:true}).decode(bytes);if(!gbkEncode(decoded).equals(bytes))return line;}
      catch{return line;}
    }
    normalized.push(key+'='+decoded.replace(/[^\x00-\x7f]/gu,c=>encodeURIComponent(c)));
  }
  return Buffer.from('GET '+PATH+normalized.join('&')+' '+match[2],'ascii');
}

// Own the bounded first-line read and stop all owned sockets on shutdown. Once
// the line is handed over, Node retains its strict header/body parser and limits.
export function createNativePetInfoHttpServer(handler){
  const deadlines=new Map();
  const parser=http.createServer({maxHeaderSize:8192},handler);
  parser.maxHeadersCount=32;parser.requestTimeout=10000;parser.headersTimeout=10000;
  parser.prependListener('request',request=>{clearTimeout(deadlines.get(request.socket));deadlines.delete(request.socket);});
  const sockets=new Set();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    let pending=Buffer.alloc(0);const timer=setTimeout(()=>socket.destroy(),10000);timer.unref();
    deadlines.set(socket,timer);socket.setTimeout(10000,()=>socket.destroy());
    socket.once('close',()=>{clearTimeout(timer);deadlines.delete(socket);});
    const receive=chunk=>{
      pending=Buffer.concat([pending,chunk]);const end=pending.indexOf('\r\n');
      if(end<0||end>MAX_LINE){if(pending.length>MAX_LINE)socket.destroy();return;}
      socket.pause();socket.removeListener('data',receive);
      const line=normalizeNativePetInfoLine(pending.subarray(0,end));
      socket.unshift(Buffer.concat([line,pending.subarray(end)]));pending=Buffer.alloc(0);
      parser.emit('connection',socket);socket.resume();
    };
    socket.on('data',receive);
  });
  // Preserve the HTTP server's request event at the public listener boundary.
  // Runtime diagnostics subscribe here; exposing only the outer net.Server
  // previously hid every HTTP result when this native parser adapter was used.
  parser.prependListener('request',(request,response)=>server.emit('request',request,response));
  const close=server.close.bind(server);
  server.close=callback=>{for(const socket of sockets)socket.destroy();return close(callback);};
  return server;
}
