import {createPrivateKey, X509Certificate} from 'node:crypto';
import {existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomic, json, readJson, safe} from './tools/complete-release/common.mjs';
import {parseDeploymentEndpoints} from './server/src/deployment/endpoints.js';
import {DEFAULT_RUNTIME_LOG} from './server/src/runtime/runtime-log.js';
import {createTlsKit} from './tools/windows-delivery/tls-kit.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const baseline = 'qqpet-complete-20261022-mainline-r31';
const manifestSha256 = 'b0e99a1f75ced6c34b3930d377021049f8af6675b6f9c0375c4636a98694a324';
const part = process.platform === 'win32' ? 'windows-server' : 'linux-server';
const usage = 'node start-server.mjs [--deployment] [--check | --initialize | --check-ports | --logging on|off|info|debug]';

function prepareTls(origin, deployed) {
  const directory = safe(root, 'tls', {missing: true});
  if (!existsSync(directory)) {
    if (deployed) throw Error('部署目录缺少配对用的 tls 文件夹。');
    const kit = createTlsKit(origin);
    const temporary = mkdtempSync(path.join(root, 'tls-setup-'));
    try {
      writeFileSync(path.join(temporary, 'server-key.pem'), kit.key, {mode: 0o600, flag: 'wx'});
      writeFileSync(path.join(temporary, 'server-cert.pem'), kit.certificate, {flag: 'wx'});
      try {
        renameSync(temporary, directory);
      } catch (error) {
        if (!existsSync(directory)) throw error;
      }
    } finally {
      rmSync(temporary, {recursive: true, force: true});
    }
  }
  const certificate = new X509Certificate(readFileSync(safe(root, 'tls/server-cert.pem')));
  const key = createPrivateKey(readFileSync(safe(root, 'tls/server-key.pem')));
  if (!certificate.checkPrivateKey(key) || !certificate.checkIP(new URL(origin).hostname)) {
    throw Error('本地 TLS 证书与私钥或监听地址不匹配。');
  }
  const pin = {
    schemaVersion: 1,
    loginOrigin: origin,
    certificateSha256: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
  };
  const name = 'client-login.json';
  if (existsSync(safe(root, name, {missing: true}))) {
    const current = readJson(root, name);
    if (Object.keys(pin).some(field => current[field] !== pin[field])) {
      throw Error('client-login.json 与本机 TLS 配对不一致，请恢复同一套配置。');
    }
  } else {
    if (deployed) throw Error('部署目录缺少配对配置 client-login.json。');
    atomic(root, name, json(pin));
  }
}

function preparePackageState(files) {
  const state = {
    kind: 'qqpet-complete-package', schemaVersion: 1, status: 'ready',
    part, baseline, files,
  };
  const name = 'package-state.json';
  if (existsSync(safe(root, name, {missing: true}))) {
    const current = readJson(root, name);
    const previousFiles = Array.isArray(current.files) ? current.files : [];
    const byPath = new Map(previousFiles.map(file => [file.path, file]));
    if (current.baseline !== baseline || current.part !== part ||
        previousFiles.length !== files.length || files.some(file => {
          const previous = byPath.get(file.path);
          return !previous || previous.size !== file.size || previous.sha256 !== file.sha256;
        })) {
      throw Error('此目录的 package-state.json 属于其他装配，请在独立源码目录启动。');
    }
  } else {
    atomic(root, name, json(state));
  }
}

function validateDeployment(files, endpoints) {
  const release = readJson(root, 'RELEASE.json');
  const state = readJson(root, 'package-state.json');
  if (release.kind !== 'qqpet-complete-release' || release.schemaVersion !== 1 ||
      release.baseline !== baseline || release.acceptedManifestSha256 !== manifestSha256 ||
      state.kind !== 'qqpet-complete-package' || state.schemaVersion !== 1 ||
      state.baseline !== baseline || state.status !== 'ready' || state.part !== part ||
      !Array.isArray(state.files)) {
    throw Error('请在当前平台对应的 r31 服务端部署目录运行。');
  }
  // Resource hashes change with the address. Compare the complete path inventory
  // here. The frozen service checks the current package hashes before starting.
  const platformFiles = part === 'windows-server'
    ? ['QQPetServer.exe', '启动服务端.cmd', '关闭运行日志.cmd', '开启详细日志.cmd']
    : ['QQPetServer', 'start.sh', 'logging.sh'];
  const expected = new Set([
    ...files.map(file => file.path), ...platformFiles, 'RELEASE.json',
    'licenses/Node-LICENSE.txt', 'client-login.json', 'tls/server-cert.pem', 'tls/server-key.pem',
  ]);
  if (state.files.length !== expected.size || state.files.some(file => !expected.delete(file.path))) {
    throw Error('服务端部署清单与 r31 所需文件不一致。');
  }
  const directory = readJson(root, 'server/config/community-home.json').directory;
  if (endpoints.public.loginOrigin !== `https://${state.ip}:18443` ||
      endpoints.public.webOrigin !== `http://${state.ip}:${state.webPort}` ||
      endpoints.public.game.ipv4 !== state.ip || endpoints.listen.web.port !== state.webPort ||
      Object.values(endpoints.listen).some(endpoint => endpoint.ipv4 !== state.listenIp) ||
      directory.host !== state.listenIp || directory.publicIpv4 !== state.ip ||
      directory.port !== state.directoryPort || directory.resourcePort !== state.webPort ||
      directory.resourceDomain !== new URL(endpoints.public.webOrigin).host) {
    throw Error('登录、资源或社区地址与当前部署清单不一致。');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const deployed = args[0] === '--deployment';
  if (deployed) args.shift();
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  const valid = args.length === 0 ||
    (args.length === 1 && ['--check', '--initialize', '--check-ports'].includes(args[0])) ||
    (args.length === 2 && args[0] === '--logging' && ['on', 'off', 'info', 'debug'].includes(args[1]));
  if (!valid) throw Error(usage);
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('需要 Node.js 24 或更新版本。');
  const resources = readJson(root, 'resources-manifest.json');
  if (resources.format !== 2 || resources.baseline !== baseline || !Array.isArray(resources.files) ||
      !Array.isArray(resources.coreFiles) || !resources.files.length || !resources.coreFiles.length) {
    throw Error('请使用与 r31 源码配套的资源清单。');
  }
  const files = [...resources.coreFiles, ...resources.files];
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length) {
    throw Error('r31 运行文件与图形素材清单中有重复路径。');
  }
  const settings = 'server/config/endpoints.json';
  if (!existsSync(safe(root, settings, {missing: true}))) {
    throw Error('缺少源码包中的运行配置 server/config/endpoints.json，请重新解压同版源码包。');
  }
  const endpoints = parseDeploymentEndpoints(readJson(root, settings));
  if (deployed) {
    validateDeployment(files, endpoints);
  } else {
    if (endpoints.mode !== 'local' || endpoints.public.loginOrigin !== 'https://127.0.0.1:18443') {
      throw Error('使用独立部署配置时，请指定 --deployment 参数。');
    }
    if (!existsSync(safe(root, resources.files[0].path, {missing: true}))) {
      throw Error('请按 resources-manifest.json 中的相对路径补齐自行收集的 r31 素材，再运行 python verify-resources.py .。');
    }
    preparePackageState(files);
  }
  prepareTls(endpoints.public.loginOrigin, deployed);
  if (!existsSync(safe(root, 'runtime-log.json', {missing: true}))) {
    atomic(root, 'runtime-log.json', json(DEFAULT_RUNTIME_LOG));
  }
  const {serve} = await import('./tools/complete-release/service.mjs');
  try {
    await serve(root, args);
  } catch (error) {
    if (['COMPLETE_FILE_MISSING', 'COMPLETE_PACKAGE_FILE_CHANGED'].includes(error.message)) {
      throw Error('服务端文件缺失或版本不符。请运行 python verify-resources.py .，按当前清单核对路径和 SHA-256。');
    }
    throw error;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
