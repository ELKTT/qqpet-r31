import {parseDeploymentEndpoints} from './endpoints.js';

// Explicit configuration is required for every non-loopback binding. Existing callers retain
// their original defaults. Conflicting legacy CLI/constructor values are never silently ignored.
export function resolveServerListener(service, {host, port, deploymentEndpoints,allowLegacyHttp80=false} = {}) {
  if (!['game', 'web'].includes(service)) throw new TypeError('INVALID_DEPLOYMENT_SERVICE');
  const config = deploymentEndpoints === undefined ? null : parseDeploymentEndpoints(deploymentEndpoints);
  const expected = config?.listen[service];
  if (expected && ((host !== undefined && host !== expected.ipv4) || (port !== undefined && port !== expected.port))) {
    throw new TypeError('DEPLOYMENT_LISTENER_CONFLICT');
  }
  host ??= expected?.ipv4 ?? '127.0.0.1';
  port ??= expected?.port ?? (service === 'game' ? 18001 : 18080);
  if (!config && host !== '127.0.0.1') throw new TypeError('listener requires exact IPv4 loopback 127.0.0.1');
  // The old ResourceDomain contract carries a host without a port. This one
  // explicitly configured complete assembly may bind its exact HTTP endpoint.
  const legacyHttp=allowLegacyHttp80===true&&service==='web'&&config&&host===config.listen.web.ipv4&&port===80;
  if (!Number.isInteger(port) || (port < 1024&&!legacyHttp) || port > 65535) throw new TypeError('port must be an unprivileged port');
  if (service === 'web' && config && !config.public.webOrigin.startsWith('http://')) {
    throw new TypeError('DEPLOYMENT_WEB_TLS_NOT_IMPLEMENTED');
  }
  return Object.freeze({host, port, config});
}
