import net from 'node:net';
import {once} from 'node:events';
import {parseDeploymentEndpoints,validateListenIpv4} from '../../server/src/deployment/endpoints.js';
import {validateLegacyDirectoryPolicy} from '../../server/src/protocol/legacy-directory.js';
import {need} from './common.mjs';

export function listenerBindings(endpoints,directory){
  const config=parseDeploymentEndpoints(endpoints),policy=validateLegacyDirectoryPolicy(directory);
  return [
    ...['web','login','game'].map(service=>({service,address:config.listen[service].ipv4,port:config.listen[service].port})),
    {service:'directory',address:policy.host,port:policy.port},
    {service:'admin',address:config.admin.listen.ipv4,port:config.admin.listen.port}
  ];
}
export async function checkListenerPorts(bindings){
  need(Array.isArray(bindings)&&bindings.length>0&&bindings.length<=5,'LISTENER_BINDINGS_INVALID');
  const seen=new Set();
  for(const row of bindings){
    need(['web','login','game','directory','admin'].includes(row.service)&&Number.isInteger(row.port)
      &&row.port>=1&&row.port<=65535,'LISTENER_BINDINGS_INVALID');
    validateListenIpv4(row.address);
    const key=row.address+':'+row.port;need(!seen.has(key),'LISTENER_BINDINGS_DUPLICATE');seen.add(key);
  }
  const results=[];
  for(const row of bindings){
    const server=net.createServer(socket=>socket.destroy());
    try{
      const listening=once(server,'listening');server.listen({host:row.address,port:row.port,exclusive:true});
      await listening;
      results.push({...row,available:true});
    }catch(error){
      results.push({...row,available:false,code:['EADDRINUSE','EACCES','EPERM','EADDRNOTAVAIL'].includes(error.code)?error.code:'INTERNAL_ERROR'});
    }finally{if(server.listening)await new Promise(resolve=>server.close(resolve));}
  }
  return {kind:'qqpet-listener-port-check',passed:results.every(row=>row.available),listeners:results};
}
