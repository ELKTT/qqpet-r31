const carnival=new Set(['baseball','startHighJump','HighJump','startrace','racemain','rockcraft','startswim','swim','balloonstart','balloon','hunter','pie_game']);
import{parseQyxRequest}from'./qyx-game-http.js';
export function parseSupplementLegacyRequest(host,target){
 const qyx=parseQyxRequest(host,target);if(qyx)return qyx;
 if(!['act.pet.qq.com','client.pet.qq.com','web.pet.qq.com'].includes(host)||typeof target!=='string'||target.length>2048)return null;
 const u=new URL(target,'http://'+host),q=u.searchParams;
 const room=u.pathname==='/cgi-bin/duobaoqibin',name=u.pathname.split('/').at(-1);
 if(!room&&(!u.pathname.startsWith('/cgi-bin/')||!carnival.has(name)))return null;
 const bad=()=>{throw new TypeError('INVALID_SUPPLEMENT_GAME_REQUEST');};
 if([...q.keys()].some(k=>q.getAll(k).length!==1||!['cmd','id','gate','level','localtime','type','info','score','count','time','money','height','distance','result','step','gameID'].includes(k)))bad();
 for(const [k,v] of q)if(k==='id'?v!=='qq_mstx':v.length>256||!/^[0-9A-Fa-f.,_+-]*$/.test(v))bad();
 if(room){
  if(!/^(?:[1-9]|10|11)$/.test(q.get('cmd')??'')||q.has('gate')&&!/^(?:[1-9]|10)$/.test(q.get('gate'))&&!(q.get('cmd')==='1'&&q.get('gate')==='0'))bad();
  if(q.has('level')&&!/^(?:[0-9]|10)$/.test(q.get('level'))||q.has('count')&&!/^[1-9][0-9]{0,2}$/.test(q.get('count')))bad();
  if(q.has('info')&&!/^\d{30}$/.test(q.get('info'))||q.has('score')&&!/^(?:[0-9]|[1-5][0-9]|60)$/.test(q.get('score')))bad();
 }
 if(name==='hunter'&&!/^[012]$/.test(q.get('step')??''))bad();
 if(name==='pie_game'&&(q.get('cmd')!=='1'||q.get('gameID')!=='10001'))bad();
 if(['baseball','rockcraft'].includes(name)&&!/^[03]$/.test(q.get('type')??''))bad();
 if(name==='balloon'&&!/^\d{1,6}$/.test(q.get('score')??''))bad();
 return {operation:'legacy-game',game:room?'room':'carnival',command:room?Number(q.get('cmd')):name,gate:Number(q.get('gate')??1),
  ...(!room&&q.has('type')?{type:Number(q.get('type'))}:{}),
  ...(room?{...(q.has('info')?{info:q.get('info'),proof:Number(q.get('score'))}:{}),...(q.has('count')?{count:Number(q.get('count'))}:{}),
   ...(q.has('level')?{level:Number(q.get('level'))}:{}),...(q.has('localtime')?{nonce:q.get('cmd')+':'+q.get('localtime')}: {})}:{})};
}
export function encodeSupplementLegacyResponse(q,result){
 if(q.json)return {contentType:'application/json; charset=utf-8',body:Buffer.from(JSON.stringify(result))};
 // Original carnival XML.onLoad reads childNodes[0].childNodes[0/1],
 // so result and message must be the first two elements, without whitespace.
 if(q.game==='carnival')result={result:result.result,msg:result.msg??'请先登录宠物。'};
 const esc=s=>String(s).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
 return {contentType:'text/xml; charset=utf-8',body:Buffer.from('<?xml version="1.0" encoding="UTF-8"?><root>'+Object.entries(result).map(([k,v])=>'<'+k+'>'+esc(v)+'</'+k+'>').join('')+'</root>')};
}
