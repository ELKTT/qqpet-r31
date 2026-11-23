import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseToolbarRequest,toolbarJsonp,TOOLBAR_API_PATHS} from '../protocol/desktop-toolbar-http.js';
import {defaultOperationsPolicy} from '../original-data/operations-policy.js';
import {dailyActionsHtml} from './desktop-task-actions.js';
import {originalBulletinPage} from './original-bulletin-pages.js';

const origin='http://pet.qq.com';
const help={feed:'在桌面操作栏打开喂食，从背包使用一件食品。已满时不消耗物品，也不计任务。',
 clean:'在桌面操作栏打开清洁，使用一件清洁用品。',study:'从桌面操作栏开始学习，完成一节课后再刷新任务。',
 work:'从桌面操作栏开始打工，完成半小时后再刷新任务。',fish:'打开交互→玩耍→鱼塘，收获一条成熟的鱼。',
 farm:'打开交互→玩耍→农场，收获成熟作物；提前铲除不计任务。',interact:'直接点击宠物进行互动，或者在交互→玩耍里完成一次游戏。'};
// Companion pages render the same validated policy used by reward settlement.
// Native LoginPanel icons are local assets; this server view is the current prize list.
const escape=value=>String(value).replace(/[&<>"\']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const send=(res,status,body,type='text/plain; charset=utf-8')=>{
 const bytes=Buffer.isBuffer(body)?body:Buffer.from(body,'utf8');
 res.writeHead(status,{'Content-Type':type,'Content-Length':bytes.length,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',Connection:'close'});res.end(bytes);
};

export class DesktopToolbarResources {
 constructor({root=new URL('../../resources/desktop-toolbar/',import.meta.url),operations=null}={}) {
  this.operations=operations;
  this.entries=new Map();
  const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8'));
  if(manifest.schemaVersion!==1||manifest.entries.length!==31)throw Error('TOOLBAR_MANIFEST_INVALID');
  for(const e of manifest.entries) {
   if(!/^[A-Za-z0-9_.-]+$/.test(e.file)||!['pet.qq.com','act.pet.qq.com','img.pet.qq.com'].includes(e.host)||!e.path.startsWith('/'))throw Error('TOOLBAR_RESOURCE_INVALID');
   const body=readFileSync(new URL(e.file,root));
   if(createHash('sha256').update(body).digest('hex')!==e.sha256)throw Error('TOOLBAR_RESOURCE_CHANGED');
   const key=e.host+e.path;if(this.entries.has(key))throw Error('TOOLBAR_RESOURCE_DUPLICATE');
   this.entries.set(key,{body,contentType:e.contentType});
  }
 }
 // Returns false only for routes owned by another service. Sensitive headers
 // and queries on these routes never reach generic request diagnostics.
 matches(host,target) {
  let u;try{u=new URL(target,origin);}catch{return host==='act.pet.qq.com';}
  return (host==='x.pet.qq.com'&&TOOLBAR_API_PATHS.includes(u.pathname))
   ||this.entries.has(host+u.pathname)||(['pet.qq.com','act.pet.qq.com'].includes(host)&&u.pathname.startsWith('/toolbar/'));
 }
 handle(req,res,handler) {
  const host=req.headers.host;
  if(req.method!=='GET'||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0) {
   req.resume();send(res,400,'invalid toolbar request');return false;
  }
  req.resume();
  try {
   if(typeof req.url!=='string'||req.url.length>2048||!req.url.startsWith('/')||/[\x00-\x20\\#]/.test(req.url))throw Error();
   const url=new URL(req.url,origin),q=url.searchParams;
   if(host==='x.pet.qq.com'&&TOOLBAR_API_PATHS.includes(url.pathname)) {
    // cmd2/3 are historical image telemetry; never interpret them as progress.
    if(url.pathname==='/tasksvr3rd_cgi'&&['2','3'].includes(q.get('cmd'))) {
     send(res,204,'');return true;
    }
    const input=parseToolbarRequest(req.url);let data;
    try {data=handler(input,req.headers.cookie);}catch {data={result:1,ret:1,msg:'登录状态已失效，请重新登录宠物'};}
    send(res,200,toolbarJsonp(input.callback,data),'text/javascript; charset=utf-8');return true;
   }
   if([...q.keys()].some(k=>q.getAll(k).length!==1))throw Error();
   if(host==='act.pet.qq.com'&&['/toolbar/sign.html','/toolbar/growth.html'].includes(url.pathname)){
    if([...q.keys()].length)throw Error();
    res.writeHead(302,{'Location':url.pathname==='/toolbar/sign.html'?'http://pet.qq.com/app/pet_notice.html':'http://act.pet.qq.com/newsub/desktop_gifts.html','Cache-Control':'no-store','Content-Length':0});res.end();return true;
   }
   const asset=this.entries.get(host+url.pathname);
   if(asset) {
    const keys=url.pathname.endsWith('desktop_task.html')?['src']:url.pathname.endsWith('desktop_gifts.html')?['rt']:url.pathname.endsWith('pet_notice.html')?['v','rt']:['v'];
    if([...q.keys()].some(k=>!keys.includes(k))||[...q.values()].some(v=>!/^[-A-Za-z0-9_.]{0,64}$/.test(v)))throw Error();
    let body=asset.body;
    if(url.pathname.endsWith('pet_notice.html')||url.pathname.endsWith('desktop_gifts.html')){
     const p=this.operations?.snapshot?.().policy??this.operations?.value??defaultOperationsPolicy();
     body=originalBulletinPage(body,p.announcement,{sign:url.pathname.endsWith('pet_notice.html')});
    }
    if(url.pathname.endsWith('desktop_task.html'))body=Buffer.from(body.toString('utf8').replace(/(<div class="app_list"[^>]*>)[\s\S]*?<\/div>/,'$1'+dailyActionsHtml+'</div>'));
    send(res,200,body,asset.contentType);return true;
   }
   if(url.pathname==='/toolbar/no-telemetry.js') {send(res,200,'function pgvSendClick(){}','text/javascript');return true;}
   if(url.pathname==='/toolbar/telemetry-disabled') {send(res,204,'');return true;}
   if(url.pathname==='/toolbar/local-notices.js') {
    send(res,200,'/* Notice text is rendered in the original pages. */','text/javascript; charset=utf-8');return true;
   }
   if(url.pathname==='/toolbar/help.html'&&[...q.keys()].length===1&&Object.hasOwn(help,q.get('task'))) {
    send(res,200,'<!doctype html><meta charset="utf-8"><style>body{background:#fee8d6;color:#79491f;font:14px/2 sans-serif;padding:22px}</style><h3>完成任务</h3><p>'+help[q.get('task')]+'</p><a href="http://act.pet.qq.com/newsub/desktop_task.html?src=0">返回每日任务并刷新</a>','text/html; charset=utf-8');return true;
   }
   throw Error();
  }catch {send(res,400,'invalid toolbar request');return false;}
 }
}
