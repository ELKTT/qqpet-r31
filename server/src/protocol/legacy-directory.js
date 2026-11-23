// PetDir_20100913_192303 SHA22941da8..., send RVAs 7640/64B0/5310/
// 8720/41C0 and receive 7240/6140/4FB0/8420/3EC0. Public endpoint
// catalogue only: these commands do not authenticate or grant a pet session.
import {gameIpv4SAddr,validateListenIpv4} from '../deployment/endpoints.js';
export function decodeLegacyDirectoryRequest(command,body){
  const length={0x9701:4,0x9702:0,0x9703:3,0x9704:5,0x9705:3}[command];
  if(length===undefined||!Buffer.isBuffer(body)||body.length!==length)throw new TypeError('LEGACY_DIRECTORY_INVALID_WIRE');
  if(command===0x9701)return {}; // Do not retain the requested number.
  if(command===0x9702)return {};
  return {zone:body.readUInt16BE(),...(command===0x9704?{area:body.readUInt16BE(2)}:{}),option:body[body.length-1]};
}
const word=v=>{const b=Buffer.alloc(2);b.writeUInt16BE(v);return b;};
const dword=v=>{const b=Buffer.alloc(4);b.writeUInt32BE(v);return b;};
export function validateLegacyDirectoryPolicy(p){
  const keys=p&&Object.keys(p).filter(k=>!['wireMode','publicIpv4','resourcePort'].includes(k)).sort().join('|');
  const resourcePort=p?.resourcePort??80;
  if(!Number.isInteger(resourcePort)||resourcePort<1||resourcePort>65535)throw new TypeError('INVALID_LEGACY_DIRECTORY_POLICY');
  const resourceDomain=ip=>ip+(resourcePort===80?'':':'+resourcePort);
  let remote=false;
  if(p?.publicIpv4!==undefined){
    try{validateListenIpv4(p.host);gameIpv4SAddr(p.publicIpv4);
      if(p.host==='0.0.0.0'&&p.publicIpv4.startsWith('127.'))throw Error();
      remote=p.resourceDomain===resourceDomain(p.publicIpv4);if(!remote)throw Error();}
    catch{throw new TypeError('INVALID_LEGACY_DIRECTORY_POLICY');}
  }
  if(!p||keys!=='area|gamePort|host|port|resourceDomain|zone'
    ||p.wireMode!==undefined&&!['qq-tea','native-body-length'].includes(p.wireMode)
    ||(!remote&&(p.host!=='127.0.0.1'||p.resourceDomain!==resourceDomain('127.0.0.1')))
    ||!Number.isInteger(p.port)||p.port<1||p.port>65535
    ||![p.zone,p.area,p.gamePort].every(n=>Number.isInteger(n)&&n>=1&&n<=65535))throw new TypeError('INVALID_LEGACY_DIRECTORY_POLICY');
  return Object.freeze({...p});
}
export function legacyDirectoryResponse(command,request,policy){
  const p=validateLegacyDirectoryPolicy(policy),ok=request.zone===undefined||request.zone===p.zone
    &&(request.area===undefined||request.area===p.area);
  if(!ok)return Buffer.from('00010000','hex'); // Nonzero result + empty bounded text.
  const result=word(0),ip=dword(gameIpv4SAddr(p.publicIpv4??'127.0.0.1')),port=dword(p.gamePort);
  if(command===0x9701){const domain=Buffer.from(p.resourceDomain,'ascii');return Buffer.concat([result,word(p.zone),ip,port,
    word(p.zone),word(p.area),ip,port,word(domain.length),domain,Buffer.from([0]),word(0)]);}
  if(command===0x9702)return Buffer.concat([result,word(1),word(p.zone),ip,port,Buffer.from([0])]);
  if(command===0x9703)return Buffer.concat([result,word(p.zone),word(1),word(p.area),Buffer.from([0])]);
  return Buffer.concat([result,word(p.zone),word(p.area),Buffer.from([0,0])]);
}
