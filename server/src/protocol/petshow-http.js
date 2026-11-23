// PetInfo.swf m5 -> PetDecoration.load(petid,-1,true), m107 and m109.
// The XML children contain z and id attributes; id is the image URL passed to Loader.
export function parsePetShowRequest(authority,target) {
  if(authority!=='web.pet.qq.com'||typeof target!=='string'||target.length>256||
    !/^\/fcgi-bin\/petshow\?[^\s\\#]+$/.test(target))throw new TypeError('PETSHOW_ROUTE_INVALID');
  const q=new URL(target,'http://web.pet.qq.com').searchParams;
  if([...q.keys()].some(k=>!['petid','level','avatar'].includes(k)||q.getAll(k).length!==1)||
    !/^[1-9][0-9]{0,19}$/.test(q.get('petid')??'')||BigInt(q.get('petid'))>0xffffffffffffffffn||
    q.get('level')!=='-1'||(q.has('avatar')&&q.get('avatar')!=='0'))throw new TypeError('PETSHOW_QUERY_INVALID');
  return {petId:q.get('petid'),...(q.has('avatar')?{includeWardrobe:false}:{})};
}
export function petShowImageRoute(authority,target) {
  return authority==='web.pet.qq.com'&&typeof target==='string'&&/^\/petinfo-image\/[a-f0-9]{64}\.png$/.test(target);
}
