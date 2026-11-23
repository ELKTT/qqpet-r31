import {appendFileSync,existsSync,lstatSync,mkdirSync,readFileSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const DEFAULT_RUNTIME_LOG=Object.freeze({enabled:true,level:'debug',maxFileBytes:5*1024*1024,maxFiles:5});
const events=new Set(['server.starting','server.ready','server.stopped','server.failed','logging.changed','logging.invalid',
  'game.connected','game.command','game.community','game.state','game.closed','game.transport_error','http.request','directory.activity','server.counters']);
const stringValues={service:new Set(['game','web','login','admin','directory']),method:new Set(['GET','POST','HEAD','OPTIONS','OTHER']),
  route:new Set(['resource','webdir','market','pet-info','friend','account','adoption','other']),
  state:new Set(['paused','negotiating','pet-loaded','online','logged-out','closed','unknown']),
  outcome:new Set(['accepted','area-unavailable','saved-position-invalid','not-in-community','position-missing','movement-invalid','scene-unavailable']),
  code:new Set(['EACCES','EPERM','EADDRINUSE','EADDRNOTAVAIL','ECONNRESET','ETIMEDOUT','ENOSPC','SQLITE_BUSY','INTERNAL_ERROR'])};
const numericKeys=new Set(['connection','command','count','bytes','status','durationMs','requests','successes','rejected','activeSessions','protocolErrors',
  'authenticationCount','authenticationFailures','missingCard','catalogueMismatch','cardUnmapped','keyExchanges','pauseCount','resumeCount']);
const booleanKeys=new Set(['authenticated','paused','enabled']);
export function validateRuntimeLog(value){
  if(!value||Object.keys(value).sort().join('|')!=='enabled|level|maxFileBytes|maxFiles'||typeof value.enabled!=='boolean'
    ||!['info','debug'].includes(value.level)||!Number.isInteger(value.maxFileBytes)||value.maxFileBytes<4096||value.maxFileBytes>50*1024*1024
    ||!Number.isInteger(value.maxFiles)||value.maxFiles<1||value.maxFiles>20)throw Error('INVALID_RUNTIME_LOG_SETTINGS');
  return Object.freeze({...value});
}
function fields(input){
  const result={};
  for(const [key,value] of Object.entries(input??{})){
    if(numericKeys.has(key)&&Number.isSafeInteger(value)&&value>=0)result[key]=value;
    else if(key==='requestedScene'&&Number.isInteger(value)&&value>=0&&value<=65535)result[key]=value;
    else if(booleanKeys.has(key)&&typeof value==='boolean')result[key]=value;
    else if(stringValues[key]?.has(value))result[key]=value;
    else if(key==='port'&&Number.isInteger(value)&&value>=1&&value<=65535)result[key]=value;
    else if(key==='listenAddress'&&typeof value==='string'&&/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)
      &&value.split('.').every(part=>Number(part)<=255))result[key]=value;
    // Paths are supplied only after a match against the finite static resource table.
    else if(key==='resource'&&typeof value==='string'&&/^\/(?:NewQQPet(?:ZIP)?\/)?[A-Za-z0-9_./ -]+\.(?:zip|swf|xml|png|gif|jpg|js|css)$/.test(value)
      &&value.length<=512&&!value.split('/').includes('..'))result[key]=value;
  }
  return result;
}
export function startupFailureFields(error){
  return fields({code:stringValues.code.has(error?.code)?error.code:'INTERNAL_ERROR',service:error?.service,
    listenAddress:error?.address,port:error?.port});
}
export class RuntimeLog{
  constructor({directory,settings=DEFAULT_RUNTIME_LOG,baseline='complete',clock=()=>new Date()}={}){
    this.directory=path.resolve(directory);this.settings=validateRuntimeLog(settings);this.clock=clock;this.run=randomUUID();
    this.baseline=/^[a-z0-9-]{1,80}$/.test(baseline)?baseline:'complete';this.sequence=0;this.failed=false;
  }
  configure(settings){
    const next=validateRuntimeLog(settings),changed=JSON.stringify(next)!==JSON.stringify(this.settings);
    if(changed&&this.settings.enabled&&!next.enabled)this.write('logging.changed',{enabled:false});
    this.settings=next;if(changed&&next.enabled)this.write('logging.changed',{enabled:true});
  }
  write(event,data={},level='info'){
    if(!this.settings.enabled||level==='debug'&&this.settings.level!=='debug')return;
    if(!events.has(event)||!['info','debug','error'].includes(level))throw Error('INVALID_RUNTIME_LOG_EVENT');
    const body=Buffer.from(JSON.stringify({at:this.clock().toISOString(),run:this.run,sequence:++this.sequence,
      baseline:this.baseline,level,event,...fields(data)})+'\n');
    try{
      for(let dir=this.directory;;dir=path.dirname(dir)){
        if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())throw Error('LOG_LINK_REFUSED');if(dir===path.dirname(dir))break;
      }
      mkdirSync(this.directory,{recursive:true});const file=path.join(this.directory,'server.ndjson');
      for(let i=0;i<this.settings.maxFiles;i++){
        const item=path.join(this.directory,i===0?'server.ndjson':'server.'+i+'.ndjson');
        if(existsSync(item)&&lstatSync(item).isSymbolicLink())throw Error('LOG_LINK_REFUSED');
      }
      if(existsSync(file)&&statSync(file).size+body.length>this.settings.maxFileBytes){
        for(let i=this.settings.maxFiles-1;i>=1;i--){
          const to=path.join(this.directory,'server.'+i+'.ndjson'),from=path.join(this.directory,i===1?'server.ndjson':'server.'+(i-1)+'.ndjson');
          if(existsSync(to))unlinkSync(to);if(existsSync(from))renameSync(from,to);
        }
        if(this.settings.maxFiles===1)writeFileSync(file,Buffer.alloc(0));
      }
      appendFileSync(file,body,{mode:0o600});this.failed=false;
    }catch{
      if(!this.failed)process.stderr.write('RUN_LOG_WRITE_FAILED\n');this.failed=true;
    }
  }
}

export function attachRuntimeDiagnostics(server,log){
  let connection=0;
  const listeners=[];
  const attach=(emitter,name,callback)=>{if(emitter){emitter.on(name,callback);listeners.push(()=>emitter.off(name,callback));}};
  attach(server.game.server,'connection',socket=>{
    const id=++connection,channel=server.game.connections.get(socket);let counts={},last='',communityCount=0;
    log.write('game.connected',{connection:id});
    const describe=()=>{
      if(!channel)return;const snapshot=channel.snapshot();
      for(const [command,count] of Object.entries(snapshot.receivedCommandCounts??{})){
        const delta=count-(counts[command]??0);if(delta>0)log.write('game.command',{connection:id,command:Number(command),count:delta,authenticated:snapshot.authenticated},'debug');
      }
      counts={...snapshot.receivedCommandCounts};
      const result=snapshot.communityResult;
      if(result&&result.count>communityCount){
        log.write('game.community',{connection:id,command:result.command,count:result.count-communityCount,outcome:result.outcome,
          requestedScene:result.requestedScene},
          result.outcome==='accepted'?'debug':'error');
        communityCount=result.count;
      }
      const state=stringValues.state.has(snapshot.state)?snapshot.state:'unknown';
      const signature=state+':'+Boolean(channel.growthPaused);
      if(signature!==last){last=signature;log.write('game.state',{connection:id,state,authenticated:snapshot.authenticated,paused:Boolean(channel.growthPaused)});}
    };
    socket.on('data',describe);
    socket.once('close',()=>{describe();log.write('game.closed',{connection:id});});
    socket.on('error',error=>log.write('game.transport_error',{connection:id,code:stringValues.code.has(error.code)?error.code:'INTERNAL_ERROR'},'error'));
  });
  for(const [service,http] of [['web',server.webdir.server],['login',server.remoteLogin?.server],['admin',server.accountWeb?.server]]){
    attach(http,'request',(request,response)=>{
      const start=performance.now(),target=request.url??'',pathname=target.split('?')[0];
      let route='other',resource;
      const host=(request.headers.host??'').replace(/:80$/,'');
      if(server.webdir.legacyCommunityResources?.resolve(host,target)){route='resource';resource=pathname;}
      else if(pathname==='/websmartdir')route='webdir';
      else if(/\/(?:fcgi-bin\/market|common\/market\/)/.test(pathname))route='market';
      else if(pathname.endsWith('/fcgi-bin/babyinfo'))route='pet-info';
      else if(pathname.endsWith('/fcgi-bin/desktopfeed'))route='friend';
      else if(service==='login'||service==='admin')route='account';
      else if(pathname.startsWith('/tuoq/'))route='adoption';
      response.once('finish',()=>log.write('http.request',{service,route,resource,method:stringValues.method.has(request.method)?request.method:'OTHER',
        status:response.statusCode,durationMs:Math.max(0,Math.round(performance.now()-start))},response.statusCode>=400?'error':'debug'));
    });
  }
  let previous='';
  const poll=()=>{
    const state=server.summary();const counts={requests:state.webdir.requestCount,successes:state.webdir.successCount,rejected:state.webdir.rejectedCount,
      activeSessions:state.game.activeSessionCount,protocolErrors:state.game.protocolErrorCount,authenticationCount:state.authenticationCount,
      authenticationFailures:state.authenticationFailures,...state.petRenameRefusals};
    const serial=JSON.stringify(counts);if(serial!==previous){previous=serial;log.write('server.counters',counts,'debug');}
    const directory=state.legacyDirectory;if(directory?.enabled)log.write('directory.activity',{requests:directory.requests,rejected:directory.rejected,keyExchanges:directory.keyExchanges},'debug');
  };
  return {poll,close(){for(const remove of listeners)remove();}};
}
