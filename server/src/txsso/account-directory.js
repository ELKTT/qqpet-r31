import { timingSafeEqual } from "node:crypto";

import { TxssoProtocolError } from "./binary-codec.js";

function decodeAccountWire(value) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 512) {
    throw new TxssoProtocolError("INVALID_ACCOUNT", "account wire value has an invalid length");
  }
  let decoded;
  if (value.length % 2 === 0 && value.every((byte, index) => index % 2 === 0 || byte === 0)) {
    decoded = value.toString("utf16le");
  } else if (
    value.length % 2 === 0 &&
    value.every((byte, index) => index % 2 === 1 || byte === 0)
  ) {
    const swapped = Buffer.allocUnsafe(value.length);
    for (let index = 0; index < value.length; index += 2) {
      swapped[index] = value[index + 1];
      swapped[index + 1] = value[index];
    }
    decoded = swapped.toString("utf16le");
  } else {
    decoded = value.toString("utf8");
  }
  if (decoded.includes("\ufffd") || decoded.includes("\0")) {
    throw new TxssoProtocolError("INVALID_ACCOUNT", "account wire value is not canonical text");
  }
  return decoded.toLowerCase();
}

// A null digest is a real state, not an error: it means this account is not verifiable with the
// legacy value at all, so the compatibility path must refuse it rather than the whole assembly.
function parsePasswordMd5Hex(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new TypeError("passwordMd5Hex must contain exactly 32 hexadecimal characters");
  }
  return Buffer.from(value, "hex");
}

export class LocalAccountDirectory {
  constructor(accounts) {
    // Zero accounts is a real state, not a broken one: a fresh install has no account until the
    // registration page creates the first one. An assembly that cannot serve an account without
    // this directory says so itself at authentication time; the directory only validates the
    // entries it is given.
    if (!Array.isArray(accounts)) {
      throw new TypeError("accounts must be an array");
    }
    this.byAccount = new Map();
    this.uins = new Set();
    for (const entry of accounts) {
      if (entry === null || typeof entry !== "object") throw new TypeError("account entry is invalid");
      if (typeof entry.account !== "string" || entry.account.length === 0 || entry.account.length > 256) {
        throw new TypeError("account must be a non-empty string no longer than 256 characters");
      }
      if (!Number.isInteger(entry.uin) || entry.uin <= 0 || entry.uin > 0xffffffff) {
        throw new TypeError("uin must be a nonzero unsigned 32-bit integer");
      }
      const canonical = entry.account.toLowerCase();
      if (this.byAccount.has(canonical) || this.uins.has(entry.uin)) {
        throw new TypeError("account and uin values must be unique");
      }
      this.byAccount.set(
        canonical,
        Object.freeze({
          canonical,
          uin: entry.uin,
          passwordMd5: parsePasswordMd5Hex(entry.passwordMd5Hex),
        }),
      );
      this.uins.add(entry.uin);
    }
  }

  resolveWire(accountWire) {
    const entry = this.byAccount.get(decodeAccountWire(accountWire));
    if (entry === undefined) {
      throw new TxssoProtocolError("UNKNOWN_ACCOUNT", "account authentication failed");
    }
    return entry;
  }

  verifyCredential(entry, credential) {
    if (!Buffer.isBuffer(credential) || credential.length !== 16) return false;
    if (entry.passwordMd5 === null) return false;
    return timingSafeEqual(entry.passwordMd5, credential);
  }

  get size() {
    return this.byAccount.size;
  }
}
