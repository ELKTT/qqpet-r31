import {gamePlayerScript} from './game-player-script.js';
import {gameNavigation} from './supplement-game-navigation.js';
export function supplementGamePage(entries,selected,group,origin='collection'){
 const navigation=gameNavigation({id:selected?.id,group:selected?.group??group,origin});
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const menu=entries.filter(e=>(!group||e.group===group)&&(origin==='community'||!['carnival','adventure'].includes(e.group)&&e.id!=='room')).map(e=>'<a href="http://web.pet.qq.com/games/play.html?id='+e.id+navigation.suffix+'">'+esc(e.title)+(e.unavailable?' · 资源待补齐':e.minLevel===10?' · 成年':'')+'</a>').join('');
 const asset=selected?'http://web.pet.qq.com/games/assets/'+selected.id+'/':'';
 // The IE COM event binding must be parsed with a real, named object. Creating
 // a script with for/event attributes later does not establish that event sink.
 const player=(name,start)=>'<object id="'+name+'" name="'+name+'" style="visibility:hidden" classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000">'+(start?'<param name="movie" value="'+asset+'main.swf">':'')+'<param name="base" value="'+asset+'"><param name="allowScriptAccess" value="sameDomain"><param name="allowNetworking" value="all"><param name="quality" value="high"><param name="scale" value="showAll"><param name="FlashVars" value="base='+asset+'"></object>';
 const movie=selected&&!selected.unavailable?player('thisfla',true):'';
 const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=9"><title>'+(selected?esc(selected.title):'Q宠小游戏')+'</title><style>html,body{margin:0;height:100%;font:13px Microsoft YaHei;background:#fff9e8;color:#775632}header{height:32px;line-height:32px;padding:0 10px;background:#ffe9af}header a{float:right}#notice{height:28px;line-height:28px;padding:0 10px;white-space:nowrap;overflow:hidden}#stage{position:absolute;left:0;right:0;top:0;bottom:0;overflow:hidden}#notice{position:absolute;z-index:2;top:0;left:0;right:0;background:#fff9e8}body:not(.playing) #stage{top:60px;overflow:auto}body:not(.playing) #notice{top:32px}object{position:absolute;left:0;top:0;width:100%;height:100%}.games{padding:12px}.games a{display:inline-block;width:28%;margin:5px;padding:10px;border:1px solid #e2c279;border-radius:5px;text-decoration:none;color:#775632;background:white}</style></head><body'+(selected?' class="playing"':'')+'>'+(selected?'':'<header><b>Q宠小游戏</b></header>')+'<div id="notice">'+(selected?'正在连接宝贝…':'选择想玩的游戏')+'</div><div id="stage">'+(selected?movie:'<div class="games">'+menu+'</div>')+'</div>';
 if(!selected)return html+'</body></html>';
 if(selected.unavailable)return html+'<script>document.getElementById("notice").innerText="游戏资源尚未补齐，暂不可游玩。";</script></body></html>';
 return html+'<script>'+gamePlayerScript(selected,entries,navigation)+'</script><script language="JScript" for="thisfla" event="FSCommand(command,args)">thisfla_DoFSCommand(command,args);</script></body></html>';
}
