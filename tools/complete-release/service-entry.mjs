import path from 'node:path';
import {serve} from './service.mjs';
import {startupFailureFields} from '../../server/src/runtime/runtime-log.js';
const args=process.argv.slice(2);
if(args.length===1&&args[0]==='--help')process.stdout.write('QQPetServer [--check | --check-ports | --initialize | --logging on|off|info|debug]\n');
else serve(globalThis.__qqpetRoot??path.dirname(process.execPath),args).catch(error=>{
  const code=error.code??error.message,detail=startupFailureFields(error);
  process.stderr.write((/^[A-Z0-9_]+$/.test(code)?code:'COMPLETE_SERVER_FAILED')+'\n');
  if(detail.listenAddress&&detail.port)process.stderr.write(JSON.stringify(detail)+'\n');
  if(code==='EADDRINUSE')process.stderr.write('Required TCP port is already in use. Run ./start.sh --check-ports and inspect ss -ltnp. Stop or reconfigure the conflicting service before retrying.\n');
  process.exitCode=1;
});
