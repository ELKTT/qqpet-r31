import {adminStyles,renderWorkspace,operationsPanels,ADMIN_SECTIONS} from './admin-workspace.js';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {AccountEconomyAdmin,MAX_TEST_PET_LEVEL} from './account-admin.js';
import {AccountError} from './account-service.js';

// The local account pages. One loopback listener for registration, the administrator panel and the
// first adoption, all backed by the same AccountService the login server authenticates against, so
// a page never has its own copy of an account.
//
// Every route is bound to the exact loopback authority, every write carries a one-time token, and
// an admin session is a real AccountService session: the same expiry, revocation and scope rules
// the rest of the server uses. No credential, digest or ticket is ever written into a page, a URL
// or this module's output.

const PAGES = Object.freeze({
  // The palette and the two prose colours are the game's own (#8e580a on #fee8d6, with the
  // community host's #d6edf6 for the header), so the local pages sit next to the client rather
  // than looking like a separate product.
  style: `body{margin:0;background:#fee8d6;color:#8e580a;font:15px/1.9 "Microsoft YaHei UI","Microsoft YaHei",sans-serif}
header{background:#d6edf6;padding:14px 24px;font-size:18px;font-weight:bold}
main{max-width:640px;margin:0 auto;padding:20px 24px 40px}
fieldset{border:1px solid #e0b98a;background:#fff8f0;margin:0 0 18px;padding:14px 18px}
legend{padding:0 6px}
label{display:block;margin:10px 0 2px}
input[type=text],input[type=password],input[type=number],select{width:100%;max-width:320px;padding:6px 8px;border:1px solid #d7b088;background:#fff}
button{margin-top:14px;padding:7px 18px;border:0;background:#e8a33d;color:#fff;font-size:15px;cursor:pointer}
button.danger{background:#c0503a}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #e0b98a;padding:5px 8px;text-align:left}
.ok{background:#eaf7e6;border:1px solid #9bc98a;padding:10px 14px;margin:0 0 14px}
.bad{background:#fdeceb;border:1px solid #d99a92;padding:10px 14px;margin:0 0 14px}
nav a{color:#8e580a;margin-right:14px}`,
  layout(title, body) {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>${PAGES.style}${title==='管理后台'?adminStyles:''}</style></head><body><header>QQ宠物本地服务 · ${title}</header><main>${body}</main></body></html>`;
  },
});

const MAX_BODY = 65536;

export class AccountWebError extends Error {
  constructor(code) {super(code); this.name = 'AccountWebError'; this.code = code;}
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/gu,
  (character) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

export class AccountWebServer {
  #tokens = new Map();
  #lastBackup = null;
  constructor({accounts, provisioning, admin = null, catalog = null, economyAdmin = null,
    healthView = null, backupsRoot = null, operations = null, friends = null, clock = Date.now,
    randomBytes, host = '127.0.0.1', port = 18086, tokenTtlMs = 900000} = {}) {
    if (typeof accounts?.register !== 'function' || typeof accounts?.createSession !== 'function')
      throw new TypeError('INVALID_ACCOUNT_WEB_SERVICE');
    // Port 0 asks the operating system for a free one: an assembly that does not pin the port
    // still gets a listener, and the bound port is reported in health() for the run package. A
    // pinned port must be an unprivileged one, and a taken port fails the start rather than
    // moving silently.
    if (!Number.isInteger(port) || port < 0 || port > 65535 || (port !== 0 && port < 1024)
        || host !== '127.0.0.1') throw new TypeError('INVALID_ACCOUNT_WEB_ENDPOINT');
    if (typeof randomBytes !== 'function') throw new TypeError('INVALID_ACCOUNT_WEB_RANDOM');
    if (typeof admin?.setDisabled !== 'function' || typeof admin?.resetCredential !== 'function'
        || typeof catalog?.setLocalPrice !== 'function')
      throw new TypeError('INVALID_ADMIN_COLLABORATORS');
    this.operations = operations;
    this.friends=friends;
    this.accounts = accounts; this.provisioning = provisioning; this.admin = admin;
    this.catalog = catalog; this.clock = clock; this.randomBytes = randomBytes;
    // The economy views and the health view are optional collaborators: an assembly without the
    // care economy still serves accounts, and every consumer below says so instead of assuming.
    // They are stored here — a received-but-dropped collaborator would make the panel promise
    // views it cannot render and actions it cannot run.
    this.economyAdmin = economyAdmin; this.healthView = healthView; this.backupsRoot = backupsRoot;
    this.host = host; this.port = port; this.tokenTtlMs = tokenTtlMs;
    this.counts = {requests: 0, rejected: 0, registered: 0, adoptions: 0, adminActions: 0};
    this.stopped = false;
    this.server = http.createServer((request, response) => this.#handle(request, response));
  }
  // A page token is one use, short lived, and only ever compared against the value this server
  // issued: it is not a session and it carries no identity.
  // One token per form. A form on a page without a session carries no binding; a form inside the
  // administrator panel is bound to that session's own CSRF value, so a token issued for one
  // session cannot be replayed into another and the action needs the session it came from.
  #issueToken(session = null) {
    const token = this.randomBytes(16).toString('hex');
    this.#tokens.set(token, {expires: this.clock() + this.tokenTtlMs,
      bind: session ? Buffer.from(session.csrfHash).toString('hex') : null});
    return token;
  }
  #consumeToken(token, session = null) {
    if (typeof token !== 'string' || !/^[a-f0-9]{32}$/u.test(token)) return false;
    const record = this.#tokens.get(token);
    this.#tokens.delete(token);
    if (record === undefined || record.expires <= this.clock()) return false;
    if (record.bind === null) return session === null;
    return session !== null && record.bind === Buffer.from(session.csrfHash).toString('hex');
  }
  #pruneTokens() {
    const now = this.clock();
    for (const [token, record] of this.#tokens) if (record.expires <= now) this.#tokens.delete(token);
  }
  async start() {
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error);
      this.server.once('error', failed);
      this.server.listen(this.port, this.host, () => { this.server.removeListener('error', failed); resolve(); });
    });
    return `http://${this.host}:${this.port}/`;
  }
  // Stopping a listener that never started is a no-op, the same way the other local servers behave:
  // a check-only assembly loads everything and starts nothing, and must still close cleanly.
  stop() {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (!this.server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }
  // The port the listener is on. Before it starts this is the requested one, which is only a
  // placeholder: nothing compares an authority against it.
  boundPort() {
    const bound = this.server?.address();
    return typeof bound === 'object' && bound !== null ? bound.port : this.port;
  }
  // The addresses the client and the launcher need, so neither has to guess a port or rebuild a
  // path: the launcher points its 申请帐号 and 忘记密码 links at these.
  urls() {
    const base = `http://${this.host}:${this.boundPort()}`;
    return Object.freeze({base, register: `${base}/register`, reset: `${base}/reset`, adopt: `${base}/adopt`, admin: `${base}/admin`});
  }
  health() {
    return Object.freeze({ready: Boolean(this.server?.listening), profile: 'account-web',
      endpoint: Object.freeze({host: this.host, port: this.boundPort()}),
      urls: this.urls(), counts: Object.freeze({...this.counts})});
  }

  #reply(response, status, type, body, headers = {}) {
    const bytes = Buffer.from(body, 'utf8');
    response.writeHead(status, {'Content-Type': type, 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close', ...headers});
    response.end(bytes);
  }
  #page(response, status, title, body) {
    this.#reply(response, status, 'text/html; charset=utf-8', PAGES.layout(title, body));
  }
  #adminSession(request) {
    const header = request.headers.cookie;
    if (typeof header !== 'string' || header.length > 1024) return null;
    const entry = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith('qqpet_admin='));
    if (entry.length !== 1) return null;
    const value = entry[0].slice('qqpet_admin='.length);
    if (!/^[a-f0-9]{64}$/u.test(value)) return null;
    return this.accounts.resolveSession(Buffer.from(value, 'hex'), {scope: 'admin'});
  }

  async #handle(request, response) {
    this.counts.requests += 1;
    // Every branch below is supposed to answer; this boundary exists so that a bug in one
    // renderer cannot silently destroy the connection with no status line at all. The page
    // names a stable code, never the raw error text.
    try {
      await this.#route(request, response);
    } catch {
      this.counts.rejected += 1;
      try { this.#page(response, 500, '服务错误', '<div class="bad">这个请求没有被处理完（INTERNAL_PAGE_ERROR）。请返回重试；若反复出现，请检查本地服务日志。</div>'); } catch {}
    }
  }
  async #route(request, response) {
    const deny = (status = 400) => {this.#page(response, status, '请求被拒绝', '<div class="bad">这个请求不符合本地服务的约束。</div>');};
    // The authority is the port the listener actually got: with an unpinned port that is not the
    // requested one, and comparing against the request would reject every real request.
    if (request.headers.host !== `${this.host}:${this.boundPort()}`) {this.counts.rejected += 1; return deny();}
    let url;
    try { url = new URL(request.url, `http://${this.host}:${this.boundPort()}`); } catch {this.counts.rejected += 1; return deny();}
    const query = (key) => (url.searchParams.has(key) ? url.searchParams.get(key) : undefined);
    if (request.method === 'GET') {
      if (url.pathname === '/') return this.#page(response, 200, '首页', this.#home());
      if (url.pathname === '/register') return this.#page(response, 200, '注册本地账号', this.#registerForm());
      if (url.pathname === '/reset') return this.#page(response, 200, '忘记密码', this.#resetPage());
      if (url.pathname === '/adopt') return this.#page(response, 200, '首次领养', this.#adoptForm());
      if (url.pathname === '/admin') return this.#page(response, 200, '管理后台', this.#adminForm());
      if (url.pathname === '/admin/panel') {
        const session = this.#adminSession(request);
        if (!session) return this.#page(response, 403, '管理后台', '<div class="bad">请先以管理员身份登录。</div>' + this.#adminForm());
        return this.#page(response, 200, '管理后台', this.#adminPanel(session, query('q') ?? '',
          {section: query('section') ?? (query('item')!==undefined?'shop':query('q')?'pets':'overview'), item: query('item') ?? null, backup: this.#lastBackup, notice: query('notice') ?? null}));
      }
      this.counts.rejected += 1;
      return deny(404);
    }
    if (request.method !== 'POST') {this.counts.rejected += 1; return deny(405);}
    let body = '';
    try { body = await this.#readBody(request); } catch {this.counts.rejected += 1; return deny();}
    const form = new URLSearchParams(body);
    const field = (name) => form.get(name) ?? '';
    this.#pruneTokens();
    const action = url.pathname;
    if (action === '/register') return this.#doRegister(response, field);
    if (action === '/adopt') return this.#doAdopt(response, field);
    if (action === '/admin/login') return this.#doAdminLogin(response, field);
    if (action === '/admin/action') return this.#doAdminAction(request, response, field);
    this.counts.rejected += 1;
    return deny(404);
  }
  #readBody(request) {
    return new Promise((resolve, reject) => {
      const length = Number(request.headers['content-length']);
      if (!Number.isInteger(length) || length <= 0 || length > MAX_BODY) {reject(new AccountWebError('BODY_INVALID')); return;}
      let size = 0;
      const chunks = [];
      request.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {request.destroy(); reject(new AccountWebError('BODY_TOO_LARGE')); return;}
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', () => reject(new AccountWebError('BODY_STREAM')));
    });
  }

  #home() {
    return `<nav><a href="/register">注册本地账号</a><a href="/adopt">首次领养</a><a href="/admin">管理后台</a></nav>
<fieldset><legend>这两个页面做什么</legend>
<p>注册会为本地服务建立一个账号。注册本身<strong>不会创建宠物</strong>，也不会复制现有宠物或预填库存。</p>
<p>账号建立后，用登录器登录；还没有宠物时，登录器会提示先完成领养，领养在本页的"首次领养"里完成。</p></fieldset>`;
  }
  #registerForm(message = '') {
    return `${message}<form method="post" action="/register">
<input type="hidden" name="token" value="${this.#issueToken()}">
<fieldset><legend>注册本地账号</legend>
${this.accounts.firstRegistrationAdmin?'<p>新存档中第一个成功注册的账号自动成为管理员，使用同一账号和密码登录管理后台。</p>':''}
<label for="account">注册号码（10000–4294967295，注册后即为 UIN）</label><input id="account" name="account" type="text" maxlength="10" autocomplete="off">
<label for="user-nickname">用户昵称（最多7个汉字或15个英文字母）</label><input id="user-nickname" name="nickname" type="text" maxlength="15" autocomplete="nickname" required>
<p>用于好友列表和好友场景，与宠物昵称分开保存。</p>
<label for="birthday">主人生日（选填，月-日，例如 05-12）</label><input id="birthday" name="birthday" type="text" maxlength="5" placeholder="MM-DD" pattern="[0-9]{2}-[0-9]{2}">
<p>填写后，宠物会在生日登录时送上祝福；不需要填写出生年份。</p>
<label for="password">密码（8-128 个字符）</label><input id="password" name="password" type="password" maxlength="128" autocomplete="new-password">
<label for="confirm">确认密码</label><input id="confirm" name="confirm" type="password" maxlength="128" autocomplete="new-password">
<button type="submit">注册</button></fieldset></form>`;
  }
  #resetPage() {
    // The local reset process is the one the administrator panel implements: there is no
    // e-mail to send a link to, so the page states the process instead of pretending a
    // self-service reset exists, and it never sends a credential anywhere.
    return `<fieldset><legend>忘记密码</legend>
<p>本地服务的密码重置由管理员执行：联系本机管理员，在<a href="/admin">管理后台</a>用“凭据重置”为你设置新密码。</p>
<p>重置立即生效：你的旧网页会话、旧入场票据和已连接的游戏会同时失效，需要用新密码重新登录。</p>
<p>如果你就是本机管理员，用管理员账号登录后台后即可重置任意账号的密码。</p></fieldset>`;
  }
  #adoptForm(message = '') {
    return `${message}<form method="post" action="/adopt">
<input type="hidden" name="token" value="${this.#issueToken()}">
<fieldset><legend>首次领养</legend>
<p>用刚注册的账号和密码确认身份，然后选择宠物。领养成功后同一账号即可登录，不需要重启本地服务。</p>
<label for="adopt-account">账号</label><input id="adopt-account" name="account" type="text" maxlength="10" autocomplete="off">
<label for="adopt-password">密码</label><input id="adopt-password" name="password" type="password" maxlength="128" autocomplete="current-password">
<label for="gender">性别</label><select id="gender" name="gender"><option value="female">女孩</option><option value="male">男孩</option></select>
<label for="nickname">宠物昵称（中文可用，最多 15 字节）</label><input id="nickname" name="nickname" type="text" maxlength="15">
<button type="submit">领养</button></fieldset></form>`;
  }
  #adminForm(message = '') {
    return `<div class="admin-login"><h1>QQ 宠物管理中心</h1>${message}<form method="post" action="/admin/login">
<input type="hidden" name="token" value="${this.#issueToken()}">
<fieldset><legend>管理员登录</legend>
<label for="admin-account">管理员账号</label><input id="admin-account" name="account" type="text" maxlength="10" autocomplete="off">
<label for="admin-password">密码</label><input id="admin-password" name="password" type="password" maxlength="128" autocomplete="current-password">
<button type="submit">登录</button></fieldset></form>
<p>${this.accounts.firstRegistrationAdmin?'新存档中第一个成功注册的账号是管理员，请使用该账号及其注册密码登录。':'首位管理员由本地初始化流程建立，注册页的第一个用户不会被自动提权。'}</p></div>`;
  }
  // The two read-only views the panel adds: a pet's current status and a page of the catalogue.
  // Both say what is missing instead of throwing: an assembly without the care economy renders
  // an honest notice, and a failing query renders its code, never a destroyed connection.
  #petSummary(account) {
    const found = account === '' ? null : this.accounts.findByLoginName(account);
    if (!found) return '<div class="bad">没有这个账号。</div>';
    if (!this.economyAdmin) return '<div class="bad">这个装配没有启用经济模块，宠物状态暂不可查看。</div>';
    let pet;
    try { pet = this.economyAdmin.petDetails(found.uin); }
    catch (error) { return `<div class="bad">${escapeHtml(accountMessage(error))}</div>`; }
    return `<table><tr><th>宠物</th><th>等级</th><th>成长</th><th>饥饿</th><th>清洁</th><th>健康</th><th>心情</th><th>元宝</th><th>背包</th></tr>
<tr><td>${escapeHtml(pet.name)}</td><td>${pet.level}</td><td>${pet.growth}</td><td>${pet.hunger}</td>
<td>${pet.cleanliness}</td><td>${pet.health}</td><td>${pet.mood}</td><td>${pet.yuanbao}</td>
<td>${pet.inventoryKinds} 种 / ${pet.inventoryQuantity} 件</td></tr></table>`;
  }
  #itemTable(session, itemQuery) {
    if (!this.economyAdmin) return '<div class="bad">这个装配没有启用经济模块，商品目录暂不可查看。</div>';
    let items;
    try { items = this.economyAdmin.searchItems(itemQuery); }
    catch (error) { return `<div class="bad">${escapeHtml(accountMessage(error))}</div>`; }
    if (items.length === 0) return '<div class="bad">没有匹配的商品。</div>';
    const rows = items.map((item) => {
      // 上架 is a real listing: it must carry a price above zero. A shelved item offers an
      // editable price field, so "上架" can never quietly resubmit 0 and stay invisible.
      const listForm = item.sellable
        ? `<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<input type="hidden" name="cid" value="${item.cid}"><input type="hidden" name="price" value="${item.price}">
<input type="hidden" name="reason" value="panel">
<button name="op" value="price">改价上架</button></form>`
        : `<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<input type="hidden" name="cid" value="${item.cid}">
<input type="number" name="price" value="" min="1" max="1000000" placeholder="价格" required style="width:6em">
<input type="hidden" name="reason" value="panel">
<button name="op" value="shelve">上架</button></form>`;
      const unshelveForm = `<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<input type="hidden" name="cid" value="${item.cid}"><input type="hidden" name="price" value="0">
<input type="hidden" name="reason" value="panel">
<button class="danger" name="op" value="price">下架</button></form>`;
      return `<tr><td>${item.cid}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.class)}</td>
<td>${item.hunger}/${item.cleanliness}/${item.mood}</td><td>${item.minLevel}-${item.maxLevel}</td>
<td>${item.price}${item.priceSource === 'local-override' ? '（本地）' : ''}</td>
<td>${item.sellable ? '可售' : '不可售'}</td><td>${listForm}${unshelveForm}</td></tr>`;
    }).join('');
    return `<table><tr><th>编号</th><th>名称</th><th>分类</th><th>饥饿/清洁/心情</th><th>等级</th><th>价格</th><th>状态</th><th>上架/下架</th></tr>${rows}</table>`;
  }
  #adminPanel(session, search, {section = 'overview', item: itemQuery = null, backup = null, notice = null} = {}) {
    const health = typeof this.healthView === 'function' ? this.healthView() : null;
    const rows = this.accounts.searchAccounts({query: search, limit: 100}).map((account) => `<tr>
<td>${escapeHtml(account.loginName)}</td><td>${escapeHtml(account.nickname)}</td><td>${account.uin}</td>
<td>${account.pets}</td><td>${account.admin ? '管理员' : '普通'}</td>
<td>${account.disabled ? '已停用' : '启用中'}</td><td>${this.admin.isOnline?.(account.uin)?'在线':'离线'}</td>
<td><form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<input type="hidden" name="uin" value="${account.uin}">
<button class="${account.disabled ? '' : 'danger'}" name="op" value="${account.disabled ? 'enable' : 'disable'}">${account.disabled ? '启用' : '停用'}</button></form></td></tr>`).join('');
    const panels = [
      {section:'accounts',html:`<fieldset class="admin-wide"><legend>账号列表</legend><form method="get" action="/admin/panel"><label for="q">账号搜索（留空列出全部）</label>
<input id="q" name="q" type="text" maxlength="10"><button type="submit">搜索</button></form>
<table><tr><th>账号</th><th>用户昵称</th><th>内部编号</th><th>宠物数</th><th>权限</th><th>状态</th><th>在线状态</th><th>操作</th></tr>${rows || '<tr><td colspan="8">没有匹配的账号</td></tr>'}</table>
</fieldset>`},
      {section:'accounts',html:`<fieldset><legend>修改注册用户名（用户昵称）</legend><form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}"><label>账号<input name="account" type="text" required value="${escapeHtml(search)}"></label><label>用户昵称<input name="nickname" type="text" maxlength="15" required></label><button name="op" value="userNickname">保存用户名</button></form></fieldset>`},
      ...(this.friends?[{section:'accounts',html:`<fieldset><legend>默认好友关系</legend><form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}"><label>好友模式<select name="policy"><option value="all-server-pets" ${this.friends.policy==='all-server-pets'?'selected':''}>所有玩家互为好友</option><option value="community-friends" ${this.friends.policy==='community-friends'?'selected':''}>默认不是好友，手动添加</option></select></label><p>保存后生效，重新打开好友列表查看；已手动添加的关系保留。</p><button name="op" value="friendPolicy">保存好友设置</button></form></fieldset>`}]:[]),
      {section:'accounts',html:`<fieldset><legend>凭据重置</legend>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="reset-account">账号</label><input id="reset-account" name="account" type="text" maxlength="10">
<label for="reset-password">新密码</label><input id="reset-password" name="password" type="password" maxlength="128">
<button class="danger" name="op" value="reset">重置并失效旧会话</button></form></fieldset>
`},
      {section:'pets',html:`<fieldset><legend>元宝调整</legend>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="yb-account">账号</label><input id="yb-account" name="account" type="text" maxlength="10">
<label for="yb-amount">增减数量（可为负）</label><input id="yb-amount" name="amount" type="number" min="-1000000" max="1000000">
<label for="yb-reason">原因（写入审计）</label><input id="yb-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="yuanbao">调整</button></form></fieldset>
`},
      {section:'shop',html:`<fieldset><legend>商品价格与上架</legend>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="item-cid">商品编号</label><input id="item-cid" name="cid" type="number" min="1">
<label for="item-price">本地价格（0 表示不可售）</label><input id="item-price" name="price" type="number" min="0" max="1000000">
<label for="item-reason">原因（写入审计）</label><input id="item-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="price">保存</button></form></fieldset>
`},
      {section:'pets',html:`<fieldset><legend>宠物状态</legend>
<form method="get" action="/admin/panel"><label for="pet-account">账号</label>
<input id="pet-account" name="q" type="text" maxlength="10"><button type="submit">查看</button></form>
${search ? this.#petSummary(search) : '<p>填写账号后显示该账号宠物的当前状态。</p>'}</fieldset>
`},
      {section:'pets',html:`<fieldset><legend>宠物等级调整（测试）</legend>
<p>成长值同步设为目标等级的起点。降低等级时，饥饿和清洁值最多保留到新等级上限。修改后重新登录宠物，查看等级和外观。</p>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="level-account">账号</label><input id="level-account" name="account" type="text" maxlength="10" value="${escapeHtml(search)}" required>
<label for="pet-level">目标等级（0–${MAX_TEST_PET_LEVEL}）</label><input id="pet-level" name="level" type="number" min="0" max="${MAX_TEST_PET_LEVEL}" step="1" required>
<label for="level-reason">原因（写入审计）</label><input id="level-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="level">修改等级</button></form></fieldset>
`},
      {section:'pets',html:`<fieldset><legend>宠物数值调整（测试）</legend>
<p>饥饿、清洁为实际数值，上限随等级变化（3000–6000）；心情 0–1000；健康 0–5，5 为健康、1–4 为生病、0 为死亡。任一生命数值为 0 按死亡处理；成年宠物饥饿或脏时，兴奋心情降至 899。在线宠物在下一次状态同步时更新。</p>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="vitals-account">账号</label><input id="vitals-account" name="account" type="text" maxlength="10" value="${escapeHtml(search)}" required>
${[['hunger','饥饿',6000],['cleanliness','清洁',6000],['mood','心情',1000],['health','健康',5]].map(([key,label,max])=>`<label for="vitals-${key}">${label}</label><input id="vitals-${key}" name="${key}" type="number" min="0" max="${max}" step="1" required>`).join('')}
<label for="vitals-reason">原因（写入审计）</label><input id="vitals-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="vitals">修改数值</button></form></fieldset>
`},
      {section:'pets',html:`<fieldset><legend>库存调整</legend>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="inv-account">账号</label><input id="inv-account" name="account" type="text" maxlength="10">
<label for="inv-cid">商品编号</label><input id="inv-cid" name="cid" type="number" min="1">
<label for="inv-count">增减数量（可为负）</label><input id="inv-count" name="count" type="number" min="-9999" max="9999">
<label for="inv-reason">原因（写入审计）</label><input id="inv-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="inventory">调整</button></form></fieldset>
`},
      {section:'shop',html:`<fieldset class="admin-wide"><legend>商品检索与维护</legend>
<form method="get" action="/admin/panel"><label for="item-q">名称或编号（留空列出前 50 项）</label>
<input id="item-q" name="item" type="text" maxlength="40"><button type="submit">检索</button></form>
${itemQuery === null ? '' : this.#itemTable(session, itemQuery)}
<p>分类与效果的修改走下方“商品分类与效果维护”：每次修改都经过目录合同校验并记录摘要迁移，在下次服务启动时生效，而不是悄悄改动运行中的目录。</p></fieldset>
    `},
      {section:'shop',html:`<fieldset><legend>商品分类与效果维护（显式迁移）</legend>
    <p>修改会先通过目录自身的商品合同校验，再记录目录摘要迁移并写入目录文件；<strong>下次服务启动时生效</strong>，宠物目录按迁移记录自动过渡。心情规则（功能品固定 +100）、价格（本地价格表）与可售状态不受此处影响。</p>
    <form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
    <label for="pol-cid">商品编号</label><input id="pol-cid" name="cid" type="number" min="1" required>
    <label for="f_name">名称（留空不改）</label><input id="f_name" name="f_name" type="text" maxlength="60">
    <label for="f_class">分类 class（food / clean / functional / medicine，留空不改）</label><input id="f_class" name="f_class" type="text" maxlength="20">
    <label for="f_subkind">子页 subkind（0 食品 / 1 清洁 / 2 功能或药品，留空不改）</label><input id="f_subkind" name="f_subkind" type="number" min="0" max="2">
    <label for="f_hunger">饥饿效果（留空不改）</label><input id="f_hunger" name="f_hunger" type="number" min="0" max="65535">
    <label for="f_cleanliness">清洁效果（留空不改）</label><input id="f_cleanliness" name="f_cleanliness" type="number" min="0" max="65535">
    <label for="f_mood">心情效果（留空不改）</label><input id="f_mood" name="f_mood" type="number" min="0" max="1000">
    <label for="f_minLevel">等级下限（留空不改）</label><input id="f_minLevel" name="f_minLevel" type="number" min="0" max="100">
    <label for="f_maxLevel">等级上限（0 表示不限，留空不改）</label><input id="f_maxLevel" name="f_maxLevel" type="number" min="0" max="100">
    <label for="pol-reason">原因（写入审计）</label><input id="pol-reason" name="reason" type="text" maxlength="80">
    <button type="submit" name="op" value="itemPolicy">暂存目录修改</button></form></fieldset>
`},
      {section:'system',html:`<fieldset><legend>服务健康与备份</legend>
${health ? `<p>游戏服务：${health.game.ready ? '已就绪' : '未就绪'}；webdir：${health.webdir.ready ? '已就绪' : '未就绪'}；账号网页：${health.accountWeb ? '已就绪' : '未配置'}</p>` : '<p>这个装配没有提供服务健康视图。</p>'}
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<label for="backup-reason">备份原因（写入审计）</label><input id="backup-reason" name="reason" type="text" maxlength="80">
<button type="submit" name="op" value="backup">立即本地备份</button></form>
${backup ? `<p>最近一次备份：${escapeHtml(backup.file)}，${backup.bytes} 字节，SHA-256 ${escapeHtml(backup.sha256.slice(0, 16))}…</p>` : ''}</fieldset>
`},
      {section:'system',html:`<fieldset><legend>服务状态</legend><p>管理员会话到期时间：${new Date(session.expiresAt).toLocaleString('zh-CN')}</p>
<form method="post" action="/admin/action"><input type="hidden" name="token" value="${this.#issueToken(session)}">
<button name="op" value="logout">退出登录</button></form></fieldset>`}
    ];
    panels.push(...operationsPanels(this.operations,()=>this.#issueToken(session)));
    return renderWorkspace(panels,{section,notice,health,accountCount:(rows.match(/<tr>/g)??[]).length,revision:this.operations?.revision??0});
  }

  #doRegister(response, field) {
    if (!this.#consumeToken(field('token'))) return this.#page(response, 403, '注册本地账号',
      this.#registerForm('<div class="bad">页面已过期，请重新提交。</div>'));
    try {
      const created = this.accounts.register({loginName: field('account'), nickname: field('nickname'),
        password: field('password'), confirm: field('confirm'), birthday: field('birthday')});
      this.counts.registered += 1;
      return this.#page(response, 200, '注册成功',
        `<div class="ok">账号 ${escapeHtml(created.loginName)} 已注册。</div>
<p>下一步：打开登录器用这个账号登录。它还没有宠物，登录器会提示你前往 <a href="/adopt">首次领养</a>。</p>`);
    } catch (error) {
      return this.#page(response, 400, '注册本地账号',
        this.#registerForm(`<div class="bad">${escapeHtml(accountMessage(error))}</div>`));
    }
  }
  #doAdopt(response, field) {
    if (!this.#consumeToken(field('token'))) return this.#page(response, 403, '首次领养',
      this.#adoptForm('<div class="bad">页面已过期，请重新提交。</div>'));
    let account;
    try { account = this.accounts.authenticate({loginName: field('account'), password: field('password')}); }
    catch (error) {account = null;}
    if (!account) return this.#page(response, 403, '首次领养',
      this.#adoptForm('<div class="bad">账号或密码不正确。</div>'));
    try {
      const adopted = this.provisioning.adopt({uin: account.uin, gender: field('gender'), nickname: field('nickname')});
      this.counts.adoptions += 1;
      return this.#page(response, 200, '领养完成',
        `<div class="ok">${adopted.replayed ? '这个账号已经领养过，返回的是同一只宠物。' : '领养成功。'}</div>
<p>现在回到登录器，用同一个账号和密码登录即可进入游戏。</p>`);
    } catch (error) {
      return this.#page(response, 400, '首次领养', this.#adoptForm(`<div class="bad">${escapeHtml(accountMessage(error))}</div>`));
    }
  }
  #doAdminLogin(response, field) {
    if (!this.#consumeToken(field('token'))) return this.#page(response, 403, '管理后台',
      this.#adminForm('<div class="bad">页面已过期，请重新提交。</div>'));
    let session = null;
    try {
      // The session is created with the same password that was just verified: the service requires
      // it for an administrator scope, so a caller cannot mint an admin session from a bare uin.
      session = this.accounts.createSession({uin: null, scope: 'admin', password: field('password'),
        loginName: field('account')});
    } catch {session = null;}
    if (!session) return this.#page(response, 403, '管理后台', this.#adminForm('<div class="bad">管理员账号或密码不正确，或该账号没有管理权限。</div>'));
    return this.#reply(response, 303, 'text/plain', '', {
      'Set-Cookie': `qqpet_admin=${session.token.toString('hex')}; Path=/admin; HttpOnly; SameSite=Strict`,
      Location: '/admin/panel'});
  }
  #doAdminAction(request, response, field) {
    const session = this.#adminSession(request);
    if (!session) return this.#page(response, 403, '管理后台', '<div class="bad">请先以管理员身份登录。</div>' + this.#adminForm());
    // The action token has to be one this server issued for this session: a token from another
    // page or another session cannot act, and it is spent by the attempt either way.
    if (!this.#consumeToken(field('token'), session))
      return this.#page(response, 403, '管理后台', '<div class="bad">这个操作没有携带有效的校验标记，请返回后台重新提交。</div>');
    const op = field('op');
    try {
      const result = this.#applyAdminAction(session, op, field);
      if (result && result.file) this.#lastBackup = result;
      this.counts.adminActions += 1;
      // A logout also expires the browser's copy: the session is already revoked server side,
      // and the cookie itself stops being offered on the next request.
      const headers = op === 'logout'
        ? {'Set-Cookie': 'qqpet_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0'} : {};
      // Only a short operator-facing string may ride the redirect. An object (a backup receipt)
      // must never be stringified into the panel's account-search box: its summary becomes the
      // notice and the receipt itself is rendered by the panel from the stored copy.
      const tab=ADMIN_SECTIONS.some(([id])=>id===field('section'))?field('section'):'overview';
      let notice = '/admin/panel?section='+tab;
      if (typeof result === 'string' && result.length > 0)
        notice = `/admin/panel?section=${tab}&notice=${encodeURIComponent(result)}`;
      else if (result && result.file)
        notice = `/admin/panel?section=${tab}&notice=${encodeURIComponent(`备份完成：${result.file}（${result.bytes} 字节）。`)}`;
      return this.#reply(response, 303, 'text/plain', '', {Location: notice, ...headers});
    } catch (error) {
      return this.#page(response, 400, '管理后台', `<div class="bad">${escapeHtml(accountMessage(error))}</div>` + this.#adminPanel(session, '',{section:field('section')}));
    }
  }
  #applyAdminAction(session, op, field) {
    const target = field('account') === '' ? null : this.accounts.findByLoginName(field('account'));
    const byUin = field('uin') === '' ? null : Number(field('uin'));
    const uin = target ? target.uin : byUin;
    if(op==='userNickname'){
      if(!Number.isInteger(uin))throw new AccountError('ACCOUNT_REQUIRED');
      this.admin.setUserNickname({uin,nickname:field('nickname'),actorUin:session.uin,reason:field('reason')});return '注册用户名已保存。';
    }
    if(op==='friendPolicy'){
      if(!this.friends||!['all-server-pets','community-friends'].includes(field('policy')))throw new AccountError('INVALID_INPUT','请选择好友模式');
      this.friends.setPolicy({policy:field('policy'),actorUin:session.uin,reason:field('reason')});return '好友设置已保存。';
    }
    if (op === 'operations') {
      if(!this.operations)throw new AccountError('ACCOUNT_SERVICE_UNAVAILABLE');
      const policySection=field('policySection');
      const num=name=>{const raw=field(name);if(!/^[0-9]+$/.test(raw))throw new AccountError('OPERATIONS_INVALID_NUMBER');return Number(raw);};
      let values;
      if(policySection==='task')values={name:field('name'),condition:field('condition'),enabled:field('enabled')==='1',active:num('active'),reward:num('reward')};
      else if(policySection==='activity')values={awards:Array.from({length:4},(_,i)=>num('award'+i))};
      else if(policySection==='sign')values={daily:num('daily'),monthly:Array.from({length:7},(_,i)=>num('award'+i))};
      else if(policySection==='vip')values={trial:num('trial'),month:num('month'),year:num('year')};
      else if(policySection==='announcement')values={enabled:field('enabled')==='1',title:field('title'),body:field('body'),secondaryBody:field('secondaryBody'),showRules:false};
      else if(policySection==='login'||policySection==='online')values={kind:field('kind'),...(field('kind')==='yb'?{amount:num('amount')}:field('kind')==='item'?{cid:num('cid'),count:num('count')}:{})};
      else throw new AccountError('OPERATIONS_INVALID_SECTION');
      this.operations.update({revision:num('revision'),section:policySection,index:field('index')===''?undefined:num('index'),values,accounts:this.accounts,actorUin:session.uin,reason:field('reason')});
      return '配置已保存并生效；已有领取记录保留。';
    }
    if (op === 'logout') {this.accounts.revokeSession(session.token); return '';}
    if (op === 'disable' || op === 'enable') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED');
      this.admin.setDisabled({uin, disabled: op === 'disable', actorUin: session.uin, reason: field('reason')});
      return op === 'disable' ? '该账号已停用，其会话与票据已全部失效。' : '该账号已启用。';
    }
    if (op === 'reset') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED');
      const password = field('password'), confirm = field('confirm') === '' ? password : field('confirm');
      // The reset goes through the same coordination a disable uses: old web sessions, old
      // tickets and open game channels of that account all stop, not only the password row.
      this.admin.resetCredential({uin, password, confirm, actorUin: session.uin, reason: field('reason')});
      return '凭据已重置：该账号的旧会话、旧票据和进行中的游戏连接已全部失效。';
    }
    if (op === 'yuanbao') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED');
      const amount = Number(field('amount'));
      if (!Number.isInteger(amount)) throw new AccountError('INVALID_AMOUNT');
      const changed = this.admin.adjustYuanbao({uin, amount, reason: field('reason'), actorUin: session.uin});
      return `元宝调整完成：${changed.before} → ${changed.after}。`;
    }
    if (op === 'level') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED');
      const raw = field('level');
      if (!/^[0-9]+$/u.test(raw)) throw new AccountError('INVALID_PET_LEVEL');
      if (typeof this.admin.setPetLevel !== 'function') throw new AccountError('ACCOUNT_SERVICE_UNAVAILABLE');
      const changed = this.admin.setPetLevel({uin, level: Number(raw), reason: field('reason'), actorUin: session.uin});
      return `等级调整完成：${changed.before.level} → ${changed.after.level}，成长值 ${changed.after.growth}。请重新登录宠物查看。`;
    }
    if (op === 'vitals') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED');
      const values={};for(const key of ['hunger','cleanliness','mood','health']){
        const raw=field(key);if(!/^[0-9]+$/u.test(raw))throw new AccountError('INVALID_PET_VITALS','请填写四项整数数值');
        values[key]=Number(raw);
      }
      const changed=this.admin.setPetVitals({uin,...values,reason:field('reason'),actorUin:session.uin});
      return `数值已保存：饥饿 ${changed.after.hunger}，清洁 ${changed.after.cleanliness}，心情 ${changed.after.mood}，健康 ${changed.after.health}。`;
    }
    if (op === 'inventory') {
      if (!Number.isInteger(uin)) throw new AccountError('ACCOUNT_REQUIRED', '请指定账号');
      if (!this.economyAdmin) throw new AccountError('ACCOUNT_SERVICE_UNAVAILABLE', '这个装配没有启用经济模块，库存调整不可用。');
      const cid = Number(field('cid')), count = Number(field('count'));
      if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM', '商品编号无效');
      if (!Number.isInteger(count)) throw new AccountError('INVALID_COUNT', '请输入整数增减量');
      const changed = this.economyAdmin.adjustInventory({uin, cid, count, reason: field('reason'), actorUin: session.uin});
      return `库存调整完成（商品 ${changed.cid}）：${changed.before} → ${changed.after}。`;
    }
    if (op === 'backup') {
      if (!this.economyAdmin) throw new AccountError('ACCOUNT_SERVICE_UNAVAILABLE', '这个装配没有启用经济模块，备份不可用。');
      // The receipt object itself is the result: the caller stores it for the panel's
      // "last backup" line, and only a short summary rides the redirect.
      return this.economyAdmin.backupNow({actorUin: session.uin, reason: field('reason')});
    }
    if (op === 'shelve') {
      // Listing is a positive-price decision: the one-click shelf form carries the operator's
      // own price, and zero can never masquerade as a listing through it.
      const cid = Number(field('cid')), price = Number(field('price'));
      if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM');
      if (!Number.isInteger(price) || price < 1 || price > 1000000)
        throw new AccountError('INVALID_PRICE', '上架价格需为 1 到 1000000 之间的整数。');
      this.catalog.setLocalPrice({cid, price, reason: field('reason'), actorUin: session.uin});
      return `商品 ${cid} 已上架，本地价格 ${price}。`;
    }
    if (op === 'itemPolicy') {
      // Category and effect maintenance through the explicit migration path: the edit is
      // validated, its digest transition is recorded beside the catalogue, and it takes effect
      // at the next start. Nothing here edits the running process's catalogue.
      if (!this.economyAdmin) throw new AccountError('ACCOUNT_SERVICE_UNAVAILABLE', '这个装配没有启用经济模块，目录维护不可用。');
      const cid = Number(field('cid'));
      const fields = {};
      for (const key of AccountEconomyAdmin.ITEM_POLICY_FIELDS) if (field('f_' + key) !== '') fields[key] = field('f_' + key);
      const staged = this.economyAdmin.stageItemPolicy({cid, fields, reason: field('reason'), actorUin: session.uin});
      return `商品 ${cid} 目录修改已暂存（${staged.fields.join('、')}）。${staged.note}`;
    }
    if (op === 'price') {
      const cid = Number(field('cid')), price = Number(field('price'));
      if (!Number.isInteger(cid) || cid <= 0) throw new AccountError('INVALID_ITEM');
      if (!Number.isInteger(price) || price < 0 || price > 1000000) throw new AccountError('INVALID_PRICE');
      this.catalog.setLocalPrice({cid, price, reason: field('reason'), actorUin: session.uin});
      return price === 0 ? `商品 ${cid} 已下架（本地价格 0，不可售）。` : `商品 ${cid} 本地价格已保存为 ${price}。`;
    }
    throw new AccountError('INVALID_ADMIN_OPERATION');
  }
}

// The pages state what went wrong in terms the person can act on, without echoing a value back.
function accountMessage(error) {
  const messages = {
    OPERATIONS_REVISION_CONFLICT:'配置已被另一页面修改，请刷新后重试。',
    OPERATIONS_INVALID_NUMBER:'请填写范围内的非负整数。',
    OPERATIONS_INVALID_TASKS:'任务名称、说明或奖励超出允许范围。',
    OPERATIONS_INVALID_SIGN:'签到奖励格式或金额不正确。',
    OPERATIONS_INVALID_VIP_PRICES:'粉钻价格需填写 0 至 2147483647 之间的整数。',
    OPERATIONS_INVALID_NOTICE:'公告标题或正文为空、过长或含不可用字符。',
    OPERATIONS_INVALID_ACTIVITY:'活跃度奖励超出允许范围。',
    INVALID_REWARD_AMOUNT:'奖励数量须为 1 到 1000000 的整数。',
    REWARD_ITEM_UNAVAILABLE:'该物品编号不存在，请先在商品管理中检索。',
    INVALID_LOGIN_NAME: '账号需为 5-10 位数字。',
    INVALID_PASSWORD: '密码长度需为 8-128 个字符。',
    PASSWORD_MISMATCH: '两次输入的密码不一致。',
    REGISTRATION_NUMBER_RANGE: '注册号码须在 10000 到 4294967295 之间。',
    ACCOUNT_NUMBER_UNAVAILABLE: '此号码不可用，请选择其他号码。',
    LOGIN_NAME_TAKEN: '这个账号已经被注册。',
    ACCOUNT_DISABLED: '这个账号已被停用。',
    INVALID_NICKNAME: '昵称不符合要求：不能为空、不能含控制字符，且最多 15 字节。',
    NICKNAME_NOT_ENCODABLE: '昵称请使用常用汉字、英文字母、数字或英文标点。',
    INVALID_GENDER: '请选择性别。',
    PET_ALREADY_ADOPTED: '这个账号已经有宠物了。',
    ADOPTION_RETRY_CONFLICT: '同一次领养请求不能改变内容。',
    ADMIN_REQUIRED: '该账号没有管理权限。',
    ACCOUNT_REQUIRED: '请填写要操作的账号。',
    INVALID_AMOUNT: '请输入整数增减量。',
    INVALID_PET_LEVEL: `请输入 0 到 ${MAX_TEST_PET_LEVEL} 之间的整数等级。`,
    ACCOUNT_WITHOUT_PET: '这个账号还没有宠物。',
    ACCOUNT_MULTIPLE_PETS: '这个账号有多只宠物，无法确定要操作哪一只。',
    PET_PROFILE_MISSING: '宠物资料缺失，无法修改等级。',
    INVALID_COUNT: '请输入 -9999 到 9999 之间的整数增减量。',
    INVALID_ITEM: '商品编号无效。',
    INVALID_PRICE: '价格需为 0 到 1000000 之间的整数。',
    INVALID_ITEM_FIELDS: '目录修改没有通过商品合同校验。',
    POLICY_STAGING_UNAVAILABLE: '这个装配没有配置可维护的商品目录文件。',
    POLICY_UNCHANGED: '这次修改没有产生目录变化。',
    CARE_POLICY_CHANGED: '目录文件与运行中的目录不一致，请先重启服务再维护。',
    INVALID_CARE_UPGRADE_CONFIGURATION: '目录迁移记录文件无效，请检查 server/config/care-economy-upgrades.json。',
    ACCOUNT_SERVICE_UNAVAILABLE: '这个操作在当前装配里不可用。',
  };
  return messages[error?.code] ?? '操作未完成：' + (error?.code ?? 'UNKNOWN');
}
