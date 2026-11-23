import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {RootFrameStreamDecoder,parseRootFrame,encodeRootFrame} from '../root-frame/root-frame-codec.js';
import {ROOT_FRAME_RESET_KEY,ROOT_FRAME_KEY_EXCHANGE_COMMAND_ID,ROOT_FRAME_SESSION_KEY_LENGTH} from '../root-frame/constants.js';
import {decodeLegacyDirectoryRequest,legacyDirectoryResponse,validateLegacyDirectoryPolicy} from '../protocol/legacy-directory.js';

const commands=new Set([0x9701,0x9702,0x9703,0x9704,0x9705]);
const plainLengths=new Map([[0x9701,4],[0x9702,0],[0x9703,3],[0x9704,5],[0x9705,3]]);
export class LegacyDirectoryServer{
  constructor(policy,{port=policy.port,wireMode=policy.wireMode??'qq-tea',sessionKeyFactory=()=>randomBytes(ROOT_FRAME_SESSION_KEY_LENGTH)}={}){
    this.policy=validateLegacyDirectoryPolicy(policy);
    if(!['qq-tea','native-body-length'].includes(wireMode))throw new TypeError('INVALID_LEGACY_DIRECTORY_WIRE_MODE');
    if(!Number.isInteger(port)||port<0||port>65535)throw new TypeError('INVALID_LEGACY_DIRECTORY_PORT');
    if(typeof sessionKeyFactory!=='function')throw new TypeError('INVALID_LEGACY_DIRECTORY_KEY_FACTORY');
    this.port=port;this.wireMode=wireMode;this.sessionKeyFactory=sessionKeyFactory;this.sockets=new Set();this.requests=0;this.rejected=0;this.keyExchanges=0;
    this.wireModes={plain:0,qqTea:0};
    this.rejectionReasons={frame:0,ciphertext:0,command:0,body:0,budget:0,key:0};
    this.requestShapes={commands:{'9701':0,'9702':0,'9703':0,'9704':0,'9705':0,unregistered:0},
      wireBodies:{empty:0,shortAligned:0,unaligned:0,block16:0,block24:0,largerAligned:0},
      ciphertextStages:{beforeKey:0,afterKey:0}};
  }
  async start(){
    if(this.server)throw new Error('LEGACY_DIRECTORY_ALREADY_STARTED');
    this.server=net.createServer(socket=>{
      if(this.sockets.size>=32){socket.destroy();return;}
      this.sockets.add(socket);socket.setTimeout(15000,()=>socket.destroy());socket.on('error',()=>{});
      let sessionKey=null,connectionMode=this.wireMode==='qq-tea'?'qq-tea':null;
      socket.once('close',()=>{this.sockets.delete(socket);sessionKey?.fill(0);});
      const decoder=new RootFrameStreamDecoder();let received=0;
      let rejection='frame';
      socket.on('data',chunk=>{try{
        rejection='frame';
        const frames=[],decodeKey=sessionKey??ROOT_FRAME_RESET_KEY;
        for(const wire of decoder.ingest(chunk)){
          // Count only checksum-validated framing with fixed, finite buckets.
          // No identity, key, body, arbitrary command or exact length is saved.
          const command=commands.has(wire.commandId)?wire.commandId.toString(16):'unregistered';
          this.requestShapes.commands[command]++;
          const length=wire.wireBody.length;
          const shape=length===0?'empty':length%8?'unaligned':length<16?'shortAligned'
            :length===16?'block16':length===24?'block24':'largerAligned';
          this.requestShapes.wireBodies[shape]++;
          rejection='command';
          if(!commands.has(wire.commandId))throw new Error('LEGACY_DIRECTORY_COMMAND');
          if(connectionMode===null){
            // Root 2530/2FB0 supports explicit plain framing; 26F0 bypasses
            // 00FF in that mode. All five public requests are 0..5 bytes,
            // while their Base 7BF0 QQ-TEA envelopes are exactly 16 bytes.
            // Select from these disjoint valid shapes before decrypting, then
            // lock the connection. Never retry a failed cipher as plaintext.
            rejection='body';
            if(length===plainLengths.get(wire.commandId))connectionMode='plain';
            else if(length===16)connectionMode='qq-tea';
            else throw new Error('LEGACY_DIRECTORY_WIRE_SHAPE');
            this.wireModes[connectionMode==='plain'?'plain':'qqTea']++;
          }
          rejection='frame';
          try{frames.push(parseRootFrame(wire.raw,{encrypted:connectionMode==='qq-tea',key:decodeKey}));}
          catch(error){
            if(error?.code==='INVALID_CIPHERTEXT'){
              rejection='ciphertext';this.requestShapes.ciphertextStages[sessionKey?'afterKey':'beforeKey']++;
            }
            throw error;
          }
        }
        for(const f of frames){
          rejection='budget';
          if(++received>128)throw new Error('LEGACY_DIRECTORY_BUDGET');
          rejection='body';
          const request=decodeLegacyDirectoryRequest(f.commandId,f.body);
          const body=legacyDirectoryResponse(f.commandId,request,this.policy);
          if(connectionMode==='qq-tea'&&!sessionKey){
            rejection='key';
            const key=this.sessionKeyFactory();
            if(!Buffer.isBuffer(key)||key.length!==ROOT_FRAME_SESSION_KEY_LENGTH)throw new Error('LEGACY_DIRECTORY_KEY');
            sessionKey=Buffer.from(key);
            // Native Root 2B30 waits for 00FF. Its 2C80 consumer installs the
            // byte-length + key before dispatching any buffered directory reply.
            const exchange=Buffer.concat([Buffer.from([ROOT_FRAME_SESSION_KEY_LENGTH]),sessionKey]);
            socket.write(encodeRootFrame({...f,commandId:ROOT_FRAME_KEY_EXCHANGE_COMMAND_ID,body:exchange},{encrypted:true,key:ROOT_FRAME_RESET_KEY}));
            this.keyExchanges++;
          }
          socket.write(encodeRootFrame({...f,body},{encrypted:connectionMode==='qq-tea',key:sessionKey}));this.requests++;
        }
      }catch{this.rejected++;this.rejectionReasons[rejection]++;socket.destroy();}});
    });
    await new Promise((resolve,reject)=>{const error=e=>{this.server.off('listening',ready);reject(e);};
      const ready=()=>{this.server.off('error',error);resolve();};this.server.once('error',error);this.server.once('listening',ready);
      this.server.listen({host:this.policy.host,port:this.port,exclusive:true});});
  }
  async stop(){for(const socket of this.sockets)socket.destroy();if(this.server?.listening)await new Promise(resolve=>this.server.close(resolve));this.server=null;}
  summary(){return {enabled:true,requests:this.requests,rejected:this.rejected,connections:this.sockets.size,keyExchanges:this.keyExchanges,
    wireModes:{...this.wireModes},
    rejectionReasons:{...this.rejectionReasons},requestShapes:{commands:{...this.requestShapes.commands},
      wireBodies:{...this.requestShapes.wireBodies},ciphertextStages:{...this.requestShapes.ciphertextStages}}};}
}
