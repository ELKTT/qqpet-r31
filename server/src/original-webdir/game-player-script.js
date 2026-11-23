export function gamePlayerScript(selected,entries,navigation){
 const games=Object.fromEntries(entries.filter(e=>!e.unavailable).map(e=>[e.id,{group:e.group,title:e.title}]));
 return `(function(){
window.getCookie=function(name){var parts=document.cookie.split(';');for(var i=0;i<parts.length;i++){var p=parts[i].replace(/^ +/,''),at=p.indexOf('=');if(p.substring(0,at)===name)return p.substring(at+1);}return '';};
var games=${JSON.stringify(games)},origin=${JSON.stringify(navigation.origin)},game=${JSON.stringify(selected.id)},nonce=makeNonce(),sequence=0,active='thisfla',busy=false,ready=false,closed=false,loading=false,loadTimer=null,pulseTimer=null,queued=null;
function makeNonce(){return 'play-'+new Date().getTime()+'-'+Math.floor(Math.random()*1000000);}
function notice(text){var n=document.getElementById('notice');n.innerText=text;n.style.display='block';}
function dispose(){if(closed)return;closed=true;ready=false;if(loadTimer!==null)clearInterval(loadTimer);if(pulseTimer!==null)clearInterval(pulseTimer);document.getElementById('stage').innerHTML='';}
function api(op,id,key,seq,done){
 if(busy||closed)return;busy=true;var x=new XMLHttpRequest();
 x.open('GET','http://web.pet.qq.com/gameplay/api?op='+op+'&game='+id+'&nonce='+key+(op==='game-pulse'?'&sequence='+seq:''),true);x.setRequestHeader('X-QQPet-Gameplay','1');
 x.onreadystatechange=function(){if(x.readyState!==4||closed)return;busy=false;var r;try{r=JSON.parse(x.responseText);}catch(e){notice('连接中断，请重新打开游戏');ready=false;return;}
 done(r);if(queued&&!closed&&!busy&&!loading){var next=queued;queued=null;window.qqpetGameNavigate(next);}};x.send(null);
}
function exitWindow(){
 var target=origin==='collection'?'http://web.pet.qq.com/games/index.html':null;
 dispose();if(target)window.location.replace(target);else window.close();
}
window.qqpetGameClose=function(){
 if(closed)return;
 if(!loading&&games[game].group==='carnival'&&game!=='carnival'){window.qqpetGameNavigate('carnival');return;}
 exitWindow();
};
window.closeFrame=window.closeWindow=window.qqpetGameClose;
window.qqpetGameNavigate=function(id){
 id=String(id);if(closed||loading||!Object.prototype.hasOwnProperty.call(games,id)||!/^(?:carnival(?:-[0-9]+)?|room)$/.test(id))return;
 if(busy){queued=id;return;}var key=makeNonce();loading=true;ready=false;
 api('game-start',id,key,0,function(r){
  if(r.result!==0){loading=false;if(id==='carnival'&&game!=='carnival'){exitWindow();return;}notice(r.msg);return;}
  var element=document.getElementById('thisfla'),player=element.object||element,started=new Date().getTime();
  try{player.Base='http://web.pet.qq.com/games/assets/'+id+'/';player.LoadMovie(0,player.Base+'main.swf');}catch(e){loading=false;notice('游戏未能加载，请重新打开');return;}
  loadTimer=setInterval(function(){
   if(closed)return;var loaded=false;try{loaded=player.PercentLoaded()===100;}catch(e){}
   if(!loaded){if(new Date().getTime()-started>20000){clearInterval(loadTimer);loadTimer=null;loading=false;notice('游戏加载超时，请重新打开');}return;}
   clearInterval(loadTimer);loadTimer=null;
   game=id;nonce=key;sequence=r.sequence;loading=false;ready=true;document.title=games[id].title;document.getElementById('notice').style.display='none';
   // Reuse one initialized ActiveX object and its parsed FSCommand sink.
   // A second empty windowed control can cover the visible movie and miss clicks.
  },30);
 });
};
window.DoFSCommand=function(command,args){if(closed)return;if(String(command)==='qqpet.unavailable'){window.alert('这个旧节日活动暂缺配套资源。');return;}if(String(command)==='qqpet.navigate'){window.qqpetGameNavigate(args);return;}if(/^(qqpet\\.return|quit|close|exit|back|return)$/i.test(String(command)))window.qqpetGameClose();};
window.qqpetDispatch=function(source,command,args){if(source===active)window.DoFSCommand(command,args);};
window.thisfla_DoFSCommand=window.thisfla_FSCommand=function(c,a){window.qqpetDispatch('thisfla',c,a);};

window.addEventListener?window.addEventListener('beforeunload',dispose,false):window.attachEvent('onbeforeunload',dispose);
api('game-start',game,nonce,0,function(r){if(r.result!==0){notice(r.msg);return;}sequence=r.sequence;document.getElementById('notice').style.display='none';document.getElementById(active).style.visibility='visible';ready=true;});
pulseTimer=setInterval(function(){if(!ready||busy||loading||closed||document.hidden||document.hasFocus&&!document.hasFocus())return;var f=document.getElementById(active);try{if(!f||typeof f.PercentLoaded==='undefined'||f.PercentLoaded()<100)return;}catch(e){return;}api('game-pulse',game,nonce,sequence+1,function(r){if(r.result!==0){ready=false;notice(r.msg);return;}sequence=r.sequence;});},10000);
})();`;
}
