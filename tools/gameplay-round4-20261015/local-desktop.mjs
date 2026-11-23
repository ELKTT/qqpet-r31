import {deflateSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {swfStructure} from '../../server/src/deployment/swf-strings.js';
import {writeZip} from '../complete-release/zip.mjs';
import {ROOT,atomic,json,sha,need} from '../complete-release/common.mjs';
export const B=(...p)=>Buffer.concat(p.map(v=>typeof v==='number'?Buffer.from([v]):v));
export const U=n=>{const a=[];do{const v=n&127;n>>>=7;a.push(v|(n?128:0));}while(n);return Buffer.from(a);};
const w=(n,size)=>{const b=Buffer.alloc(size);size===2?b.writeUInt16LE(n):b.writeUInt32LE(n);return b;};
const tag=(n,b)=>B(w((n<<6)|63,2),w(b.length,4),b);
// A real Sprite document class. The native TickleSystem resource consumer loads
// main_102/main_103; each wrapper loads a sibling AVM1 game in the local sandbox.
export function localDesktopWrapper(source,asset){
 need(/^game(?:_(?:102|103))?\.swf$/.test(asset),'LOCAL_GAME_NAME');
 const strings=[''],names=[null],spaces=[''],qmap=new Map();
 const s=v=>{let n=strings.indexOf(v);if(n<0){n=strings.length;strings.push(v);}return n;};
 const q=(pkg,name)=>{const key=pkg+'::'+name;if(qmap.has(key))return qmap.get(key);let n=spaces.indexOf(pkg);if(n<0){n=spaces.length;spaces.push(pkg);}const id=names.length;names.push([n+1,s(name)]);qmap.set(key,id);s(pkg);return id;};
 const prop=n=>q('',n),cls=(p,n)=>q(p,n),op=(n,...a)=>B(n,...a.map(U)),str=v=>op(0x2c,s(v));
 const Class=prop('LocalDesktopGame'),Sprite=cls('flash.display','Sprite');
 const Loader=cls('flash.display','Loader'),Request=cls('flash.net','URLRequest'),Timer=cls('flash.utils','Timer');
 const EI=cls('flash.external','ExternalInterface'),Event=cls('flash.events','Event'),TimerEvent=cls('flash.events','TimerEvent');
 const stage=prop('stage'),loader=prop('gameLoader'),timer=prop('moodTimer'),ready=prop('loaded'),counter=prop('rewardCount');
 const init=prop('initialize'),complete=prop('onLoaded'),pulse=prop('onPulse'),pause=prop('onPause'),resume=prop('onResume'),dispose=prop('onDispose'),result=prop('onResult'),key=prop('onKey');
 const get=n=>B(0xd0,op(0x66,n)),set=(n,v)=>B(0xd0,v,op(0x61,n));
 const invoke=(obj,method,...args)=>B(obj,...args,op(0x4f,prop(method),args.length));
 const listen=(obj,e,handler)=>invoke(obj,'addEventListener',e,get(handler));
 const branch=(opcode,body)=>{const offset=Buffer.alloc(3);offset.writeIntLE(body.length,0,3);return B(opcode,offset,body);};
 const constructed=(c,...args)=>B(op(0x5d,c),...args,op(0x4a,c,args.length));
 const pre=B(0xd0,0x30),ret=B(0x47),bodies=[];
 const body=(code,stack=6,locals=2,depth=10)=>{bodies.push({code:B(pre,code,ret),limits:[stack,locals,9,depth]});};
 bodies.push({code:B(pre,ret),limits:[1,1,8,9]}); // class initializer 0
 body(B(0xd0,op(0x49,0),listen(B(0xd0),B(op(0x60,Event),op(0x66,prop('ADDED_TO_STAGE'))),init),
  get(stage),branch(0x12,invoke(B(0xd0),'initialize',B(0x20)))),5,1); // constructor 1
 body(B(get(loader),branch(0x12,ret),
  set(loader,constructed(Loader)),set(timer,constructed(Timer,op(0x25,30000))),
  B(get(stage),str('noScale'),op(0x61,prop('scaleMode'))),B(get(stage),str('TL'),op(0x61,prop('align'))),
  invoke(B(0xd0),'addChild',get(loader)),
  listen(B(get(loader),op(0x66,prop('contentLoaderInfo'))),B(op(0x60,Event),op(0x66,prop('COMPLETE'))),complete),
  listen(get(timer),B(op(0x60,TimerEvent),op(0x66,prop('TIMER'))),pulse),
  listen(get(stage),B(op(0x60,Event),op(0x66,prop('DEACTIVATE'))),pause),
  listen(get(stage),B(op(0x60,Event),op(0x66,prop('ACTIVATE'))),resume),
  listen(B(0xd0),B(op(0x60,Event),op(0x66,prop('REMOVED_FROM_STAGE'))),dispose),
  listen(get(stage),str('keyDown'),key),
  invoke(B(op(0x60,EI)),'addCallback',str('TICKLE_OnResult'),get(result)),
  invoke(get(loader),'load',constructed(Request,
   // Resolve from the actual wrapper URL, never from the working directory.
   B(get(prop('loaderInfo')),op(0x66,prop('url')),0x24,0,
    get(prop('loaderInfo')),op(0x66,prop('url')),str('/'),op(0x46,prop('lastIndexOf'),1),0x24,1,0xa0,
    op(0x46,prop('substring'),2),str(asset),0xa0))))); // initialize 2
 const info=B(get(loader),op(0x66,prop('contentLoaderInfo'))),width=B(info,op(0x66,prop('width'))),height=B(info,op(0x66,prop('height')));
 const caps=cls('flash.system','Capabilities');
 body(B(invoke(B(op(0x60,EI)),'call',str('API.ResizeWindow'),width,height),
  invoke(B(op(0x60,EI)),'call',str('API.MoveTo'),B(op(0x60,caps),op(0x66,prop('screenResolutionX')),width,0xa1,0x24,2,0xa3),B(op(0x60,caps),op(0x66,prop('screenResolutionY')),height,0xa1,0x24,2,0xa3)),
  invoke(B(op(0x60,EI)),'call',str('API.Show'),B(0x26)),set(ready,B(0x26)),invoke(get(timer),'start')),8); // loaded 3
 body(B(get(ready),branch(0x11,ret),get(stage),branch(0x11,ret),
  set(counter,B(get(counter),0xc0)),
  invoke(B(op(0x60,EI)),'call',str('TICKLE_SendAction'),op(0x25,50),get(counter)))); // mood 4
 body(invoke(get(timer),'stop')); // pause 5
 body(B(get(ready),branch(0x11,ret),invoke(get(timer),'start'))); // resume 6
 body(B(set(ready,B(0x27)),invoke(get(timer),'stop'),invoke(get(loader),'unloadAndStop',B(0x26)))); // dispose 7
 body(B()); // result 8
 const exit=B(invoke(B(0xd0),'onDispose',B(0x20)),invoke(B(op(0x60,EI)),'call',str('API.DestroyWindow')));
 body(B(0xd1,op(0x66,prop('keyCode')),0x24,27,0xab,branch(0x12,exit))); // Escape 9
 const ancestors=[cls('','Object'),cls('flash.events','EventDispatcher'),cls('flash.display','DisplayObject'),cls('flash.display','InteractiveObject'),cls('flash.display','DisplayObjectContainer'),Sprite];
 const script=B(pre,0x65,0,...ancestors.map(n=>B(op(0x60,n),0x30)),op(0x60,Sprite),op(0x58,0),...ancestors.map(()=>B(0x1d)),op(0x68,Class),ret);
 const slot=(n,type,id)=>B(U(n),0,U(id),U(type),0);
 const method=(n,id)=>B(U(n),1,0,U(id));
 const traits=[slot(loader,Loader,1),slot(timer,Timer,2),slot(ready,prop('Boolean'),3),slot(counter,prop('uint'),4),...[[init,2],[complete,3],[pulse,4],[pause,5],[resume,6],[dispose,7],[result,8],[key,9]].map(([n,id])=>method(n,id))];
 const pool=B(1,1,1,U(strings.length),...strings.slice(1).map(v=>{const b=Buffer.from(v);return B(U(b.length),b);}),
  U(spaces.length+1),...spaces.map(v=>B(0x16,U(s(v)))),1,U(names.length),...names.slice(1).map(([ns,n])=>B(7,U(ns),U(n))));
 const methods=[...bodies.map((_,id)=>id===8?B(0,0,0,4):B(id<2?0:1,0,...(id<2?[]:[U(cls('','Object'))]),0,0)),B(0,0,0,0)];
 // All names used in method signatures are already pooled (Object above).
 const abc=B(w(16,2),w(46,2),pool,U(methods.length),...methods,0,1,U(Class),U(Sprite),0,0,1,U(traits.length),...traits,0,0,1,10,1,U(Class),4,1,0,U(bodies.length+1),
  ...bodies.map((v,id)=>B(U(id),...v.limits.map(U),U(v.code.length),v.code,0,0)),
  10,2,1,1,8,U(script.length),script,0,0);
 const structure=swfStructure(source),headerBytes=structure.tags[0].start;
 const swfBody=B(structure.body.subarray(0,headerBytes-2),w(1,2),tag(69,w(8,4)),tag(82,B(w(0,4),0,abc)),tag(76,B(w(1,2),w(0,2),Buffer.from('LocalDesktopGame\0'))),w(64,2),w(0,2));
 return B(Buffer.from('CWS\x09','binary'),w(swfBody.length+8,4),deflateSync(swfBody));
}
export function prepareDesktop(){
 const config=JSON.parse(readFileSync('server/config/supplement-games.json')),byId=new Map(config.entries.map(e=>[e.id,e]));
 const files=[];
 for(const [resource,ids] of [['followupfish3',['fish-boy','fish-girl']],['followupcannon3',['cannon','cannon']],['followupstars3',['stars','stars']]]){
  const members=new Map();
  for(const [i,id] of ids.entries()){
   const f=byId.get(id).files[0],raw=readFileSync('server/resources/supplement-games/'+f.file);need(sha(raw)===f.sha256&&raw.length===f.size,'LOCAL_SOURCE_CHANGED');
   const kind=i?103:102,asset='game_'+kind+'.swf';
   members.set(resource+'/main_'+kind+'.swf',localDesktopWrapper(raw,asset));members.set(resource+'/'+asset,raw);
  }
  for(const [name,b] of members){const p='common/tickle2/'+name;atomic(ROOT,'analysis/candidates/gameplay-round4-20261015/local/'+p,b);files.push({path:p,size:b.length,sha256:sha(b)});}
  const b=writeZip(members),p='common/tickle2/'+resource+'.zip';atomic(ROOT,'analysis/candidates/gameplay-round4-20261015/local/'+p,b);files.push({path:p,size:b.length,sha256:sha(b)});
 }
 atomic(ROOT,'analysis/candidates/gameplay-round4-20261015/local-desktop-files.json',json(files));return files;
}
if(process.argv[1]?.endsWith('local-desktop.mjs'))console.log(JSON.stringify({localFiles:prepareDesktop().length}));
