// FriendList5.0 SHA03572f87..., methods 2828/2829 and 3757/3760.
// Its MultinameA operands read XML attributes; the two request shapes differ.
const uint32=text=>/^[1-9][0-9]{0,9}$/.test(text??'')&&Number(text)<=0xffffffff;
const random=text=>typeof text==='string'&&text.length<=32&&Number.isFinite(Number(text))
  &&Number(text)>=0&&Number(text)<1000&&String(Number(text))===text;
export function parseFriendHttpRequest(authority,target) {
  if(authority!=='feed.pet.qq.com'||typeof target!=='string'||target.length>4096
      ||!target.startsWith('/fcgi-bin/desktopfeed?')||/[\x00-\x20\\#]/.test(target))
    throw new TypeError('FRIEND_ROUTE_INVALID');
  const url=new URL(target,'http://feed.pet.qq.com'),q=url.searchParams,cmd=q.get('cmd');
  const goods=q.has('random'),use=['1','2','3'].includes(cmd),game=cmd==='7',messages=['5','10'].includes(cmd);
  const allowed=cmd==='8'?['cmd','selfuin','type','petsign','timer']
    :game?['cmd','selfuin','petsign','type','winflag','puin','timer']
    :messages?['cmd','selfuin','petsign','id','random']
    :use?['cmd','selfuin','uin','petsign','goodid','random']
      :['cmd','selfuin','puin','petsign',goods?'random':'timer'];
  const timer=q.get('timer');
  if(url.pathname!=='/fcgi-bin/desktopfeed'||!['1','2','3','5','6','7','8','10'].includes(cmd)
      ||[...q.keys()].length!==allowed.length||allowed.some(key=>q.getAll(key).length!==1)
      ||[...q.keys()].some(key=>!allowed.includes(key))||!uint32(q.get('selfuin'))
      ||!/^[a-f0-9]{64}$/i.test(q.get('petsign')??'')
      ||(goods? !random(q.get('random')) : ! /^(0|-?[1-9][0-9]{0,9})$/.test(timer??'')
        ||Number(timer)<-2147483648||Number(timer)>2147483647)
      ||(cmd==='8'?q.get('type')!=='1':messages?!['1','2'].includes(q.get('id')):!uint32(q.get(use?'uin':'puin')))
      ||(use&&(!goods||!uint32(q.get('goodid'))||Number(q.get('goodid'))>0x7fffffff))
      ||(game&&(!['0','1'].includes(q.get('type'))||!['0','1'].includes(q.get('winflag')))))
    throw new TypeError('FRIEND_QUERY_INVALID');
  return {operation:cmd==='8'?'list':game?'game':messages?cmd==='5'?'messages':'clear-messages':use?'use':goods?'goods-detail':'detail',uin:Number(q.get('selfuin')),sign:q.get('petsign'),
    ...(messages?{kind:Number(q.get('id'))}:{}),
    ...(cmd==='6'||game?{targetUin:Number(q.get('puin'))}:{}),
    ...(game?{gameType:Number(q.get('type')),winFlag:Number(q.get('winflag')),timer:Number(timer)}:{}),
    ...(use?{targetUin:Number(q.get('uin')),gid:Number(q.get('goodid')),type:({1:1,2:3,3:2})[cmd],nonce:Number(q.get('random'))/1000}:{})};
}

// SendMsg95 assigns a raw UTF-8 String body, not URLVariables. Preserve +/% in
// the text; the UI excludes quotes, # and &, so its final random delimiter is
// unambiguous. Never accept credentials or command fields hidden in the text.
export function parseFriendMessageRequest(authority,target,body) {
  if(authority!=='feed.pet.qq.com'||target!=='/fcgi-bin/desktopfeed'||!Buffer.isBuffer(body)||body.length>4096)
    throw new TypeError('FRIEND_MESSAGE_ROUTE_INVALID');
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new TypeError('FRIEND_MESSAGE_BODY_INVALID');}
  const match=/^cmd=4&selfuin=([1-9][0-9]{0,9})&uin=([1-9][0-9]{0,9})&petsign=([a-f0-9]{64})&word=([^&]*)&random=([^&]+)$/i.exec(text);
  if(!match||!uint32(match[1])||!uint32(match[2])||!random(match[5]))throw new TypeError('FRIEND_MESSAGE_BODY_INVALID');
  const word=match[4].normalize('NFC').trim();
  if(!word||[...word].length>200||word.split(/\r\n|\r|\n/).length>3
      ||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f"'#&\ufffe\uffff]/.test(word))throw new TypeError('FRIEND_MESSAGE_TEXT_INVALID');
  return {operation:'send-message',uin:Number(match[1]),targetUin:Number(match[2]),sign:match[3],word,nonce:Number(match[5])/1000};
}
// GoodsList171 emits ajax twice, random rather than time, and friend=1 only
// for food/clean. Accept that exact original shape before ordinary care parsing.
export function parseFriendStoreRequest(authority,target) {
  if(authority!=='web.pet.qq.com'||typeof target!=='string'||target.length>4096||/[\s\\#]/.test(target))return null;
  const u=new URL(target,'http://web.pet.qq.com'),q=u.searchParams;
  if(u.pathname!=='/fcgi-bin/market'||!['store','pay'].includes(q.get('cmd'))||!q.has('random'))return null;
  if(q.get('cmd')==='pay') {
    const keys=['cmd','items','pay','flash','PET_UIN','PET_ID','PET_SIGN','random'];
    if([...q.keys()].length!==keys.length||keys.some(k=>q.getAll(k).length!==1)
        ||q.get('flash')!=='1'||!uint32(q.get('PET_UIN'))
        ||! /^[1-9][0-9]{0,19}$/.test(q.get('PET_ID')??'')||BigInt(q.get('PET_ID'))>0xffffffffffffffffn
        ||! /^[a-f0-9]{64}$/i.test(q.get('PET_SIGN')??'')||!random(q.get('random'))
        ||!['yb','qb','qd','qbqd','qdqb'].includes(q.get('pay'))
        ||! /^[1-9][0-9]{0,9}:[1-9][0-9]?(?:\|[1-9][0-9]{0,9}:[1-9][0-9]?){0,31}$/.test(q.get('items')??''))
      throw new TypeError('FRIEND_PURCHASE_QUERY_INVALID');
    const lines=q.get('items').split('|').map(line=>{const [cid,count]=line.split(':').map(Number);return {cid,count};});
    if(lines.some(line=>line.cid>0x7fffffff))throw new TypeError('FRIEND_PURCHASE_QUERY_INVALID');
    return {operation:'cart',lines,pay:q.get('pay'),nonce:Number(q.get('random'))/1000,
      uin:Number(q.get('PET_UIN')),petId:BigInt(q.get('PET_ID')),sign:q.get('PET_SIGN')};
  }
  const subkind=Number(q.get('subkind')??0),keys=['cmd','ajax','kind','flash','PET_UIN','PET_ID','PET_SIGN','random',
    ...(q.has('subkind')?['subkind']:[]),...(q.has('friend')?['friend']:[])];
  if([...q.keys()].length!==keys.length+1||keys.some(k=>q.getAll(k).length!==(k==='ajax'?2:1))
      ||q.getAll('ajax').some(v=>v!=='1')||q.get('kind')!=='1'||q.get('flash')!=='1'
      ||!['0','1','2'].includes(String(subkind))||(q.has('subkind')&&!['1','2'].includes(q.get('subkind')))
      ||(subkind===2?q.has('friend'):q.get('friend')!=='1')||!uint32(q.get('PET_UIN'))
      ||! /^[1-9][0-9]{0,19}$/.test(q.get('PET_ID')??'')||BigInt(q.get('PET_ID'))>0xffffffffffffffffn
      ||! /^[a-f0-9]{64}$/i.test(q.get('PET_SIGN')??'')||!random(q.get('random')))
    throw new TypeError('FRIEND_STORE_QUERY_INVALID');
  return {operation:'store',subkind,uin:Number(q.get('PET_UIN')),petId:BigInt(q.get('PET_ID')),sign:q.get('PET_SIGN')};
}
function escape(value) {
  const text=String(value);
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/.test(text))throw new TypeError('FRIEND_XML_INVALID');
  return text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
}
export function friendXmlAttributes(fields) {
  return Object.entries(fields).map(([key,value])=>{
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))throw new TypeError('FRIEND_XML_INVALID');
    return ` ${key}="${escape(value)}"`;
  }).join('');
}
export const friendXml=(fields,children='')=>
  '<?xml version="1.0" encoding="UTF-8"?><response'+friendXmlAttributes(fields)+'>'+children+'</response>';

// The two original game completion consumers use XML child nodes, not attributes.
export function friendGameXml(result,loveadd=0) {
  if(![0,1].includes(result)||![0,1].includes(loveadd))throw new TypeError('FRIEND_GAME_RESPONSE_INVALID');
  return friendXml({},'<result>'+result+'</result><loveadd>'+loveadd+'</loveadd>');
}
