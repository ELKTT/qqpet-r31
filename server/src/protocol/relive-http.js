export function parseReliveRequest(target){
 const bad=()=>{throw new TypeError('INVALID_RELIVE_REQUEST');};
 if(typeof target!=='string'||target.length>512||!/^\/fcgi-bin\/revival\?[^\s#\\]+$/.test(target))bad();
 const q=new URL(target,'http://web.pet.qq.com').searchParams,keys=['cmd','random','PET_UIN','PET_ID','PET_SIGN'];
 if([...q.keys()].length!==5||keys.some(k=>q.getAll(k).length!==1)||q.get('cmd')!=='1')bad();
 const random=q.get('random'),uin=q.get('PET_UIN'),id=q.get('PET_ID'),sign=q.get('PET_SIGN');
 if(!/^(?:0(?:\.[0-9]{1,20})?|[1-9](?:\.[0-9]{1,20})?e-[1-9][0-9]?)$/.test(random)
  ||!/^[1-9][0-9]{0,9}$/.test(uin)||BigInt(uin)>0xffffffffn||!/^[1-9][0-9]{0,19}$/.test(id)||BigInt(id)>0xffffffffffffffffn||!/^[a-f0-9]{64}$/i.test(sign))bad();
 return {request:{operation:'game-recover',nonce:'relive-'+random.replace('.','_')},cookie:`PET_UIN=${uin}; PET_ID=${id}; PET_SIGN=${sign}`};
}
