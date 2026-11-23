import {readFileSync, realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {MARKET_FRAME_URL} from './market-page-resources.js';

const realpath = (value) => realpathSync(path.resolve(String(value)));

// Two public desktop responses that the locked desktop toolbar SWF requests for its
// server-configured desktop entry. The SWF's own CGIRequest appends identity as query parameters
// (&PET_UIN=&PET_ID=&PET_SIGN=) to every load; those are accepted and validated but
// never echoed, never logged and never used to filter the response: the menu catalogue
// is static and carries no account, balance or inventory data.
//
// Evidence (static): Toolbar.swf method 51 requests pet.qq.com/static/desktop_game.json
// and method 52 reads data.list; method 53 requests x.pet.qq.com/petclient?cmd=GetGames
// and method 54 matches data.user.default_games against the local list by scalar id.
// CGIRequest::load appends the three identity parameters; CGIRequest::onLoaderEvent
// decodes the body with JSON.decode, so both answers are plain JSON.

export const DESKTOP_GAME_PATH = '/static/desktop_game.json';
export const GET_GAMES_PATH = '/petclient';
export const DESKTOP_GAME_HOST = 'pet.qq.com';
export const GET_GAMES_HOST = 'x.pet.qq.com';

// Stable dynamic toolbar ID, consumed as a top-level item by the approved Toolbar overlay.
const DEFAULT_ENTRY_ID = 24870;
const DEFAULT_ICON = 'common/icons/shop-bf32c18dc6855e54.png';
const DEFAULT_ICON_SHA256 = 'bf32c18dc6855e54086fbd77a1474b2e512d8610c92235ef46bb873e329fb076';
const GAME_ICON = 'common/icons/wanshua.png';
const GAME_ICON_SHA256 = '27f392c4dc92f6cf6e363376941ac9f71a841984f01e5be1d989089f6dd9e42c';
// The frame page is 800x600 (div_mask; left iframe 345x339 + right 455x594 = 800 wide).
// The URL comes from the page set module so E1 and the community panel open the same page.
const DEFAULT_TITLE = '商城';

const IDENTITY_KEYS = ['PET_UIN', 'PET_ID', 'PET_SIGN'];
const decimal = (value) => /^(?:0|[1-9][0-9]*)$/u.test(value);
// The SWF writes PET_ID from the client's 64-bit pet id (DCN_I64_PETID), so the same
// unsigned 64-bit bound the toolbar and care contracts use applies here. Narrowing it to
// 32 bits rejected every real toolbar request with a 400 and left the submenu without its
// configuration, which is why no config-driven entry could ever appear.
const decimalU64 = (value) => decimal(value) && BigInt(value) <= 0xffffffffffffffffn;
const decimalU32 = (value) => decimal(value) && BigInt(value) <= 0xffffffffn;
const hex64 = (value) => /^[a-f0-9]{64}$/iu.test(value);

class DesktopGameError extends TypeError {}

function reject(code) {
  throw new DesktopGameError(code);
}

// Identity parameters are appended by the SWF itself. Their shape is checked so a
// malformed request is refused, but the value is never read into the response.
function checkIdentity(q) {
  // Toolbar's original QF_GetSelfPetInfo fallback supplies three empty values
  // before the pet bridge is ready. Both responses are public catalogues.
  if(IDENTITY_KEYS.every(key=>q.getAll(key).length===1&&q.get(key)===''))return;
  for (const key of IDENTITY_KEYS) {
    const values = q.getAll(key);
    if (values.length > 1) reject('DESKTOP_GAME_IDENTITY_INVALID');
    if (values.length === 0) continue;
    const value = values[0];
    const wellFormed = key === 'PET_SIGN'
      ? hex64(value)
      : key === 'PET_ID' ? decimalU64(value) : decimalU32(value);
    if (!wellFormed) reject('DESKTOP_GAME_IDENTITY_INVALID');
  }
}

export class DesktopGameResources {
  /**
   * @param {object} [options]
   * @param {string|URL} [options.clientRoot] authoritative client root; the icon is read from it
   * @param {number} [options.entryId] stable entry id (24870)
   * @param {string} [options.icon] client-relative icon path that must exist in the client
   * @param {string} [options.title] top-level label
   * @param {string} [options.frameUrl] market frame URL used for the entry
   */
  constructor({clientRoot, entryId = DEFAULT_ENTRY_ID, icon = DEFAULT_ICON, title = DEFAULT_TITLE,
    frameUrl = MARKET_FRAME_URL,includeSupplemental=false} = {}) {
    if (entryId !== DEFAULT_ENTRY_ID) reject('DESKTOP_GAME_ENTRY_INVALID');
    if (typeof title !== 'string' || title.length === 0 || title.length > 24 || /[<>\u0000-\u001f]/u.test(title)) {
      reject('DESKTOP_GAME_ENTRY_INVALID');
    }
    if (typeof icon !== 'string' || !/^common\/icons\/[A-Za-z0-9_.-]+\.png$/u.test(icon)) reject('DESKTOP_GAME_ICON_INVALID');
    if (typeof frameUrl !== 'string' || !/^http:\/\/web\.pet\.qq\.com\/common\/market\/[A-Za-z0-9_.-]+\.htm\?[!-~]+$/u.test(frameUrl)) {
      reject('DESKTOP_GAME_URL_INVALID');
    }
    if (clientRoot === undefined) reject('DESKTOP_GAME_ICON_UNVERIFIED');
    this.entryId = entryId;
    this.icon = icon;
    this.title = title;
    this.frameUrl = frameUrl;
    const bytes = readFileSync(path.join(realpath(clientRoot), icon));
    if (createHash('sha256').update(bytes).digest('hex') !== DEFAULT_ICON_SHA256) reject('DESKTOP_GAME_ICON_CHANGED');
    // The sub-window takes an explicit content size; $SIZE$ is the websub WebContainer
    // size, so 800x600 is the page stage and the window becomes 810x624.
    this.entryUrl = `PET://$SUB$[${frameUrl}]$SIZE$[800,600]`;
    if(includeSupplemental&&createHash('sha256').update(readFileSync(path.join(realpath(clientRoot),GAME_ICON))).digest('hex')!==GAME_ICON_SHA256)
      reject('DESKTOP_GAME_ICON_CHANGED');
    const extra=includeSupplemental?[Object.freeze({id:24900,icon:GAME_ICON,title:'小游戏',
      url:'PET://$SUB$[http://web.pet.qq.com/games/index.html]$SIZE$[800,600]'})]:[];
    this.desktopGame = Object.freeze({result: 0, list: Object.freeze([
      Object.freeze({id: entryId, icon, title, url: this.entryUrl}),
      ...extra,
    ])});
    this.getGames = Object.freeze({result: 0, user: Object.freeze({default_games: Object.freeze([entryId,...extra.map(e=>e.id)])})});
  }

  /**
   * Whether this host and target belong to the desktop toolbar's two questions, without
   * building a body. It exists for the acceptance relay, which has to decide whether a request
   * may be carried to this service at all: the relay admits the route, this class keeps
   * deciding every field of it, and a malformed request is refused here exactly as it is in
   * `resolve`.
   * @returns {boolean} false when the route is not ours or the request is malformed
   */
  matches(host, target) {
    try { return this.resolve(host, target) !== null; } catch { return false; }
  }

  /** @returns {{contentType:string, body:Buffer}|null} null when this host/path is not ours. */
  resolve(host, target) {
    if (typeof target !== 'string' || target.length > 512 || !/^\/[A-Za-z0-9_./-]*\?[!-~]*$/u.test(target)) return null;
    if (host !== DESKTOP_GAME_HOST && host !== GET_GAMES_HOST) return null;
    const [pathname, query] = target.split('?');
    let payload = null;
    if (host === DESKTOP_GAME_HOST && pathname === DESKTOP_GAME_PATH) {
      const q = new URLSearchParams(query);
      for (const key of new Set(q.keys())) {
        const values = q.getAll(key);
        if (values.length > 1) reject('DESKTOP_GAME_QUERY_DUPLICATE');
        if (!['rt', ...IDENTITY_KEYS].includes(key)) reject('DESKTOP_GAME_QUERY_INVALID');
      }
      if (!decimal(q.get('rt') ?? '')) reject('DESKTOP_GAME_QUERY_INVALID');
      checkIdentity(q);
      payload = this.desktopGame;
    } else if (host === GET_GAMES_HOST && pathname === GET_GAMES_PATH) {
      const q = new URLSearchParams(query);
      for (const key of new Set(q.keys())) {
        const values = q.getAll(key);
        if (values.length > 1) reject('DESKTOP_GAME_QUERY_DUPLICATE');
        if (!['cmd', ...IDENTITY_KEYS].includes(key)) reject('DESKTOP_GAME_QUERY_INVALID');
      }
      if (q.get('cmd') !== 'GetGames') reject('DESKTOP_GAME_QUERY_INVALID');
      checkIdentity(q);
      payload = this.getGames;
    }
    if (payload === null) return null;
    return {contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(payload), 'utf8')};
  }

  summary() {
    return Object.freeze({profile: 'desktop-game-resources', entryId: this.entryId, icon: this.icon,
      entries: this.desktopGame.list.length, identityAccepted: false});
  }
}
