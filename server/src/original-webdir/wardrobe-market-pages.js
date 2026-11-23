const edit=(find,replace,count=1)=>({find,replace,count});

// Approved local catalogue uses the original AvatarConf try-on/cart/save paths.
// Thumbnails display the first tile of the sequence without guessing icon names.
export function wardrobeMarketRules(rules) {
  const result=rules.filter(r=>r.id!=='R20');
  if(result.length!==rules.length-2)throw new TypeError('WARDROBE_MARKET_RULES_CHANGED');
  // Original aSubPics already covers the nine seats (and store's all-items tab).
  // Keep its image buttons, selected state and navigation unchanged.
  const pic='function PicString(item, click_pic, mouse_over_pic, mouse_out_pic)\r\n{\r\n';
  const picture=`    if(item.struct=="AvatarConf" && item.icon_url) {\r\n`
    +`        return '<img src="'+item.icon_url+'" style="width:50px;height:50px;border:0;cursor:pointer" alt="'+item.name+'" onclick="'+click_pic+'" onmouseover="'+mouse_over_pic+'" onmouseout="'+mouse_out_pic+'" />';\r\n    }\r\n`
    +`    if(item.struct=="AvatarConf" && item.sequence_url) {\r\n`
    +`        return '<span style="display:block;position:relative;width:50px;height:50px;overflow:hidden;cursor:pointer" onclick="'+click_pic+'" onmouseover="'+mouse_over_pic+'" onmouseout="'+mouse_out_pic+'"><img src="'+item.sequence_url+'" style="position:absolute;left:0;top:0;width:300px;height:400px;max-width:none;border:0" alt="'+item.name+'" /></span>';\r\n    }\r\n`;
  const duration='    if(item.struct=="AvatarConf" && item.permanent) return "\\u4f7f\\u7528\\u671f\\u9650:<b>\\u6c38\\u4e45</b>";\r\n';
  result.push({id:'WARDROBE',file:'market.js',edits:[edit("\t\talert('this.url='+this.url);\r\n",''),edit(pic,pic+picture),
    ...['EffectString2','TipsEff1Str','TipsEff1StrStore'].map(name=>{const head=`function ${name}(item)\r\n{\r\n`;return edit(head,head+duration);})]});
  const callback='    var buyjson = GetJSON(resp_text);\r\n';
  result.push({id:'WARDROBE',file:'frame.js',edits:[edit(callback,callback
    +'    if(buyjson && buyjson.result==0 && buyjson.data && buyjson.data.refreshRequired) {\r\n'
    +'        market_alt_ok("\\u5df2\\u5904\\u7406\\uff0c\\u8bf7\\u5237\\u65b0\\u4ed3\\u5e93\\u786e\\u8ba4");\r\n        UpdateStore();return;\r\n    }\r\n',2)]});
  const type='function shopTypeName(idx)\r\n{\r\n';
  result.push({id:'WARDROBE',file:'cart.js',edits:[edit(type,'shopTypes["29"]="\\u9876\\u90e8";\r\n'+type),
    // Keep display names in the cart. The native payment request uses the
    // existing cid:quantity form, with every price decided by the server.
    edit('ShopCart.prototype.computePrice = function()',
      'ShopCart.prototype.paymentItems = function()\r\n{\r\n'
      +'    var lines = [];\r\n'
      +'    for(var i=0; i<this.items.length; ++i)\r\n'
      +'        lines.push(this.items[i].id+":"+this.items[i].num);\r\n'
      +'    return lines.join("|");\r\n}\r\n\r\n'
      +'ShopCart.prototype.computePrice = function()')]});
  result.push({id:'WARDROBE',file:'shoppingcart.html',edits:[edit(
    "strurl = 'http://web.pet.qq.com/fcgi-bin/market?cmd=pay&items='+getCartData().replace(/(^\\s*)|(\\s*$)/g, \"\");",
    "strurl = 'http://web.pet.qq.com/fcgi-bin/market?cmd=pay&items='+CartData.paymentItems();")]});
  return result;
}
