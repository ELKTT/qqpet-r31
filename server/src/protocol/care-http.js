// E-105: manifest-pinned marketstore.swf and quick.swf GET contracts.
import {parseFriendStoreRequest} from './friend-http.js';
const uint=(s,max)=>typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=BigInt(max);
// quick.swf method 377 appends Math.random(); marketstore uses a Date clock.
// This is a cache buster, not a monotonically increasing transaction sequence.
export const validCareNonce=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0
  &&(n<1||Number.isSafeInteger(n));
function cacheBuster(s) {
  return typeof s==='string'&&s.length<=32&&/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e-[0-9]+)?$/.test(s)&&validCareNonce(Number(s));
}
export function parseCareHttpRequest(authority,target) {
  const friendStore=parseFriendStoreRequest(authority,target);if(friendStore)return friendStore;
  if(!['x.pet.qq.com','web.pet.qq.com'].includes(authority)||typeof target!=='string'
      ||target.length>4096||!/^\/[a-z_/-]+\?[^#\s]*$/.test(target))throw new TypeError('CARE_REQUEST_INVALID');
  const url=new URL(target,'http://'+authority),q=url.searchParams;
  if([...q.keys()].some(k=>q.getAll(k).length!==1))throw new TypeError('CARE_QUERY_DUPLICATE');
  const base=['cmd','PET_UIN','PET_ID','PET_SIGN','time'];
  if(!uint(q.get('PET_UIN'),0xffffffff)||q.get('PET_UIN')==='0'
      ||!uint(q.get('PET_ID'),0xffffffffffffffffn)||q.get('PET_ID')==='0'
      ||! /^[A-Fa-f0-9]{64}$/.test(q.get('PET_SIGN')??'')||!cacheBuster(q.get('time')))
    throw new TypeError('CARE_IDENTITY_INVALID');
  const check=(extra,optional=[])=>{
    if([...base,...extra].some(k=>!q.has(k))||[...q.keys()].some(k=>![...base,...extra,...optional].includes(k)))
      throw new TypeError('CARE_QUERY_INVALID');
  };
  let operation,fields={};
  const cmd=q.get('cmd'),market=authority==='x.pet.qq.com'?url.pathname==='/market':url.pathname==='/fcgi-bin/market';
  if(authority==='web.pet.qq.com'&&!(url.pathname==='/fcgi-bin/market'&&cmd==='store'))throw new TypeError('CARE_ROUTE_INVALID');
  if(authority==='x.pet.qq.com'&&url.pathname==='/vip_platform'&&['get_pet_base','set_pet_base'].includes(cmd)) {
    check(cmd==='set_pet_base'?['type']:[]);
    if(cmd==='set_pet_base'&&!['1','2','3','4'].includes(q.get('type')))throw new TypeError('CARE_TYPE_INVALID');
    operation=cmd==='get_pet_base'?'vip-native-info':'vip-native-use';
    if(cmd==='set_pet_base')fields.type=Number(q.get('type'));
  }else if(market&&['shop','store'].includes(cmd)) {
    check(['ajax','flash','kind'],['page','subkind']);
    if(['ajax','flash','kind'].some(k=>q.get(k)!=='1')||(q.has('page')&&q.get('page')!=='1')
        ||(q.has('subkind')&&!(authority==='x.pet.qq.com'?['0','1','2','3']:['0','1','2']).includes(q.get('subkind'))))throw new TypeError('CARE_LIST_INVALID');
    operation=cmd;fields.subkind=Number(q.get('subkind')??0);
    // Only the patched marketstore uses four tabs. Legacy quick and HTML keep
    // their existing projections; this marker is not accepted from the query.
    if(authority==='x.pet.qq.com')fields.categoryView='native-four-tabs';
  }else if(url.pathname==='/market'&&cmd==='pay') {
    check(['pay','items','type']);
    // Real-money and asking another user to pay are deliberately not executable.
    if(!['yb','qdqb'].includes(q.get('pay'))||!/^([1-9][0-9]{0,9}):([1-9][0-9]{0,3})$/.test(q.get('items')))
      throw new TypeError('CARE_PURCHASE_INVALID');
    const [cid,count]=q.get('items').split(':').map(Number);
    operation='buy';fields={cid,count,pay:q.get('pay'),type:Number(q.get('type'))};
  }else if(url.pathname==='/web_feed'&&cmd==='base') {
    check(['goodid','type']);
    if(!uint(q.get('goodid'),0x7fffffff)||q.get('goodid')==='0')throw new TypeError('CARE_ITEM_INVALID');
    operation='use';fields={gid:Number(q.get('goodid')),type:Number(q.get('type'))};
  }else if(url.pathname==='/study'&&['recommend_course','begin_study'].includes(cmd)) {
    check(cmd==='begin_study'?['client','id']:['client']);
    if(q.get('client')!=='1'||(cmd==='begin_study'&&(!uint(q.get('id'),0x7fffffff)||q.get('id')==='0')))
      throw new TypeError('CARE_STUDY_INVALID');
    operation=cmd==='begin_study'?'study':'courses';if(operation==='study')fields.id=Number(q.get('id'));
  }else if(url.pathname==='/work'&&['best_work','start_work'].includes(cmd)) {
    check(cmd==='start_work'?['client','job_id','count']:['client']);
    if(q.get('client')!=='1'||(cmd==='start_work'&&(!uint(q.get('job_id'),0x7fffffff)
        ||q.get('job_id')==='0'||!['1','2'].includes(q.get('count')))))throw new TypeError('CARE_WORK_INVALID');
    operation=cmd==='start_work'?'work':'jobs';if(operation==='work')fields={id:Number(q.get('job_id')),count:Number(q.get('count'))};
  }else throw new TypeError('CARE_ROUTE_INVALID');
  if(['buy','use'].includes(operation)&&!['1','2','3','4'].includes(q.get('type')))throw new TypeError('CARE_TYPE_INVALID');
  return {operation,...fields,nonce:Number(q.get('time')),uin:Number(q.get('PET_UIN')),petId:BigInt(q.get('PET_ID')),sign:q.get('PET_SIGN')};
}
