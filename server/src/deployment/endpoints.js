// Offline deployment contract. No listener, client patch or runtime assembly is imported here.
export const DEPLOYMENT_CONFIG_KIND = 'qqpet-deployment-endpoints';
export const MAX_DEPLOYMENT_CONFIG_BYTES = 16384;

export class DeploymentConfigError extends TypeError {
  constructor(field, code = 'INVALID_DEPLOYMENT_CONFIG') {
    // Field names are supplied by this module, never by the input or JSON parser.
    super(`${code}: ${field}`);
    this.code = code;
    this.field = field;
  }
}

function invalid(field) { throw new DeploymentConfigError(field); }
function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length !== keys.length
      || keys.some((key) => !Object.hasOwn(value, key))) invalid(field);
}
function ipv4(value, field) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) invalid(field);
  const octets = value.split('.').map(Number);
  if (octets.some((n) => n > 255) || octets[0] === 0 || octets[0] >= 224
      || (octets[0] === 169 && octets[1] === 254)) invalid(field);
  return value;
}
function port(value, field) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalid(field);
  return value;
}
// The unspecified address is only a bind target, never a published destination.
export function validateListenIpv4(value, field = 'listen.ipv4') {
  return value === '0.0.0.0' ? value : ipv4(value, field);
}
function endpoint(value, field, allowWildcard = false) {
  object(value, ['ipv4', 'port'], field);
  const host = allowWildcard ? validateListenIpv4(value.ipv4, `${field}.ipv4`) : ipv4(value.ipv4, `${field}.ipv4`);
  return Object.freeze({ipv4: host, port: port(value.port, `${field}.port`)});
}
function origin(value, field, httpsOnly = false) {
  // Validate before URL normalization can hide shortened/octal IPs, default ports or paths.
  const match = typeof value === 'string' && /^(https?):\/\/([0-9.]+):([1-9]\d{0,4})$/.exec(value);
  if (!match || (httpsOnly && match[1] !== 'https')) invalid(field);
  ipv4(match[2], field);
  port(Number(match[3]), field);
  return {value, ipv4: match[2]};
}
function loopback(value) { return value === '127.0.0.1'; }

export function gameIpv4SAddr(value) {
  ipv4(value, 'public.game.ipv4');
  const [a, b, c, d] = value.split('.').map(Number);
  // Keep the unsigned in_addr bit pattern internally; the webdir XML writer owns
  // signed atoi serialization. See ipv4-signed-static-20261008.json.
  return a + b * 256 + c * 65536 + d * 16777216;
}

export function parseDeploymentEndpoints(value) {
  object(value, ['kind', 'schemaVersion', 'deploymentId', 'mode', 'public', 'listen', 'internal', 'admin'], 'document');
  if (value.kind !== DEPLOYMENT_CONFIG_KIND || value.schemaVersion !== 1) invalid('kind/schemaVersion');
  if (typeof value.deploymentId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.deploymentId)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value.deploymentId)) invalid('deploymentId');
  if (!['local', 'remote'].includes(value.mode)) invalid('mode');
  object(value.public, ['loginOrigin', 'webOrigin', 'game'], 'public');
  object(value.listen, ['login', 'web', 'game'], 'listen');
  object(value.internal, ['communityOrigin', 'marketOrigin'], 'internal');
  object(value.admin, ['listen'], 'admin');
  const login = origin(value.public.loginOrigin, 'public.loginOrigin', true);
  const web = origin(value.public.webOrigin, 'public.webOrigin');
  const game = endpoint(value.public.game, 'public.game');
  const listen = Object.freeze(Object.fromEntries(['login', 'web', 'game'].map((key) =>
    [key, endpoint(value.listen[key], `listen.${key}`, value.mode === 'remote')])));
  const community = origin(value.internal.communityOrigin, 'internal.communityOrigin');
  const market = origin(value.internal.marketOrigin, 'internal.marketOrigin');
  const admin = endpoint(value.admin.listen, 'admin.listen');
  if (![community.ipv4, market.ipv4, admin.ipv4].every(loopback)) invalid('internal/admin must be exact loopback');
  const published = [login.ipv4, web.ipv4, game.ipv4];
  if (value.mode === 'local' && ![...published, ...Object.values(listen).map((e) => e.ipv4)].every(loopback)) {
    invalid('local mode requires exact loopback');
  }
  if (value.mode === 'remote' && published.some((ip) => ip.startsWith('127.'))) invalid('remote public endpoints');
  const bindings = [...Object.values(listen), admin].map((e) => `${e.ipv4}:${e.port}`);
  if (new Set(bindings).size !== bindings.length) invalid('duplicate listen endpoint');
  gameIpv4SAddr(game.ipv4);
  return Object.freeze({kind: DEPLOYMENT_CONFIG_KIND, schemaVersion: 1, deploymentId: value.deploymentId,
    mode: value.mode,
    public: Object.freeze({loginOrigin: login.value, webOrigin: web.value, game}),
    listen, internal: Object.freeze({communityOrigin: community.value, marketOrigin: market.value}),
    admin: Object.freeze({listen: admin})});
}

export function parseDeploymentEndpointsJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DEPLOYMENT_CONFIG_BYTES) invalid('document size');
  let value;
  try { value = JSON.parse(text); } catch { invalid('JSON syntax'); }
  return parseDeploymentEndpoints(value);
}
