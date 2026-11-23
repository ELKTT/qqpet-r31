import { randomBytes } from "node:crypto";

const BLOCK_LENGTH = 8;
const KEY_LENGTH = 16;
const TEA_ROUNDS = 16;
const TEA_SUM_STEP = 0x9e3779b9;
const TEA_DECRYPT_START = 0xe3779b90;

export class QQCryptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QQCryptError";
    this.code = code;
  }
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new QQCryptError("INVALID_ARGUMENT", `${name} must be a Buffer`);
  }
}

function requireKey(key) {
  requireBuffer(key, "key");
  if (key.length !== KEY_LENGTH) {
    throw new QQCryptError("INVALID_KEY", `key must contain exactly ${KEY_LENGTH} bytes`);
  }
}

function add32(left, right) {
  return (left + right) >>> 0;
}

function subtract32(left, right) {
  return (left - right) >>> 0;
}

function teaMix(value, sum, keyLeft, keyRight) {
  return (
    add32(sum, value) ^
    add32(keyLeft, (value << 4) >>> 0) ^
    add32(keyRight, value >>> 5)
  ) >>> 0;
}

function encryptTeaBlock(block, key) {
  let left = block.readUInt32BE(0);
  let right = block.readUInt32BE(4);
  const keyWords = [0, 4, 8, 12].map((offset) => key.readUInt32BE(offset));
  let sum = 0;
  for (let round = 0; round < TEA_ROUNDS; round += 1) {
    sum = add32(sum, TEA_SUM_STEP);
    left = add32(left, teaMix(right, sum, keyWords[0], keyWords[1]));
    right = add32(right, teaMix(left, sum, keyWords[2], keyWords[3]));
  }
  const result = Buffer.allocUnsafe(BLOCK_LENGTH);
  result.writeUInt32BE(left, 0);
  result.writeUInt32BE(right, 4);
  return result;
}

function decryptTeaBlock(block, key) {
  let left = block.readUInt32BE(0);
  let right = block.readUInt32BE(4);
  const keyWords = [0, 4, 8, 12].map((offset) => key.readUInt32BE(offset));
  let sum = TEA_DECRYPT_START;
  for (let round = 0; round < TEA_ROUNDS; round += 1) {
    right = subtract32(right, teaMix(left, sum, keyWords[2], keyWords[3]));
    left = subtract32(left, teaMix(right, sum, keyWords[0], keyWords[1]));
    sum = subtract32(sum, TEA_SUM_STEP);
  }
  const result = Buffer.allocUnsafe(BLOCK_LENGTH);
  result.writeUInt32BE(left, 0);
  result.writeUInt32BE(right, 4);
  return result;
}

function xorBlocks(left, right) {
  const result = Buffer.allocUnsafe(BLOCK_LENGTH);
  for (let index = 0; index < BLOCK_LENGTH; index += 1) {
    result[index] = left[index] ^ right[index];
  }
  return result;
}

function nextRandomByte(randomByte) {
  const value = randomByte();
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new QQCryptError("INVALID_RANDOM_BYTE", "randomByte must return an integer from 0 through 255");
  }
  return value;
}

function systemRandomByte() {
  return randomBytes(1)[0];
}

export function encryptedQqBodyLength(plaintextLength) {
  if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) {
    throw new QQCryptError("INVALID_LENGTH", "plaintextLength must be a non-negative safe integer");
  }
  const unalignedLength = plaintextLength + 10;
  const paddingLength = (BLOCK_LENGTH - (unalignedLength % BLOCK_LENGTH)) % BLOCK_LENGTH;
  return unalignedLength + paddingLength;
}

export function encryptQqBody(plaintext, key, { randomByte = systemRandomByte } = {}) {
  requireBuffer(plaintext, "plaintext");
  requireKey(key);
  if (typeof randomByte !== "function") {
    throw new QQCryptError("INVALID_ARGUMENT", "randomByte must be a function");
  }

  const encryptedLength = encryptedQqBodyLength(plaintext.length);
  const paddingLength = encryptedLength - plaintext.length - 10;
  const padded = Buffer.alloc(encryptedLength, 0);
  let offset = 0;
  padded[offset] = (nextRandomByte(randomByte) & 0xf8) | paddingLength;
  offset += 1;
  for (let index = 0; index < paddingLength; index += 1) {
    padded[offset] = nextRandomByte(randomByte);
    offset += 1;
  }
  padded[offset] = nextRandomByte(randomByte);
  padded[offset + 1] = nextRandomByte(randomByte);
  offset += 2;
  plaintext.copy(padded, offset);

  const ciphertext = Buffer.allocUnsafe(encryptedLength);
  let previousCiphertext = Buffer.alloc(BLOCK_LENGTH, 0);
  let previousXoredPlaintext = Buffer.alloc(BLOCK_LENGTH, 0);
  for (let blockOffset = 0; blockOffset < padded.length; blockOffset += BLOCK_LENGTH) {
    const plaintextBlock = padded.subarray(blockOffset, blockOffset + BLOCK_LENGTH);
    const xoredPlaintext = xorBlocks(plaintextBlock, previousCiphertext);
    const encryptedBlock = encryptTeaBlock(xoredPlaintext, key);
    const ciphertextBlock = xorBlocks(encryptedBlock, previousXoredPlaintext);
    ciphertextBlock.copy(ciphertext, blockOffset);
    previousCiphertext = ciphertextBlock;
    previousXoredPlaintext = xoredPlaintext;
  }
  return ciphertext;
}

export function decryptQqBody(ciphertext, key) {
  requireBuffer(ciphertext, "ciphertext");
  requireKey(key);
  if (ciphertext.length < BLOCK_LENGTH * 2 || ciphertext.length % BLOCK_LENGTH !== 0) {
    throw new QQCryptError(
      "INVALID_CIPHERTEXT",
      "ciphertext must contain at least two complete 8-byte blocks",
    );
  }

  const padded = Buffer.allocUnsafe(ciphertext.length);
  let previousCiphertext = Buffer.alloc(BLOCK_LENGTH, 0);
  let previousXoredPlaintext = Buffer.alloc(BLOCK_LENGTH, 0);
  for (let blockOffset = 0; blockOffset < ciphertext.length; blockOffset += BLOCK_LENGTH) {
    const ciphertextBlock = ciphertext.subarray(blockOffset, blockOffset + BLOCK_LENGTH);
    const teaInput = xorBlocks(ciphertextBlock, previousXoredPlaintext);
    const xoredPlaintext = decryptTeaBlock(teaInput, key);
    const plaintextBlock = xorBlocks(xoredPlaintext, previousCiphertext);
    plaintextBlock.copy(padded, blockOffset);
    previousCiphertext = Buffer.from(ciphertextBlock);
    previousXoredPlaintext = xoredPlaintext;
  }

  const paddingLength = padded[0] & 0x07;
  const plaintextLength = padded.length - paddingLength - 10;
  const plaintextOffset = paddingLength + 3;
  if (plaintextLength < 0 || plaintextOffset + plaintextLength + 7 !== padded.length) {
    throw new QQCryptError("INVALID_CIPHERTEXT", "ciphertext padding length is invalid");
  }
  for (let offset = padded.length - 7; offset < padded.length; offset += 1) {
    if (padded[offset] !== 0) {
      throw new QQCryptError("INVALID_CIPHERTEXT", "ciphertext trailing padding is invalid");
    }
  }
  return Buffer.from(padded.subarray(plaintextOffset, plaintextOffset + plaintextLength));
}
