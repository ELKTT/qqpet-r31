import { randomBytes as systemRandomBytes } from "node:crypto";

import { TxssoProtocolError } from "./binary-codec.js";

function requireIdentityNumber(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new TypeError(`${name} must be a nonzero unsigned 32-bit integer`);
  }
}

export class LocalServiceTicketIssuer {
  constructor({ randomBytes = systemRandomBytes } = {}) {
    if (typeof randomBytes !== "function") throw new TypeError("randomBytes must be a function");
    this.randomBytes = randomBytes;
    this.records = new Map();
    this.issueCount = 0;
    this.verifyCount = 0;
  }

  #random(size) {
    const value = this.randomBytes(size);
    if (!Buffer.isBuffer(value) || value.length !== size) {
      throw new TxssoProtocolError("INVALID_RANDOM_SOURCE", "randomBytes returned an invalid value");
    }
    return Buffer.from(value);
  }

  issue({ uin, serviceId }) {
    requireIdentityNumber(uin, "uin");
    requireIdentityNumber(serviceId, "serviceId");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ticket = this.#random(32);
      const key = ticket.toString("hex");
      if (this.records.has(key)) continue;
      this.records.set(key, Object.freeze({ uin, serviceId }));
      this.issueCount += 1;
      return ticket;
    }
    throw new TxssoProtocolError("TOKEN_COLLISION", "ticket source repeatedly produced duplicates");
  }

  verifyHex(signHex, { serviceId }) {
    requireIdentityNumber(serviceId, "serviceId");
    if (typeof signHex !== "string" || signHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(signHex)) {
      throw new TxssoProtocolError("INVALID_SERVICE_TICKET", "SSOSIGN is not a valid ticket encoding");
    }
    const record = this.records.get(signHex.toLowerCase());
    if (record === undefined || record.serviceId !== serviceId) {
      throw new TxssoProtocolError("INVALID_SERVICE_TICKET", "service ticket is unknown or mismatched");
    }
    this.verifyCount += 1;
    return Object.freeze({ uin: record.uin, serviceId: record.serviceId });
  }

  revoke(ticket) {
    if (!Buffer.isBuffer(ticket)) return false;
    return this.records.delete(ticket.toString("hex"));
  }

  summary() {
    return Object.freeze({
      activeTicketCount: this.records.size,
      issueCount: this.issueCount,
      verifyCount: this.verifyCount,
      sensitiveValuesPresent: false,
    });
  }
}
