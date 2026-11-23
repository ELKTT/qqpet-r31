// The native DailyTask bubble also opens /task?src=2 directly. Its companion
// page reuses the original BrowseMsg movie and the original friend HTTP store.
// The two identity fields come from the client's existing same-origin Cookie,
// never from an embedded sample account or an extra credential issued here.
export const friendNotificationPage=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=9"><title>好友互动</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#f2f7fa}object{display:block;width:100%;height:100%}</style><script>
function noticeCookie(name){var a=document.cookie.split(';');for(var i=0;i<a.length;i++){var p=a[i].replace(/^ +/,''),n=p.indexOf('=');if(p.substring(0,n)===name)return p.substring(n+1);}return '';}
function SNS_GetSelfPetInfo(){return {qqnumber:Number(noticeCookie('PET_UIN')),petid:noticeCookie('PET_ID'),qqsign:noticeCookie('PET_SIGN')};}
var API={Show:function(visible){if(!visible)window.close();},EnableDrag:function(){},ResizeWindow:function(){},MoveTo:function(){}};
function friendNotice_DoFSCommand(command,args){if(/^(quit|close|exit)$/i.test(String(command)))window.close();}
</script></head><body><object id="friendNotice" name="friendNotice" classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"><param name="movie" value="http://web.pet.qq.com/gameplay/friend-messages.swf"><param name="allowScriptAccess" value="sameDomain"><param name="allowNetworking" value="all"><param name="scale" value="showAll"><param name="quality" value="high"></object><script language="JScript" for="friendNotice" event="FSCommand(command,args)">friendNotice_DoFSCommand(command,args);</script></body></html>`;
