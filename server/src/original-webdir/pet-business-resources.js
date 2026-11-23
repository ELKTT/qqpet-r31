import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// A finite server resource set selected by the user. No filesystem path or
// external URL from a request is ever opened.
export class PetBusinessResources {
  constructor(root=new URL('../../resources/pet-business/',import.meta.url)) {
    this.entries=new Map();const manifest=new URL('manifest.json',root);
    if(!existsSync(manifest))return;
    const doc=JSON.parse(readFileSync(manifest,'utf8'));
    if(doc.version!==1||!Array.isArray(doc.entries)||doc.entries.length>2048)throw new Error('BUSINESS_RESOURCE_MANIFEST_INVALID');
    for(const e of doc.entries) {
      if(!/^\/common\/interact2\/(?:fish4\.6|farm4\.0)\/[A-Za-z0-9_./-]+\.(?:xml|swf|png|gif|jpg)$/.test(e.path)
        ||!/^assets\/(?:fish4\.6|farm4\.0)\/[A-Za-z0-9_./-]+$/.test(e.file)||e.file.split('/').some(p=>p==='.'||p==='..')
        ||!/^[a-f0-9]{64}$/.test(e.sha256)||this.entries.has(e.path))throw new Error('BUSINESS_RESOURCE_INVALID');
      const body=readFileSync(new URL(e.file,root));
      if(body.length!==e.size||createHash('sha256').update(body).digest('hex')!==e.sha256)throw new Error('BUSINESS_RESOURCE_CHANGED');
      this.entries.set(e.path,{body,contentType:e.contentType});
    }
  }
  resolve(host,target) {
    if(!['web.pet.qq.com','pet.qq.com','resource.pet.qq.com','client.pet.qq.com'].includes(host)||typeof target!=='string'||target.length>1024)return null;
    const [path,query,...rest]=target.split('?');if(rest.length||query!==undefined&&!/^(?:v|r|time)=\d+(?:\.\d+)?$/.test(query))return null;
    return this.entries.get(path.replace(/^\/NewQQPet\//,'/'))??null;
  }
}
