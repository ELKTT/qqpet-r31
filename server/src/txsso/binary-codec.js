const DEFAULT_MAX_VALUE_LENGTH = 0xffff;

export class TxssoProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TxssoProtocolError";
    this.code = code;
  }
}

function requireBuffer(value, name) {
  if (!Buffer.isBuffer(value)) {
    throw new TxssoProtocolError("INVALID_ARGUMENT", `${name} must be a Buffer`);
  }
}

function requireUnsigned(value, maximum, name) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TxssoProtocolError(
      "INVALID_NUMBER",
      `${name} must be an unsigned integer no greater than ${maximum}`,
    );
  }
}

export class BinaryReader {
  constructor(buffer, { maxValueLength = DEFAULT_MAX_VALUE_LENGTH } = {}) {
    requireBuffer(buffer, "buffer");
    requireUnsigned(maxValueLength, 0x7fffffff, "maxValueLength");
    if (buffer.length > maxValueLength) {
      throw new TxssoProtocolError("VALUE_TOO_LARGE", "input exceeds the configured limit");
    }
    this.buffer = buffer;
    this.offset = 0;
    this.maxValueLength = maxValueLength;
  }

  get remainingLength() {
    return this.buffer.length - this.offset;
  }

  #require(length) {
    if (this.remainingLength < length) {
      throw new TxssoProtocolError("TRUNCATED_FIELD", "field extends past the input boundary");
    }
  }

  u8() {
    this.#require(1);
    const value = this.buffer[this.offset];
    this.offset += 1;
    return value;
  }

  u16() {
    this.#require(2);
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    this.#require(4);
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  fixed(length) {
    requireUnsigned(length, this.maxValueLength, "length");
    this.#require(length);
    const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  len16() {
    const length = this.u16();
    return this.fixed(length);
  }

  rest() {
    return this.fixed(this.remainingLength);
  }

  assertEnd() {
    if (this.remainingLength !== 0) {
      throw new TxssoProtocolError("TRAILING_BYTES", "unexpected bytes remain after decoding");
    }
  }
}

export class BinaryWriter {
  constructor({ maxValueLength = DEFAULT_MAX_VALUE_LENGTH } = {}) {
    requireUnsigned(maxValueLength, 0x7fffffff, "maxValueLength");
    this.maxValueLength = maxValueLength;
    this.chunks = [];
    this.length = 0;
  }

  #append(chunk) {
    if (this.length + chunk.length > this.maxValueLength) {
      throw new TxssoProtocolError("VALUE_TOO_LARGE", "encoded value exceeds the configured limit");
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
    return this;
  }

  u8(value) {
    requireUnsigned(value, 0xff, "value");
    return this.#append(Buffer.from([value]));
  }

  u16(value) {
    requireUnsigned(value, 0xffff, "value");
    const chunk = Buffer.allocUnsafe(2);
    chunk.writeUInt16BE(value, 0);
    return this.#append(chunk);
  }

  u32(value) {
    requireUnsigned(value, 0xffffffff, "value");
    const chunk = Buffer.allocUnsafe(4);
    chunk.writeUInt32BE(value, 0);
    return this.#append(chunk);
  }

  fixed(value, expectedLength) {
    requireBuffer(value, "value");
    if (expectedLength !== undefined && value.length !== expectedLength) {
      throw new TxssoProtocolError(
        "INVALID_FIELD_LENGTH",
        `field must contain exactly ${expectedLength} bytes`,
      );
    }
    return this.#append(Buffer.from(value));
  }

  len16(value) {
    requireBuffer(value, "value");
    if (value.length > 0xffff) {
      throw new TxssoProtocolError("FIELD_TOO_LARGE", "len16 field exceeds 65535 bytes");
    }
    this.u16(value.length);
    return this.fixed(value);
  }

  build() {
    return Buffer.concat(this.chunks, this.length);
  }
}
