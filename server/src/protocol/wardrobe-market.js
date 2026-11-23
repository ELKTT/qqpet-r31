import {MarketHtmlError,escapeMarketHtmlText} from './market-html.js';

export function parseWardrobeSave(q) {
  for(const key of q.keys())if(!['cmd','avatar','shows'].includes(key))throw new MarketHtmlError('WARDROBE_SAVE_INVALID','unknown save field');
  const avatar=q.get('avatar'),shows=q.get('shows');
  if(avatar===null||shows!==''||avatar.length>180)throw new MarketHtmlError('WARDROBE_SAVE_INVALID','unsupported or missing selection');
  const parts=avatar===''?[]:avatar.split('|'),seats=new Set();
  if(parts.length>9)throw new MarketHtmlError('WARDROBE_SAVE_INVALID','too many positions');
  const avatars=parts.map(part=>{
    const match=/^([1-9]):([1-9][0-9]{0,4})$/.exec(part);
    if(!match||Number(match[2])>65535||seats.has(Number(match[1])))throw new MarketHtmlError('WARDROBE_SAVE_INVALID','invalid or repeated position');
    seats.add(Number(match[1]));return Object.freeze({seat:Number(match[1]),resourceId:Number(match[2])});
  });
  return Object.freeze({operation:'avatar-save',avatars:Object.freeze(avatars),shows:Object.freeze([])});
}
export function wardrobeSeat(operation,kind,subkind) {
  if(operation==='shop'&&kind===2&&Number.isInteger(subkind)&&subkind>=0&&subkind<=8)return subkind+1;
  if(operation==='store'&&kind===0&&Number.isInteger(subkind)&&subkind>=0&&subkind<=9)return subkind;
  return null;
}
export function projectWardrobeMarketItem(i) {
  const text=v=>escapeMarketHtmlText(String(v));
  return {struct:'AvatarConf',kind:'30',ckind:20+i.seat,cid:text(i.cid),gid:text(i.gid),name:text(i.name),desc:text(i.desc||'永久装扮'),info:text(i.desc||'永久装扮'),
    pos:i.seat,rid:i.resourceId,did:i.resourceId,price:'1',price_vip:'1',sell_pay:'yb',sell_vip:0,vip:0,marry:0,spec:'100',
    level_min:i.level_min??0,level_max:i.level_max??0,pic_flag:0,num:'1',suit:0,permanent:true,sequence_url:i.sequenceUrl,icon_url:i.iconUrl,charm:0,intel:0,strong:0};
}
