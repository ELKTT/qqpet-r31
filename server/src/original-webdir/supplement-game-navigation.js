// Entry context is carried through series links. Community windows close back
// to their owner; the desktop collection owns only its own launches.
export function gameNavigation({id,group,origin='collection'}={}){
 if(!['community','collection'].includes(origin))throw new TypeError('INVALID_GAME_ORIGIN');
 const suffix='&from='+origin;
 const play=next=>'http://web.pet.qq.com/games/play.html?id='+next+suffix;
 return {origin,playPrefix:'http://web.pet.qq.com/games/play.html?id=',suffix,
  returnUrl:group==='carnival'&&id!=='carnival'?play('carnival'):
   origin==='collection'?'http://web.pet.qq.com/games/index.html':null};
}
