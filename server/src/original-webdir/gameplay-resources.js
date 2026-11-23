import {gameplayPageScript} from './gameplay-page-script.js';
import {gameplayPageStyle} from './gameplay-page-style.js';
import {medicineBoxPage} from './medicine-box-page.js';
import {friendNotificationPage} from './notification-entry-page.js';
const titles={vip:'粉钻贵族',care:'贴心宝贝',hospital:'企鹅镇医院',home:'我的温暖家园',profile:'我的资料'};
export class GameplayResources {
  resolve(host,target) {
    if(!['web.pet.qq.com','pet.qq.com','act.pet.qq.com'].includes(host)||typeof target!=='string')return null;
    const url=new URL(target,'http://'+host),route=url.pathname,q=url.searchParams;
    if(route==='/gameplay/friend-notifications.html'&&url.search==='')return {contentType:'text/html; charset=utf-8',body:Buffer.from(friendNotificationPage)};
    if(route==='/gameplay/medicine-box')return {contentType:'text/html; charset=utf-8',body:Buffer.from(medicineBoxPage)};
    let mode='buy',page=Object.keys(titles).find(p=>route==='/gameplay/'+p);
    if(['/vippay.html','/vippay.htm','/vip.html','/app/desktop_vippet.html'].includes(route))page='vip';
    if(['/autofeed.html','/autofeed.htm'].includes(route)||host==='web.pet.qq.com'&&route==='/fcgi-bin/numen'&&q.getAll('cmd').length===1&&q.get('cmd')==='2')page='care';
    if(['/hospital.html','/health.html','/fcgi-bin/hospital','/npc/npc_five.html'].includes(route))page='hospital';
    // Both community self-info and the home name link use the shared page 10012.
    if(host==='web.pet.qq.com'&&route==='/cgi-bin/homestead_shop'&&q.getAll('cmd').length===1&&['0','1'].includes(q.get('cmd'))){page='home';mode=q.get('cmd')==='1'?'owned':'buy';}
    if(host==='web.pet.qq.com'&&route==='/index10012.html')page='profile';
    if(!page)return null;
    const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>'+titles[page]+'</title><style>'+gameplayPageStyle+'</style></head><body data-page="'+page+'" data-mode="'+mode+'" data-api="http://'+host+'/gameplay/api"><div class="shell"><header><b>'+titles[page]+'</b><span>'+(page==='vip'?'宠爱每一天':page==='care'?'让陪伴更贴心':'欢迎宝贝回家')+'</span></header><div id="notice" role="status">正在看看宝贝的近况…</div><main id="content" class="content"></main><footer id="foot"><button type="button" onclick="QQPetAction(\'refresh\')">刷新</button></footer></div><script>'+gameplayPageScript+'</script></body></html>';
    return {contentType:'text/html; charset=utf-8',body:Buffer.from(html)};
  }
}
