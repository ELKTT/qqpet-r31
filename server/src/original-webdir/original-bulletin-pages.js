const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Keep the accepted original pages, controls, API calls and background bytes.
// bg.jpg divides at y=232; gonggao.jpg divides at y=193.
export function originalBulletinPage(original,announcement,{sign=false}={}){
 const a=announcement,title=escape(a.title),upper=a.enabled?a.body:'暂无公告。',lower=a.enabled?a.secondaryBody:'';
 const paper='<div class="notice-paper"></div><div class="'+(sign?'notice-calendar-paper':'notice-top-paper')+'"></div>';
 const palette='<style type="text/css">body{background:#fff9e8}.wrap{position:relative}.notice-paper,.notice-calendar-paper,.notice-top-paper{position:absolute;background:#fffdf4}.notice-paper{left:'+(sign?10:14)+'px;top:'+(sign?11:47)+'px;width:'+(sign?377:411)+'px;height:'+(sign?332:292)+'px}.notice-paper:after{content:"";position:absolute;left:'+(sign?198:12)+'px;top:'+(sign?182:184)+'px;width:'+(sign?174:398)+'px;border-top:3px dotted #ddd7c7}.notice-calendar-paper{left:391px;top:196px;width:176px;height:147px}.notice-top-paper{left:0;top:0;width:576px;height:43px}</style>';
 const content='<h1 class="notice-title">'+title+'</h1><div class="DeskPos"><div class="notice-upper" data-notice="upper">'+escape(upper)+'</div><div class="notice-lower" data-notice="lower">'+escape(lower)+'</div></div>\n<div class="GiftPos">';
 const style='<style type="text/css">.notice-title{position:absolute;left:'+(sign?17:26)+'px;top:'+(sign?18:10)+'px;margin:0;color:#79491f;font:bold 18px/26px SimSun,serif}.DeskPos{left:'+(sign?17:26)+'px;top:'+(sign?49:53)+'px;width:'+(sign?355:390)+'px;height:'+(sign?280:279)+'px;color:#79491f;font:12px/22px SimSun,serif}.notice-upper,.notice-lower{position:absolute;left:0;width:100%;overflow:auto;white-space:pre-wrap;word-wrap:break-word}.notice-upper{top:0;height:'+(sign?134:170)+'px}.notice-lower{top:'+(sign?154:190)+'px;height:'+(sign?126:89)+'px}</style>';
 const read='<script type="text/javascript">(function(){var x=new XMLHttpRequest();x.open("GET","http://web.pet.qq.com/gameplay/api?op=notice-read",true);x.setRequestHeader("X-QQPet-Gameplay","1");x.send(null);})();</script>';
 let html=original.toString('utf8').replace('<div class="wrap">','<div class="wrap">'+paper).replace(/<div class="DeskPos">[\s\S]*?<div class="GiftPos">/,content)
  .replace(/\$\.getScript\('\/toolbar\/local-notices\.js'\)/g,'void 0')
  .replace('</head>',palette+style+'</head>').replace('</html>',read+'</html>');
 if(sign)html=html.replace('"签到28天奖励：","规则："','"签到28天奖励：","全勤奖励："');
 if(!sign)html=html.replace('var num=json.msg.replace(/[^0-9]/ig,"");',
  'var num=parseInt(json.growth,10);if(!isFinite(num)||num<0){var primary=String(json.msg||"").match(/[0-9]+/);num=primary?parseInt(primary[0],10):0;}num=Math.max(0,Math.min(999,num));');
 if(!html.includes('data-notice="upper"')||!html.includes('data-notice="lower"'))throw Error('ORIGINAL_BULLETIN_LAYOUT_CHANGED');
 return Buffer.from(html);
}
