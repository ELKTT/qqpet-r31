const routes={oneonegame:{jianbing:'other-31',sanmingzhi:'qyx-sandwich'},downstairs:'qyx-mission',catch_fruit:'qyx-fruit',penguin_river:'qyx-river'};
const commands={other:['1','2','3'],mission:Array.from({length:13},(_,i)=>String(i)),fruit:['enter','begin','finish','store','buy','reward','achievement_hall','get_title'],river:['npc','getuser','enter','drop','report','buy','exchange','gettitle']};
export function parseQyxRequest(host,target){
 if(!['act.pet.qq.com','web.pet.qq.com','client.pet.qq.com','x.pet.qq.com'].includes(host)||typeof target!=='string'||target.length>4096||!target.startsWith('/'))return null;
 const u=new URL(target,'http://'+host),name=u.pathname==='/penguin_river'?'penguin_river':/^\/cgi-bin\/([a-z_]+)$/.exec(u.pathname)?.[1];
 if(!Object.hasOwn(routes,name??''))return null;
 const bad=()=>{throw new TypeError('INVALID_QYX_REQUEST');},p=u.searchParams;
 let game=name==='oneonegame'?routes.oneonegame[p.get('id')]:routes[name];if(!game){if(name==='oneonegame')return null;bad();}
 const kind=game==='other-31'||game==='qyx-sandwich'?'other':game.slice(4),command=p.get('cmd');if(!commands[kind].includes(command))bad();
 const allowed=['cmd','id','localtime','timer',...({other:['info','score'],mission:['level','stairs','achieveid','type'],fruit:['n','score','blood',...Array.from({length:16},(_,i)=>'type'+(i+1))],river:['stage','num','all','index','score','dna_result_key']})[kind]],params={};
 if([...p.keys()].some(k=>p.getAll(k).length!==1||!allowed.includes(k)))bad();
 for(const[k,v]of p){if(k==='cmd'||k==='id')continue;if(k==='localtime'||k==='timer'){if(!/^(?:\d{1,16}(?:\.\d{1,20})?|[1-9](?:\.\d{1,20})?e-\d{1,2})$/.test(v)||Number(v)>Number.MAX_SAFE_INTEGER)bad();continue;}
  if(k==='info'){if(!/^\d{30}$/.test(v))bad();params.info=v;}
  else if(k==='dna_result_key'){if(!/^[A-Za-z0-9_-]{1,256}$/.test(v))bad();params[k]=v;}
  else {if(!/^-?(?:0|[1-9][0-9]{0,5})$/.test(v))bad();params[k]=Number(v);}
 }
 if(params.level!==undefined&&(params.level<1||params.level>10)||params.n!==undefined&&(params.n<1||params.n>32)||params.stage!==undefined&&(params.stage<0||params.stage>4)
  ||params.stairs!==undefined&&(params.stairs<0||params.stairs>100000)||params.score!==undefined&&(params.score< -1||params.score>99999)
  ||params.num!==undefined&&(params.num<0||params.num>100000)||params.all!==undefined&&(params.all<0||params.all>100000))bad();
 const required={mission:{'2':['level'],'3':['achieveid','level'],'4':['level'],'5':['type','level'],'6':['level','stairs'],'7':['level','stairs'],'8':['type'],'9':['level'],'10':['level']},fruit:{begin:['n'],finish:['score'],buy:['n'],get_title:['n']},river:{enter:['stage'],drop:['stage','num'],report:['stage','num','all'],buy:['num'],exchange:['index']}};
 if((required[kind]?.[command]??[]).some(k=>!Object.hasOwn(params,k)))bad();
 if(kind==='other'&&command==='3'&&(!params.info||params.score===undefined))bad();
 const nonce=p.get('localtime')??p.get('timer')??null;
 const reads={other:['1'],mission:['0','1','11','12'],fruit:['enter','store','achievement_hall'],river:['npc','getuser','gettitle']};
 if(!reads[kind].includes(command)&&nonce===null)bad();
 return {operation:'legacy-game',game,command,kind,params,nonce,json:kind==='fruit'||kind==='river'};
}
