// The zone and version block a derived account inherits, declared as its own configuration
// instead of being copied out of an account-bearing webdir document. The reference document's
// QQPenguin record carries the same values, but a fresh install has no record to copy them from,
// and the block is a server fact — which version lines this local build answers with, which
// loopback zone the client lands in — not an account fact.
//
// Nothing here invents an identity: the pet id and the name still come only from the store, and
// the zone port is always the game listener this server actually opens, never a configured one.

import {gameIpv4SAddr} from '../deployment/endpoints.js';

export const ZONE_TEMPLATE_KIND = "qqpet-local-webdir-zone-template";
export const ZONE_TEMPLATE_SCHEMA_VERSION = 1;

// The parsed form is the constructor's input shape, so a document is read and validated once at
// assembly time and the server only consumes the frozen result.
export function parseWebdirZoneTemplate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("zone template must be an object");
  }
  if (value.kind !== ZONE_TEMPLATE_KIND || value.schemaVersion !== ZONE_TEMPLATE_SCHEMA_VERSION) {
    throw new TypeError("zone template kind or schemaVersion is not recognised");
  }
  const versions = value.versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new TypeError("zone template requires a versions object");
  }
  const checked = {};
  for (const key of ["upgradetype", "loadver", "updatever", "kernelver"]) {
    const entry = versions[key];
    if (!Number.isInteger(entry) || entry < 0 || entry > 0xffffffff) {
      throw new TypeError(`zone template version ${key} must be a non-negative 32-bit integer`);
    }
    checked[key] = entry;
  }
  const kernelinfo = versions.kernelinfo ?? "";
  if (typeof kernelinfo !== "string" || kernelinfo.length > 256) {
    throw new TypeError("zone template kernelinfo must be a string of at most 256 characters");
  }
  checked.kernelinfo = kernelinfo;
  if (typeof value.resourceDomain !== "string" || value.resourceDomain.length === 0
      || value.resourceDomain.length > 253 || !/^[0-9A-Za-z.-]+$/.test(value.resourceDomain)) {
    throw new TypeError("zone template resourceDomain must be a host name without scheme or path");
  }
  for (const key of ["zoneId", "zoneArea"]) {
    const entry = value[key];
    if (!Number.isInteger(entry) || entry < 0 || entry > 0xffffffff) {
      throw new TypeError(`zone template ${key} must be a non-negative 32-bit integer`);
    }
  }
  return Object.freeze({
    kind: ZONE_TEMPLATE_KIND,
    schemaVersion: ZONE_TEMPLATE_SCHEMA_VERSION,
    versions: Object.freeze(checked),
    resourceDomain: value.resourceDomain,
    zoneId: value.zoneId,
    zoneArea: value.zoneArea,
  });
}

// Legacy callers use the game listener's loopback endpoint. Explicit deployment assembly passes
// the independently validated public endpoint (which can differ behind NAT).
export function zoneTemplateAgainstPort(template, gamePort, gameIpv4 = '127.0.0.1') {
  const parsed = parseWebdirZoneTemplate(template);
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535) throw new TypeError('INVALID_ZONE_PORT');
  const ip = gameIpv4SAddr(gameIpv4);
  return Object.freeze({
    versions: parsed.versions,
    lastZone: Object.freeze({ id: parsed.zoneId, ip, area: parsed.zoneArea, port: gamePort }),
    zone: Object.freeze({ id: parsed.zoneId, ip, port: gamePort }),
    resourceDomain: parsed.resourceDomain,
  });
}
