// E-132: current DailyTask URLs and version-pinned cached JSONP consumers.
const bad=()=>{throw new TypeError('TOOLBAR_REQUEST_INVALID');};
const decimal=(s,max)=>typeof s==='string'&&/^(0|[1-9][0-9]*)$/.test(s)&&BigInt(s)<=BigInt(max);
export const TOOLBAR_API_PATHS=Object.freeze(['/tasksvr3rd_cgi','/toolbarsign','/petgrow']);
export function parseToolbarRequest(target) {
  if(typeof target!=='string'||target.length>2048||!/^\/[a-z0-9_]+\?/.test(target)||/[\s\\#]/.test(target))bad();
  const u=new URL(target,'http://x.pet.qq.com'),q=u.searchParams;
  if(!TOOLBAR_API_PATHS.includes(u.pathname)||[...q.keys()].some(k=>q.getAll(k).length!==1))bad();
  const callback=q.get('callback');
  // A JSONP callback is one identifier, never a property expression or code.
  if(!/^[A-Za-z_$][A-Za-z0-9_$]{0,95}$/.test(callback??''))bad();
  if(q.has('_')&&!decimal(q.get('_'),Number.MAX_SAFE_INTEGER))bad();
  const check=(required=[],optional=[])=>{
    if(required.some(k=>!q.has(k))||[...q.keys()].some(k=>!['cmd','callback','_',...required,...optional].includes(k)))bad();
  };
  let operation,value;
  const cmd=q.get('cmd');
  if(u.pathname==='/toolbarsign') {
    check();operation={GetUser:'signInfo',Sign:'sign',Gift:'signGift',Fuceng:'signTips'}[cmd];
  } else if(u.pathname==='/petgrow') {
    check();operation={GetUser:'growthInfo',Random:'growthGift'}[cmd];
  } else if(cmd==='5') {
    check(['from']);if(!['0','1','2','5','6','7'].includes(q.get('from')))bad();operation='tasks';
  } else if(cmd==='1') {
    check(['type'],['value']);
    operation={'1':'taskGift','2':'activityGift','3':'loginGift'}[q.get('type')];
    if(operation!=='loginGift'&&!q.has('value'))bad();
    if(q.has('value')) {if(!decimal(q.get('value'),65535))bad();value=Number(q.get('value'));}
  } else if(cmd==='101') {check();operation='onlineInfo';}
  else if(cmd==='102') {check(['pkg']);if(q.get('pkg')!=='0')bad();operation='onlineGift';}
  if(!operation)bad();
  return {operation,...(value===undefined?{}:{value}),callback};
}

export function parseToolbarCookies(header) {
  if(typeof header!=='string'||header.length>8192||/[\r\n\0]/.test(header))bad();
  const values=new Map();
  for(const part of header.split(';')) {
    const p=part.trim(),i=p.indexOf('=');if(i<0)continue;
    const k=p.slice(0,i);if(!['PET_UIN','PET_ID','PET_SIGN'].includes(k))continue;
    if(values.has(k))bad();
    let value;try{value=decodeURIComponent(p.slice(i+1));}catch{bad();}values.set(k,value);
  }
  const uin=values.get('PET_UIN'),petId=values.get('PET_ID'),sign=values.get('PET_SIGN');
  if(!decimal(uin,0xffffffff)||uin==='0'||!decimal(petId,0xffffffffffffffffn)||petId==='0'||!/^[a-f0-9]{64}$/i.test(sign??''))bad();
  return {uin:Number(uin),petId:BigInt(petId),sign};
}

export function toolbarJsonp(callback,data) {
  if(!/^[A-Za-z_$][A-Za-z0-9_$]{0,95}$/.test(callback))bad();
  return Buffer.from(callback+'('+JSON.stringify(data).replace(/[<>&\u2028\u2029]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))+');','utf8');
}
