import { QQCryptError, decryptQqBody, encryptQqBody } from "./qq-crypt.js";

export const ROOT_FRAME_HEADER_LENGTH = 17;
export const ROOT_FRAME_MAX_LENGTH = 8192;

export class RootFrameDecodeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RootFrameDecodeError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new RootFrameDecodeError("INVALID_ARGUMENT", `${name} must be a Buffer`);
  }
}

function requireUInt(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RootFrameDecodeError("INVALID_ARGUMENT", `${name} is outside its unsigned range`);
  }
}

function calculateChecksumWithZeroedField(raw) {
  const copy = Buffer.from(raw);
  if (copy.length >= ROOT_FRAME_HEADER_LENGTH) {
    copy[15] = 0;
    copy[16] = 0;
  }
  let checksum = 0;
  for (let offset = 0; offset + 1 < copy.length; offset += 2) {
    checksum ^= copy.readUInt16LE(offset);
  }
  return checksum & 0xffff;
}

function validateDeclaredLength(declaredLength, maximumFrameLength) {
  if (declaredLength === 0) {
    throw new RootFrameDecodeError("ZERO_LENGTH_FRAME", "declared frame length is zero");
  }
  if (declaredLength < ROOT_FRAME_HEADER_LENGTH) {
    throw new RootFrameDecodeError("FRAME_TOO_SHORT", "declared frame length is smaller than its header", {
      declaredLength,
      minimumLength: ROOT_FRAME_HEADER_LENGTH,
    });
  }
  if (declaredLength > maximumFrameLength) {
    throw new RootFrameDecodeError("FRAME_TOO_LARGE", "declared frame length exceeds the configured limit", {
      declaredLength,
      maximumFrameLength,
    });
  }
}

export function parseRootWireFrame(
  raw,
  { maximumFrameLength = ROOT_FRAME_MAX_LENGTH, verifyChecksum = true } = {},
) {
  requireBuffer(raw, "raw");
  if (raw.length < 2) {
    throw new RootFrameDecodeError("TRUNCATED_LENGTH", "frame does not contain its length field");
  }
  const declaredLength = raw.readUInt16BE(0);
  validateDeclaredLength(declaredLength, maximumFrameLength);
  if (raw.length !== declaredLength) {
    throw new RootFrameDecodeError("LENGTH_MISMATCH", "raw frame length differs from its declaration", {
      declaredLength,
      actualLength: raw.length,
    });
  }
  const checksum = raw.readUInt16BE(15);
  const calculatedChecksum = calculateChecksumWithZeroedField(raw);
  if (verifyChecksum && checksum !== calculatedChecksum) {
    throw new RootFrameDecodeError("CHECKSUM_MISMATCH", "root frame checksum does not match", {
      declaredLength,
    });
  }
  return {
    declaredLength,
    unknown_0x02: Buffer.from(raw.subarray(2, 10)),
    versionMajor: raw[10],
    versionMinor: raw[11],
    unknown_0x0c: raw[12],
    commandId: raw.readUInt16BE(13),
    checksum,
    wireBody: Buffer.from(raw.subarray(ROOT_FRAME_HEADER_LENGTH)),
    raw: Buffer.from(raw),
  };
}

export function encodeRootWireFrame({
  unknown_0x02,
  versionMajor,
  versionMinor,
  unknown_0x0c,
  commandId,
  wireBody,
}, { maximumFrameLength = ROOT_FRAME_MAX_LENGTH } = {}) {
  requireBuffer(unknown_0x02, "unknown_0x02");
  requireBuffer(wireBody, "wireBody");
  if (unknown_0x02.length !== 8) {
    throw new RootFrameDecodeError("INVALID_ARGUMENT", "unknown_0x02 must contain exactly 8 bytes");
  }
  requireUInt(versionMajor, 0xff, "versionMajor");
  requireUInt(versionMinor, 0xff, "versionMinor");
  requireUInt(unknown_0x0c, 0xff, "unknown_0x0c");
  requireUInt(commandId, 0xffff, "commandId");
  const declaredLength = ROOT_FRAME_HEADER_LENGTH + wireBody.length;
  validateDeclaredLength(declaredLength, maximumFrameLength);
  if (declaredLength > 0xffff) {
    throw new RootFrameDecodeError("FRAME_TOO_LARGE", "frame cannot fit its 16-bit length field");
  }

  const raw = Buffer.allocUnsafe(declaredLength);
  raw.writeUInt16BE(declaredLength, 0);
  unknown_0x02.copy(raw, 2);
  raw[10] = versionMajor;
  raw[11] = versionMinor;
  raw[12] = unknown_0x0c;
  raw.writeUInt16BE(commandId, 13);
  raw.writeUInt16BE(0, 15);
  wireBody.copy(raw, ROOT_FRAME_HEADER_LENGTH);
  raw.writeUInt16BE(calculateChecksumWithZeroedField(raw), 15);
  return raw;
}

export function parseRootFrame(raw, { encrypted = false, key, ...wireOptions } = {}) {
  const frame = parseRootWireFrame(raw, wireOptions);
  if (!encrypted) return { ...frame, body: Buffer.from(frame.wireBody), encrypted: false };
  try {
    return { ...frame, body: decryptQqBody(frame.wireBody, key), encrypted: true };
  } catch (error) {
    if (error instanceof QQCryptError) {
      throw new RootFrameDecodeError("INVALID_CIPHERTEXT", "root frame body could not be decrypted");
    }
    throw error;
  }
}

export function encodeRootFrame(
  { body, ...header },
  { encrypted = false, key, randomByte, maximumFrameLength = ROOT_FRAME_MAX_LENGTH } = {},
) {
  requireBuffer(body, "body");
  let wireBody = Buffer.from(body);
  if (encrypted) {
    try {
      wireBody = encryptQqBody(body, key, { randomByte });
    } catch (error) {
      if (error instanceof QQCryptError) {
        throw new RootFrameDecodeError("INVALID_CIPHERTEXT_CONTEXT", error.message);
      }
      throw error;
    }
  }
  return encodeRootWireFrame({ ...header, wireBody }, { maximumFrameLength });
}

export class RootFrameStreamDecoder {
  #buffer = Buffer.alloc(0);

  constructor({ maximumFrameLength = ROOT_FRAME_MAX_LENGTH, verifyChecksum = true } = {}) {
    this.maximumFrameLength = maximumFrameLength;
    this.verifyChecksum = verifyChecksum;
  }

  get remainder() {
    return Buffer.from(this.#buffer);
  }

  ingest(chunk) {
    requireBuffer(chunk, "chunk");
    if (chunk.length > 0) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];
    while (this.#buffer.length >= 2) {
      const declaredLength = this.#buffer.readUInt16BE(0);
      validateDeclaredLength(declaredLength, this.maximumFrameLength);
      if (this.#buffer.length < declaredLength) break;
      const raw = Buffer.from(this.#buffer.subarray(0, declaredLength));
      this.#buffer = Buffer.from(this.#buffer.subarray(declaredLength));
      frames.push(
        parseRootWireFrame(raw, {
          maximumFrameLength: this.maximumFrameLength,
          verifyChecksum: this.verifyChecksum,
        }),
      );
    }
    return frames;
  }

  end() {
    if (this.#buffer.length === 0) return [];
    throw new RootFrameDecodeError("TRUNCATED_FRAME", "stream ended with an incomplete root frame", {
      remainingLength: this.#buffer.length,
    });
  }
}

export class RootFrameSessionDecoder {
  constructor({
    maximumFrameLength = ROOT_FRAME_MAX_LENGTH,
    verifyChecksum = true,
    encrypted = false,
    key,
    knownCommandIds,
  } = {}) {
    this.decoder = new RootFrameStreamDecoder({ maximumFrameLength, verifyChecksum });
    this.encrypted = encrypted;
    this.key = key;
    this.knownCommandIds = knownCommandIds;
    this.closed = false;
    this.error = null;
  }

  #fail(error) {
    const structured =
      error instanceof RootFrameDecodeError
        ? error
        : new RootFrameDecodeError("MALFORMED_FRAME", "root frame processing failed");
    this.closed = true;
    this.error = structured.toJSON();
    return { frames: [], closed: true, error: this.error };
  }

  ingest(chunk) {
    if (this.closed) {
      return {
        frames: [],
        closed: true,
        error: { code: "SESSION_CLOSED", message: "session is already closed", details: {} },
      };
    }
    try {
      const wireFrames = this.decoder.ingest(chunk);
      const frames = wireFrames.map((wireFrame) => {
        if (this.knownCommandIds && !this.knownCommandIds.has(wireFrame.commandId)) {
          throw new RootFrameDecodeError("UNKNOWN_COMMAND", "command is not registered for this session", {
            commandId: wireFrame.commandId,
          });
        }
        return parseRootFrame(wireFrame.raw, { encrypted: this.encrypted, key: this.key });
      });
      return { frames, closed: false, error: null };
    } catch (error) {
      return this.#fail(error);
    }
  }

  end() {
    if (this.closed) return { frames: [], closed: true, error: this.error };
    try {
      this.decoder.end();
      this.closed = true;
      return { frames: [], closed: true, error: null };
    } catch (error) {
      return this.#fail(error);
    }
  }
}
