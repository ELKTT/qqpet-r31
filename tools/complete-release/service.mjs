import {existsSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {loadLocalLoginServer} from '../../server/src/local-login/configuration.js';
import {SqliteOriginalLoginStore} from '../../server/src/original-data/sqlite-original-login-store.js';
import {AccountService} from '../../server/src/accounts/account-service.js';
import {RuntimeLog,DEFAULT_RUNTIME_LOG,validateRuntimeLog,attachRuntimeDiagnostics,startupFailureFields} from '../../server/src/runtime/runtime-log.js';
import {verifyState,safe,need,atomic,json} from './common.mjs';
import {listenerBindings,checkListenerPorts} from './listen-ports.mjs';

import {upgradeBalanceProfiles} from './balance-profile-upgrade.mjs';

export const PROFILES=['original-post-entry','original-play-menu','online-vitals','pet-business','pet-membership','care-economy','webdir-zone-template'];
export function serviceOptions(root){
  const file=name=>safe(root,name);
  const values=new Map([
    ['--database',file('data/accounts.sqlite')],['--webdir-profile',file('data/webdir.json')],
    ['--webdir-zone-template',file('data/webdir-zone-template.json')],['--deployment-endpoints',file('server/config/endpoints.json')],
    ['--login-tls-cert',file('tls/server-cert.pem')],['--login-tls-key',file('tls/server-key.pem')],
    ['--unknown-command-policy','record-only'],['--enable-desktop-tasks',true],['--friend-policy','community-friends'],
    ['--enable-html-market-compatibility',true],['--enable-desktop-game-entry',true],
    ['--market-client-root',file('server/resources/static')],['--enable-legacy-community-entry-compatibility',true],
    ['--enable-legacy-community-home-compatibility',true],['--legacy-community-home-profile',file('server/config/community-home.json')],
    ['--account-backups-root',safe(root,'data/admin-backups',{missing:true})]
  ]);
  for(const [flag,name] of [['post-entry','original-post-entry'],['play-menu','original-play-menu'],['online-vitals','online-vitals'],
    ['pet-business','pet-business'],['membership','pet-membership'],['care-economy','care-economy']])values.set('--'+flag+'-profile',file('data/'+name+'.json'));
  // The accepted wardrobe catalogue is fixed configuration; ownership remains
  // in the existing account database. Older releases do not carry this file.
  if(existsSync(safe(root,'server/config/community-wardrobe.json',{missing:true}))){
    values.set('--enable-native-avatar-preview',true);
    values.set('--wardrobe-profile',file('server/config/community-wardrobe.json'));
  }
  return values;
}
export function initialize(root){
  mkdirSync(safe(root,'data',{missing:true}),{recursive:true});
  const store=new SqliteOriginalLoginStore({filePath:safe(root,'data/accounts.sqlite',{missing:true})});
  try{new AccountService({database:store.database});}finally{store.close();}
  for(const name of PROFILES){const target=safe(root,'data/'+name+'.json',{missing:true});if(!existsSync(target))copyFileSync(safe(root,'server/config/'+name+'.json'),target);}
  upgradeBalanceProfiles(root);
  // Old deliveries copied this profile before server-selected movies existed.
  // Adopt the shipped opt-in once; preserve explicit choices and all other fields.
  const entryName='data/original-post-entry.json',entry=JSON.parse(readFileSync(safe(root,entryName),'utf8'));
  const shipped=JSON.parse(readFileSync(safe(root,'server/config/original-post-entry.json'),'utf8'));
  if(entry&&typeof entry==='object'&&!Array.isArray(entry)&&!Object.hasOwn(entry,'serverAnimations')&&shipped.serverAnimations===true){
    atomic(root,entryName,json({...entry,serverAnimations:true}));
  }
  if(!existsSync(safe(root,'data/webdir.json',{missing:true})))atomic(root,'data/webdir.json',json({schemaVersion:1,profiles:[]}));
}
export function loggingSettings(root){return validateRuntimeLog(JSON.parse(readFileSync(safe(root,'runtime-log.json'),'utf8')));}
function locked(root){
  const file=safe(root,'data/runtime.pid',{missing:true});
  if(existsSync(file)){
    let pid;try{pid=JSON.parse(readFileSync(file,'utf8')).pid;}catch{}
    if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);throw Error('SERVER_ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}}
  }
  atomic(root,'data/runtime.pid',json({pid:process.pid}));
  return ()=>{try{if(JSON.parse(readFileSync(file,'utf8')).pid===process.pid)unlinkSync(file);}catch{}};
}
export async function serve(root,args=[]){
  root=path.resolve(root);process.chdir(root);
  const state=verifyState(root,process.platform==='win32'?'windows-server':'linux-server');
  const control=args.includes('--control-stdin');args=args.filter(a=>a!=='--control-stdin');
  if(args[0]==='--logging'){
    need(args.length===2&&['on','off','info','debug'].includes(args[1]),'SERVER_ARGUMENTS_INVALID');
    const value=loggingSettings(root);
    const next={...value,...(['on','off'].includes(args[1])?{enabled:args[1]==='on'}:{level:args[1]})};
    atomic(root,'runtime-log.json',json(next));process.stdout.write('LOGGING_SETTINGS_SAVED\n');return;
  }
  need(args.length===0||args.length===1&&['--check','--initialize','--check-ports'].includes(args[0]),'SERVER_ARGUMENTS_INVALID');
  if(args[0]==='--check-ports'){
    const endpoints=JSON.parse(readFileSync(safe(root,'server/config/endpoints.json'),'utf8'));
    const community=JSON.parse(readFileSync(safe(root,'server/config/community-home.json'),'utf8'));
    const result=await checkListenerPorts(listenerBindings(endpoints,community.directory));
    process.stdout.write(JSON.stringify(result)+'\n');if(!result.passed)process.exitCode=1;return result;
  }
  const log=new RuntimeLog({directory:safe(root,'data/logs',{missing:true}),settings:loggingSettings(root),baseline:state.baseline});
  log.write('server.starting');let server,store,unlock,timer,diagnostics,stopped=false;
  const stop=async()=>{
    if(stopped)return;stopped=true;clearInterval(timer);
    try{diagnostics?.poll();await server?.stop();}finally{diagnostics?.close();store?.close();unlock?.();log.write('server.stopped');
      process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);}
  };
  const shutdown=()=>{void stop().catch(()=>{process.exitCode=1;});};
  try{
    mkdirSync(safe(root,'data',{missing:true}),{recursive:true});unlock=locked(root);initialize(root);
    if(args[0]==='--initialize'){await stop();process.stdout.write('SERVER_DATA_READY\n');return;}
    ({server,store}=await loadLocalLoginServer(serviceOptions(root)));
    if(args[0]==='--check'){await stop();process.stdout.write('COMPLETE_SERVER_ASSEMBLY_OK\n');return;}
    await server.start();diagnostics=attachRuntimeDiagnostics(server,log);process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
    let tick=0,lastSettings=JSON.stringify(log.settings);
    timer=setInterval(()=>{
      try{
        server.game.notifyInitialPetInfo();server.game.notifyCharacterEntry();
        if(++tick%4===0){
          try{const next=loggingSettings(root),serialized=JSON.stringify(next);if(lastSettings!==serialized){log.configure(next);lastSettings=serialized;}}
          catch{if(lastSettings!=='invalid'){log.write('logging.invalid',{},'error');lastSettings='invalid';}}
          diagnostics.poll();
        }
      }catch{log.write('server.failed',{code:'INTERNAL_ERROR'},'error');process.exitCode=1;void stop();}
    },250);timer.unref();
    log.write('server.ready');
    process.stdout.write(JSON.stringify({ready:true,baseline:state.baseline,logging:log.settings.enabled,
      login:server.deployment.public.loginOrigin,web:server.deployment.public.webOrigin,game:server.deployment.public.game,legacyDirectoryPort:server.legacyDirectory.port,adminLoopback:true})+'\n');
    if(control){process.stdin.setEncoding('utf8');let pending='';process.stdin.on('data',chunk=>{
      pending+=chunk;if(pending.length>64)process.stdin.destroy();else if(pending.includes('\n')){process.stdin.destroy();if(pending.trim()==='stop')void stop();}
    });}
    return {server,stop,log};
  }catch(error){log.write('server.failed',startupFailureFields(error),'error');await stop();throw error;}
}
