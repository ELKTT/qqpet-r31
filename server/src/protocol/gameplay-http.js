const operations=Object.freeze({state:[],'notice-read':[],'notice-state':[],hospital:['nonce'],'game-start':['game','nonce'],'game-pulse':['game','nonce','sequence'],'vip-buy':['plan','nonce'],'vip-boost':[],'vip-free':['kind'],'embrace-start':['nonce'],'embrace-stop':['nonce'],
  'care-switch':['enabled'],'care-settings':['settings'],'item-buy':['cid','count','nonce'],'item-use':['gid','nonce'],
  'home-state':[],'home-random':[],'home-visit':['target'],'home-accept':['target'],'home-invite':['target','nonce'],
  'home-rename':['name','nonce'],'home-buy':['background','nonce'],'home-select':['background','nonce']});
export function parseGameplayRequest(target) {
  const bad=()=>{throw new TypeError('INVALID_GAMEPLAY_REQUEST');};
  if(typeof target!=='string'||target.length>4096||!/^\/gameplay\/api\?[^\s\\#]+$/.test(target))bad();
  const q=new URL(target,'http://web.pet.qq.com').searchParams,operation=q.get('op'),required=operations[operation];
  if(!required||[...q.keys()].some(k=>q.getAll(k).length!==1||!['op',...required].includes(k))||required.some(k=>!q.has(k)))bad();
  const request={operation};
  for(const key of required) {
    const value=q.get(key);
    if(key==='game'){if(!/^[a-z0-9-]{1,40}$/.test(value))bad();request.game=value;}
    else if(['cid','gid','count','background','sequence'].includes(key)) {
      if(!/^[1-9][0-9]{0,9}$/.test(value)||Number(value)>0x7fffffff)bad();request[key]=Number(value);
    }else if(key==='target') {
      if(!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>0xffffffffffffffffn)bad();request.target=value;
    }else if(key==='enabled'){if(!['0','1'].includes(value))bad();request.enabled=value==='1';}
    else if(key==='settings'){if(value.length>512)bad();try{request.settings=JSON.parse(value);}catch{bad();}}
    else if(key==='nonce'&&operation.startsWith('item-')) {
      if(!/^[1-9][0-9]{0,15}$/.test(value)||!Number.isSafeInteger(Number(value)))bad();request.nonce=Number(value);
    }else if(key==='nonce'){if(!/^[A-Za-z0-9_-]{8,64}$/.test(value))bad();request.nonce=value;}
    else if(key==='kind'){if(!['feed','clean','medicine'].includes(value))bad();request.kind=value;}
    else if(key==='plan'){if(!['trial','month','year'].includes(value))bad();request.plan=value;}
    else if(key==='name'){if(!value.trim()||value.length>32||/[<>\x00-\x1f]/.test(value))bad();request.name=value;}
  }
  if(request.count>99)bad();return request;
}
