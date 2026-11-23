import { createHash } from 'node:crypto';

export const PLAY_MENU_PATH = '/static/desktop_singlegame_conf.json';
const ICON_PREFIX = '/static/desktop_singlegame/';

// E-093: Quick.swf methods 357/103/364/368. This is an explicit server
// catalogue, not a reconstruction of the unavailable historical catalogue.
export class PlayMenuResources {
  #routes = new Map();
  constructor(entries) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 12) throw new TypeError('INVALID_PLAY_CATALOGUE');
    const seen = new Set();
    const singlegame = entries.map(({ command, gameId, resource, level, name, icon, sha256 }) => {
      // Quick PlayItem.play -> ClientNet.playEx -> PET.ParseURL($GAME$[name]).
      // 0x6206 has no native handler; 100ceng uses the original resource branch.
      const byResource=command===undefined&&({100:'100ceng',101:'followupfish13',102:'followupcannon13',103:'followupstars13'})[gameId]===resource&&resource!==undefined;
      const byCommand=gameId===undefined&&resource===undefined&&Number.isInteger(command)
        &&[0x6201,0x6202,0x6203,0x6204,0x6205,0x6207,0x6208,0x6209].includes(command);
      const id=byResource?gameId:command;
      if ((!byResource&&!byCommand) || seen.has(id)
          || !Number.isInteger(level) || level < 0 || level > 0xffff
          || typeof name !== 'string' || !name.length || name.length > 32 || /[<>\x00-\x1f]/.test(name)
          || !Buffer.isBuffer(icon) || icon.length < 24 || icon.length > 65536
          || icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
          || createHash('sha256').update(icon).digest('hex') !== sha256) throw new TypeError('INVALID_PLAY_ENTRY');
      seen.add(id);
      const path = `${ICON_PREFIX}${id}-${sha256.slice(0,16)}.png`;
      this.#routes.set(path, { contentType: 'image/png', body: Buffer.from(icon) });
      return { gameid: byResource?gameId:-command, level, name, iconpath: `http://pet.qq.com${path}`, respath: byResource?resource:'' };
    });
    this.#routes.set(PLAY_MENU_PATH, {
      contentType: 'application/json; charset=utf-8',
      body: Buffer.from(JSON.stringify({ result: 0, singlegame }), 'utf8'),
    });
    // Public static catalogue and images only; no authentication data on this host.
    this.#routes.set('/crossdomain.xml', { contentType: 'text/x-cross-domain-policy',
      body: Buffer.from('<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" secure="false" /></cross-domain-policy>') });
  }

  resolve(target) {
    // Match the raw origin-form target; never normalize traversal or proxy URLs.
    if (typeof target !== 'string' || target.length > 256) return null;
    const [path, query, extra] = target.split('?');
    if (extra !== undefined) return null;
    if (path === PLAY_MENU_PATH) {
      if (query !== undefined && !/^time=(?:0(?:\.\d+)?|[1-9](?:\.\d+)?e-\d+)$/.test(query)) return null;
    } else if (query !== undefined) return null;
    const resource = this.#routes.get(path);
    return resource ? { contentType: resource.contentType, body: Buffer.from(resource.body) } : null;
  }
}
