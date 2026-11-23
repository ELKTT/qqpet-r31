import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectCommunityMovie} from '../deployment/community-addresses.js';

export const NATIVE_AVATAR_MOVIE=Object.freeze({source:'common/avatarpreview.swf',
  route:'/common/market/avatarpreview.swf',bytes:653829,
  sha256:'28b182b4b3237e67c5e4dfd476bdb156c2f5d21233c0748567b07b4991d2fba1'});

// Serve the inherited original movie in the HTTP page's domain. Reuse the
// existing deployment projection for URL constants; executable ABC is retained.
export async function loadNativeAvatarPreviewMovie(root,deploymentEndpoints){
  const file=await realpath(path.join(root,NATIVE_AVATAR_MOVIE.source));
  if(path.relative(root,file).split(path.sep).join('/')!==NATIVE_AVATAR_MOVIE.source)
    throw new TypeError('MARKET_AVATAR_MOVIE_OUTSIDE_ROOT');
  if((await stat(file)).size!==NATIVE_AVATAR_MOVIE.bytes)
    throw new TypeError('MARKET_AVATAR_MOVIE_CHANGED');
  const source=await readFile(file);
  if(source.length!==NATIVE_AVATAR_MOVIE.bytes
    ||createHash('sha256').update(source).digest('hex')!==NATIVE_AVATAR_MOVIE.sha256)
    throw new TypeError('MARKET_AVATAR_MOVIE_CHANGED');
  const projected=deploymentEndpoints?projectCommunityMovie(source,deploymentEndpoints,{allowLoopback:true}):null;
  const body=projected?.output??source;
  return {source:NATIVE_AVATAR_MOVIE.route.slice(1),body,
    sha256:createHash('sha256').update(body).digest('hex'),transform:'none',
    inputSha256:NATIVE_AVATAR_MOVIE.sha256,inputBytes:source.length,changes:projected?.changes??[]};
}

// Approved 2026-10-10: register the existing original provider and forward the
// served preview calls. This rule set is explicit and default-off at the loader.
export function nativeAvatarPreviewRules(rules,{wardrobeEnabled=false}={}) {
  const index=rules.findIndex(rule=>rule.id==='R2'&&rule.file==='frame.htm');
  const rule=rules[index];
  if(!rule||rule.edits.length!==6
    ||!rule.edits[0].find.includes('id="avatarPreview"')
    ||rule.edits[1].find!=='        avatarPreview.api_on_getavatar(v1,v2,v3);'
    ||rule.edits[2].find!=='        nTask=window.external.api_getavatar(nSeat,nResID);'
    ||!rule.edits[5].find.startsWith('avatarPreview.LoadMovie(0,'))
    throw new TypeError('MARKET_AVATAR_PREVIEW_RULES_CHANGED');
  const callback='    function api_on_getavatar(v1,v2,v3)';
  const remember=wardrobeEnabled
    ? '\r\n        if(nTask>0 && nSeat>=1 && nSeat<=9 && Math.floor(nSeat)==nSeat'
      +' && nResID>0 && nResID<=65535 && Math.floor(nResID)==nResID)\r\n'
      +'        {\r\n            if(!api_getavatar.tasks) api_getavatar.tasks={};\r\n'
      +'            api_getavatar.tasks[nTask]=nSeat+"/"+nResID;\r\n        }'
    : '';
  const complete=wardrobeEnabled
    ? '        var tasks=api_getavatar.tasks, resource=tasks && tasks[taskId];\r\n'
      +'        if(resource)\r\n        {\r\n            delete tasks[taskId];\r\n'
      +'            if(result==1) resourcePath=window.location.protocol+"//"+window.location.host\r\n'
      +'                +window.location.pathname.replace(/[^/]*$/,"avatar/")+resource+".png";\r\n        }\r\n'
    : '';
  const bridge={id:'AVATAR-PREVIEW',file:'frame.htm',edits:[
    // BrowserEngine passes COM's reversed DISPPARAMS to the provider unchanged.
    // AF50 consumes rgvarg[0] as seat and rgvarg[1] as resource, so the script
    // method takes resource first. Keep task-to-sequence identity in Flash order.
    {find:rule.edits[2].find,replace:'        nTask=window.external.Avatar_GetAvatarRes(nResID,nSeat);'+remember,count:1},
    // ADD0 writes task/result/path into DISPPARAMS; BrowserEngine 1F10/58E0
    // forward it unchanged to MSHTML, so JavaScript receives path/result/task.
    // Restore Flash's task/result/path order only at this native callback seam.
    {find:callback,replace:'    function Avatar_OnGetAvatarRes(resourcePath,result,taskId)\r\n'
      +'    {\r\n'+complete+'        return api_on_getavatar(taskId,result,resourcePath);\r\n    }\r\n'+callback,count:1},
    {find:rule.edits[5].find,replace:'avatarPreview.LoadMovie(0,window.location.protocol+"//"+window.location.host'
      +'+window.location.pathname.replace(/[^/]*$/,"avatarpreview.swf")) ;\r\n',count:1}
  ]};
  // Keep the existing use-toy and pet-info policies; only restore the preview.
  const result=[...rules.slice(0,index),{...rule,edits:[rule.edits[3],rule.edits[4]]},bridge,...rules.slice(index+1)];
  const frameIndex=result.findIndex(r=>r.id==='R2'&&r.file==='frame.js'),frame=result[frameIndex];
  if(!frame||frame.edits.length!==1||frame.edits[0].find!=='\t\tavatarPreview.changeAvartar(strAvatar);')
    throw new TypeError('MARKET_AVATAR_PREVIEW_RULES_CHANGED');
  // Invoke the original Flash IDispatch method directly. Reading a COM method
  // as a JavaScript property is not a reliable capability check in MSHTML.
  result[frameIndex]={...frame,edits:[]};
  return result;
}
