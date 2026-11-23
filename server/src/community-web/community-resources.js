import {readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const TYPES = {'.swf':'application/x-shockwave-flash','.xml':'application/xml',
  '.png':'image/png','.gif':'image/gif','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.bmp':'image/bmp','.cur':'image/x-icon','.mp3':'audio/mpeg','.wav':'audio/wav',
  '.zip':'application/zip','.ini':'text/plain','.txt':'text/plain'};

export function resourceKey(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\x00-\x1f\x7f:%?#]/.test(name))
    throw new TypeError('INVALID_RESOURCE_NAME');
  const normalized = name.replaceAll('\\', '/');
  if (normalized.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')))
    throw new TypeError('INVALID_RESOURCE_NAME');
  return normalized.toLowerCase();
}

export class CommunityResources {
  constructor(entries, aliases = {}, main = 'world_1089.swf') {
    if (!Array.isArray(entries) || !entries.length || entries.length > 5000)
      throw new TypeError('INVALID_RESOURCE_CATALOG');
    this.files = new Map();
    this.aliases = new Map();
    let total = 0;
    for (const e of entries) {
      const key = resourceKey(e.name), type = TYPES[path.posix.extname(key)];
      if (!type || this.files.has(key) || !Buffer.isBuffer(e.body) || e.body.length > 32*1024*1024
          || (total += e.body.length) > 512*1024*1024
          || createHash('sha256').update(e.body).digest('hex') !== e.sha256)
        throw new TypeError('INVALID_RESOURCE_ENTRY');
      this.files.set(key, {body:Buffer.from(e.body), contentType:type});
    }
    for (const [key, value] of Object.entries(aliases)) this.aliases.set(resourceKey(key), resourceKey(value));
    this.main = resourceKey(main);
    if (!this.files.has(this.main)) throw new TypeError('MAIN_RESOURCE_MISSING');
  }

  resolve(name) {
    let key;
    try { key = resourceKey(name); } catch { return null; }
    key = this.aliases.get(key) ?? key;
    return this.files.has(key) ? key : null;
  }

  get(name) {
    const key = this.resolve(name);
    return key ? this.files.get(key) : null;
  }

  mapConfiguration(kind) {
    const leaf={miniMap:'MiniMapConfig.xml',worldMap:'WorldMapConfig.xml',navigation:'Config.xml'}[kind];
    const folder=this.aliases.get('mapconfigure');
    return leaf && folder ? this.resolve(folder+'/'+leaf) : null;
  }

  sceneConfigurations() {
    const result={scene:{},npc:{},music:{}};
    const sources={scene:['sceneconfigure','Config.xml'],npc:['npcconfigure','NpcList.xml'],
      music:['musicconfigure','MusicConfigV2.xml']};
    for(const [kind,[alias,leaf]] of Object.entries(sources)) {
      const folder=this.aliases.get(alias);
      if(!folder)continue;
      const prefix=folder+'/',suffix='/'+leaf.toLowerCase();
      for(const name of this.files.keys()) {
        if(!name.startsWith(prefix) || !name.endsWith(suffix))continue;
        const id=name.slice(prefix.length,-suffix.length);
        if(/^[1-9][0-9]{0,4}$/.test(id) && Number(id)<=65535)result[kind][id]=name;
      }
    }
    return result;
  }
}

export async function loadCommunityResources(authorityRoot, catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.entries))
    throw new TypeError('INVALID_RESOURCE_CATALOG');
  const root = await realpath(authorityRoot);
  const entries = [];
  for (const e of catalog.entries) {
    const name = resourceKey(e.name);
    if (e.source !== 'common/petsoc/' + e.name) throw new TypeError('RESOURCE_SOURCE_INVALID');
    const filename = await realpath(path.join(root, e.source));
    const relative = path.relative(root, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('RESOURCE_OUTSIDE_AUTHORITY');
    const body = await readFile(filename);
    if (body.length !== e.bytes) throw new TypeError('RESOURCE_SIZE_CHANGED');
    entries.push({name, body, sha256:e.sha256});
  }
  return new CommunityResources(entries, catalog.aliases, catalog.main);
}
