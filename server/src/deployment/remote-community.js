import {readFile} from 'node:fs/promises';
import {parseToolbarCookies} from '../protocol/desktop-toolbar-http.js';
import {CommunityHandoff} from '../community-web/community-handoff.js';
import {CommunityWebServer} from '../community-web/community-web-server.js';
import {validateCommunityPet} from '../community-web/community-session.js';
import {parseCommunityEntry} from '../community-web/community-entry.js';
import {loadCommunityResources} from '../community-web/community-resources.js';
import {applyCommunityWideViewport} from '../community-web/community-wide-resources.js';
import {CommunityWorld} from '../community-web/community-world.js';
import {loadCommunityMapPreviews} from '../community-web/community-map-previews.js';
import {localCommunityDirectory} from '../community-web/community-directory.js';
import {MARKET_FRAME_URL} from '../original-webdir/market-page-resources.js';
import {BusinessAddresses} from './business-addresses.js';
import {applyRemoteCommunityAddresses} from './community-addresses.js';

export function remoteCommunityBinding(service,{cookie,generation}={}){
  let input=null,identity=null;
  if(generation===undefined){
    input=parseToolbarCookies(cookie);
    identity=service.ticketIssuer.verifyBoundHex(input.sign,{serviceId:0x00200e01});
    if(identity.uin!==input.uin)throw new Error('COMMUNITY_IDENTITY_REJECTED');
  }
  const matches=[...service.game.connections].filter(([socket,channel])=>!socket.destroyed&&socket.writable
    &&!channel.closed&&!channel.logoutCount&&channel.snapshot().authenticated
    &&(generation===undefined?channel.authenticatedUin===identity.uin&&channel.profile.petIdBytes.readBigUInt64LE()===input.petId:
      service.game.communityConnectionIds.get(channel)===generation));
  if(matches.length!==1)throw new Error('COMMUNITY_ROOT_UNAVAILABLE');
  const channel=matches[0][1],profile=typeof channel.timeSession?.profile==='function'?channel.timeSession.profile(channel.profile):channel.profile;
  const login=profile.login,bytes=login.petName,end=bytes.indexOf(0),petId=profile.petIdBytes.readBigUInt64LE();
  return {generation:service.game.communityConnectionIds.get(channel),pet:validateCommunityPet({petId:petId.toString(),
    gender:(petId>>32n&0xffffn)===102n?0:1,level:login.levelValue,
    nickname:new TextDecoder('gb18030',{fatal:true}).decode(end<0?bytes:bytes.subarray(0,end)),vip:login.vipFlag,vipLevel:login.unknown_0x65})};
}

export class RemoteCommunity {
  constructor({service,site,addresses,handoff}){Object.assign(this,{service,site,addresses,handoff});}
  matches(target){return typeof target==='string'&&(target.split('?')[0]==='/clientmain.html'||target.startsWith('/community/'));}
  handle(req,res){
    const refuse=status=>{req.resume();res.writeHead(status,{'Content-Type':'text/plain',Connection:'close'});res.end('COMMUNITY_REQUEST_REJECTED');};
    if(req.headers.host!==this.addresses.authority||!this.addresses.accepts(req)||req.url.length>2048
      ||!req.url.startsWith('/')||/[\\#\x00-\x20]/.test(req.url)||/%(?:2f|5c|2e|25)/i.test(req.url.split('?')[0]))return refuse(403);
    const url=new URL(req.url,this.addresses.origin);
    if(url.pathname!==req.url.split('?')[0]||['/community/handoff','/community/launch','/community/diagnostics.json'].includes(url.pathname))return refuse(404);
    if(url.pathname==='/clientmain.html'){
      if(req.method!=='GET'||!parseCommunityEntry(url.search))return refuse(400);
      try{
        const binding=remoteCommunityBinding(this.service,{cookie:req.headers.cookie});
        const session=this.handoff.refresh(binding.generation);if(!session)return refuse(403);
        const token=session.redeem(session.issueGrant());if(!token)return refuse(403);
        res.setHeader('Set-Cookie',`qqpet_community=${token}; Path=/community/; HttpOnly; SameSite=Strict`);
      }catch{return refuse(403);}
    }
    this.addresses.wrapResponse(res,'pet.qq.com');this.site.handle(req,res);
  }
  stop(){return this.site.stop();}

  resource(authority,target){
    if(!['resource.pet.qq.com','client.pet.qq.com'].includes(authority))return null;
    const pathname=target.split('?')[0];
    if(!pathname.startsWith('/common/petsoc/'))return null;
    return this.site.resources.get(pathname.slice('/common/petsoc/'.length));
  }
}

export async function createRemoteCommunity(service){
  const addresses=new BusinessAddresses(service.deployment);
  const handoff=new CommunityHandoff({resolve:generation=>{
    if(typeof generation!=='string')return null;
    try{return remoteCommunityBinding(service,{generation});}catch{return null;}
  }});
  const catalog=JSON.parse(await readFile(new URL('../../assets/community-web/resources.json',import.meta.url),'utf8'));
  const resources=applyRemoteCommunityAddresses(await applyCommunityWideViewport(await loadCommunityResources(new URL('../../resources/static/',import.meta.url),catalog)),service.deployment);
  const data=JSON.parse(await readFile(new URL('../../assets/community-web/world.json',import.meta.url),'utf8'));
  const navigation=new CommunityWorld(data,resources),previews=await loadCommunityMapPreviews(resources,true);
  const site=new CommunityWebServer({resources,enabled:true,publicOrigin:addresses.origin,handoff,navigation,previews,
    directory:localCommunityDirectory(),careResources:service.webdir.careResources,
    market:service.webdir.marketPages?{frame:MARKET_FRAME_URL,ready:()=>service.webdir.ready}:null});
  await site.prepare();return new RemoteCommunity({service,site,addresses,handoff});
}
