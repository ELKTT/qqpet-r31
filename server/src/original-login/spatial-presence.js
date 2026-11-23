import {CommunityAreaRoster} from './community-area-roster.js';
import {writeGameFrame} from '../runtime/bounded-socket-write.js';
import {COMMUNITY_PRESENCE,encodeCommunityRegion,encodeCommunityPath} from '../protocol/community-presence.js';
import {HOME_COMMANDS,encodeHomePositions,encodeHomeInvitation} from '../protocol/legacy-home.js';
import {gbkEncode} from '../accounts/account-service.js';
import {SPATIAL_CHAT,encodeSpatialChat} from '../protocol/spatial-chat.js';
import {COMMUNITY_EMOTION,encodeCommunityEmotion} from '../protocol/community-emotion.js';

export class SpatialPresence {
  constructor({community,home,clock=Date.now}){this.community=community;this.home=home;this.clock=clock;this.previous=new Map();this.areaRoster=new CommunityAreaRoster();}
  snapshot(channel) {
    if(channel.closed||channel.logoutCount||channel.growthPaused||!channel.profile||!channel.sessionKey)return null;
    if(!(channel.homeContext.inHome&&this.home)&&!(channel.communityContext.inCommunity&&this.community))return null;
    const profile=channel.timeSession?.profile(channel.profile)??channel.profile,id=profile.petIdBytes.toString('hex');
    if(channel.homeContext.inHome&&this.home) {
      const host=channel.homeContext.homeHost??profile.petIdBytes;
      return {id,channel,profile,kind:'home',scope:'home:'+host.toString('hex'),host,
        x:channel.homeContext.homeX??this.home.policy.x,y:channel.homeContext.homeY??this.home.policy.y,
        version:profile.login.avatarVersion??0,revision:channel.homeContext.revision??0};
    }
    if(channel.communityContext.inCommunity&&this.community) {
      const row=this.community.position(profile);if(!row)return null;
      return {id,channel,profile,kind:'community',scope:'community:'+this.community.policy.area+':'+row.scene,
        ...row,version:profile.login.avatarVersion??0,revision:channel.communityContext.revision??0};
    }
    return null;
  }
  peer(p){return {petId:p.profile.petIdBytes,level:p.profile.login.levelValue,state:p.profile.login.statusId??0,version:p.version,direction:0,x:p.x,y:p.y,time:this.clock(),path:[]};}
  synchronize(connections) {
    const current=new Map(),sockets=new Map();
    for(const [socket,channel] of connections)if(!socket.destroyed&&socket.writable){sockets.set(channel,socket);const p=this.snapshot(channel);if(p)current.set(channel,p);}
    const scopes=new Map();
    for(const [channel,p]of current){const scope=p.scope;let group=scopes.get(scope);if(!group){group=new Map();scopes.set(scope,group);}group.set(channel,p);}
    const send=(channel,command,body)=>{const socket=sockets.get(channel);if(!socket)return;const frame=channel.createSpatialNotification(command,body);if(frame)writeGameFrame(socket,frame);};
    if(this.community)this.areaRoster.synchronize(current,this.community.policy.area,send);
    const homeSnapshot=p=>this.home.notification(p.profile,this.home.scene(this.home.profileForId(p.host)),p.channel.homeContext);
    for(const [channel,old] of this.previous) {
      const next=current.get(channel);
      if(!next||next.scope!==old.scope)for(const [other,p] of scopes.get(old.scope)??[])if(other!==channel) {
        if(p.kind==='community')send(other,COMMUNITY_PRESENCE.region,encodeCommunityRegion({leaves:[old.profile.petIdBytes]}));
        else {const message=homeSnapshot(p);send(other,message.command,message.body);}
      }
    }
    for(const [channel,p] of current) {
      const old=this.previous.get(channel);
      if(!old||old.scope!==p.scope) {
        const peers=[...scopes.get(p.scope)].filter(([c])=>c!==channel);
        if(p.kind==='community')for(let offset=0;offset<peers.length;offset+=50)
          send(channel,COMMUNITY_PRESENCE.region,encodeCommunityRegion({enters:peers.slice(offset,offset+50).map(([,q])=>this.peer(q))}));
        for(const [other,q] of peers) {
          if(p.kind==='community')send(other,COMMUNITY_PRESENCE.region,encodeCommunityRegion({enters:[this.peer(p)]}));
          else {const message=homeSnapshot(q);send(other,message.command,message.body);}
        }
      } else if(p.x!==old.x||p.y!==old.y||p.revision!==old.revision||p.version!==old.version||p.profile.login.statusId!==old.profile.login.statusId) {
        for(const [other,q] of scopes.get(p.scope)) {
          if(other===channel)continue;
          if(p.kind==='home') {
            if(p.version!==old.version||p.profile.login.statusId!==old.profile.login.statusId){const message=homeSnapshot(q);send(other,message.command,message.body);}
            else send(other,HOME_COMMANDS.positions,encodeHomePositions({host:p.host,peers:[{pet:p.profile.petIdBytes,x:p.x,y:p.y}]}));
          }
          else if(p.version!==old.version||p.profile.login.statusId!==old.profile.login.statusId)send(other,COMMUNITY_PRESENCE.region,encodeCommunityRegion({enters:[this.peer(p)]}));
          else {const move=p.channel.communityContext.lastMove;
            send(other,COMMUNITY_PRESENCE.path,encodeCommunityPath({petId:p.profile.petIdBytes,time:move?.time??this.clock(),x:move?.x??old.x,y:move?.y??old.y,
              path:move?.path?.length?move.path:[{x:p.x,y:p.y}]}));}
        }
      }
    }
    for(const channel of connections.values()) {
      const homePackets=channel.homeContext.pendingHomePackets??[];channel.homeContext.pendingHomePackets=[];
      if(!channel.closed&&!channel.logoutCount&&!channel.growthPaused)for(const p of homePackets)send(channel,p.command,p.body);
      const invites=channel.homeContext.pendingInvites??[];channel.homeContext.pendingInvites=[];
      if(channel.profile&&!channel.closed&&!channel.logoutCount&&!channel.growthPaused)for(const target of invites){
        const host=channel.profile.petIdBytes;
        const title=gbkEncode('小伙伴邀请你来家园玩,是否接受邀请?');
        for(const recipient of connections.values())if(!recipient.closed&&!recipient.logoutCount&&!recipient.growthPaused&&recipient.profile?.petIdBytes.equals(target))
          send(recipient,HOME_COMMANDS.invited,encodeHomeInvitation({host,title,description:Buffer.alloc(0)}));
      }
      const emotions=channel.pendingEmotions??[];channel.pendingEmotions=[];
      const source=current.get(channel);
      if(source?.kind==='community')for(const emotion of emotions)for(const [other] of scopes.get(source.scope))
        if(other!==channel)
          send(other,COMMUNITY_EMOTION.receive,encodeCommunityEmotion(emotion,source.profile.petIdBytes));
      const pending=channel.pendingChat??[];channel.pendingChat=[];
      const sender=current.get(channel);if(!sender)continue;
      for(const message of pending) {
        if(message.kind!==sender.kind||message.kind==='home'&&!message.host.equals(sender.host))continue;
        const command=message.kind==='home'?SPATIAL_CHAT.homeReceive:SPATIAL_CHAT.communityReceive;
        const body=encodeSpatialChat(message,sender.profile.petIdBytes);
        for(const [other,recipient] of scopes.get(sender.scope))if(message.type===0||recipient.profile.petIdBytes.equals(message.target)||(message.kind==='community'&&other===channel))send(other,command,body);
      }
    }
    this.previous=current;
  }
}
