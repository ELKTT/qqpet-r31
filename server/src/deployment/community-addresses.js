import {createHash} from 'node:crypto';
import {BusinessAddresses,BUSINESS_AUTHORITIES} from './business-addresses.js';
import {swfLayout,swfStructure,replaceSwfStrings} from './swf-strings.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
const adobe=/^http:\/\/(?:www\.)?adobe\.com\/(?:AS3\/2006\/builtin|2006\/flex\/mx\/internal|2006\/actionscript\/flash\/(?:proxy|objectproxy))$/;
export function projectCommunityMovie(source,configuration,options={}){
  const addresses=new BusinessAddresses(configuration,options),changes=[];let output=source;
  const {abcCount}=swfLayout(source,{abcOrdinal:0});
  for(let ordinal=0;ordinal<abcCount;ordinal++){
    const replacements=new Map();
    for(const s of swfLayout(output,{abcOrdinal:ordinal}).strings){
      const before=s.bytes.toString('utf8');
      if(!/https?:\/\/[a-z0-9.-]+/i.test(before)||adobe.test(before))continue;
      const after=before.replace(/https?:\/\/([a-z0-9.-]+)(?=[/?#\]\s]|$)/gi,(_whole,host)=>{
        if(!Object.values(BUSINESS_AUTHORITIES).includes(host))throw Error('COMMUNITY_ADDRESS_HOST_UNKNOWN');
        return addresses.base(host);
      }).replace(/(\/_qqpet\/[a-z]+)(?=[?\]]|$)/g,'$1/');
      if(after!==before)replacements.set(s.index,{before,after});
    }
    if(replacements.size){const result=replaceSwfStrings(output,replacements,{abcOrdinal:ordinal});output=result.output;
      changes.push(...result.changes.map(c=>({...c,abcOrdinal:ordinal})));}
  }
  return {output,changes,inputSha256:sha(source),outputSha256:sha(output)};
}
export function applyRemoteCommunityAddresses(resources,configuration){
  const projections=[];
  for(const [name,file] of resources.files){
    if(file.contentType!=='application/x-shockwave-flash')continue;
    const structure=swfStructure(file.body);
    if(!structure.abcs.length){
      if(/(?:qq\.com|https?:\/\/)/i.test(structure.body.toString('latin1')))throw Error('COMMUNITY_AVM1_ADDRESS_UNCOVERED');
      continue;
    }
    const result=projectCommunityMovie(file.body,configuration);
    if(result.changes.length){resources.files.set(name,{...file,body:result.output});
      projections.push({name,inputSha256:result.inputSha256,outputSha256:result.outputSha256,changes:result.changes});}
  }
  resources.remoteAddressProjections=Object.freeze(projections);return resources;
}
