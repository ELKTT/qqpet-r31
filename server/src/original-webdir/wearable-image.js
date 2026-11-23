// What an image file is, decided by its bytes and nothing else.
//
// The wearable icons are content-addressed: the file name is the SHA-256 of the image, and the
// registry states the media type. Both the deployment check (tools/deploy-wearable-registry.mjs)
// and the serving boundary (wearable-catalogue.js resolveIcon) use this one implementation, so a
// file cannot pass the deployment check and still be served as an image it is not, and a file
// that was replaced after it was registered cannot be typed by its extension or its name.
//
// A PNG is walked chunk by chunk: the signature, an IHDR that is the first chunk with the
// documented field values, every chunk length inside the file, every chunk CRC (when the runtime
// provides one) and a final IEND. A truncated, re-purposed or hand-edited file fails this walk;
// GIF and JPEG keep their own magic plus their own terminator, which is what catches truncation
// for them.
import {crc32} from 'node:zlib';

export const MIN_IMAGE_BYTES = 45;                 // signature + a 13-byte IHDR + IEND
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;    // the icons are a few KB; the bound is a guard
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The four critical chunks; every other chunk is ancillary and is walked over, which is what the
// PNG specification asks a reader to do. An unknown *critical* chunk (an upper-case first letter)
// is refused instead: a reader that does not understand it cannot render the image.
const PNG_CRITICAL = Object.freeze(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const isCritical = (type) => type.charCodeAt(0) >= 0x41 && type.charCodeAt(0) <= 0x5a;
// The colour depth each PNG colour type allows, and the fields that must be zero/valid.
const PNG_DEPTHS = Object.freeze({0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]});

const chunkCrc = (bytes, type, data) =>
  (typeof crc32 === 'function' ? crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) : null);

function inspectPng(bytes) {
  let offset = 8;
  let chunks = 0;
  let sawIhdr = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return {type: null, code: 'PNG_TRUNCATED_CHUNK_HEADER'};
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) return {type: null, code: 'PNG_CHUNK_LENGTH_INVALID'};
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const crcStart = dataStart + length;
    if (crcStart + 4 > bytes.length) return {type: null, code: 'PNG_TRUNCATED_CHUNK'};
    if (!PNG_CRITICAL.includes(type) && isCritical(type))
      return {type: null, code: `PNG_CHUNK_UNKNOWN:${type}`};
    if (chunks === 0 && (type !== 'IHDR' || length !== 13)) return {type: null, code: 'PNG_IHDR_NOT_FIRST'};
    const expected = chunkCrc(bytes, type, bytes.subarray(dataStart, crcStart));
    if (expected !== null && bytes.readUInt32BE(crcStart) !== expected)
      return {type: null, code: `PNG_CHUNK_CRC:${type}`};
    if (type === 'IHDR') {
      const width = bytes.readUInt32BE(dataStart), height = bytes.readUInt32BE(dataStart + 4);
      const depth = bytes[dataStart + 8], colour = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10], filter = bytes[dataStart + 11];
      const interlace = bytes[dataStart + 12];
      if (width === 0 || height === 0) return {type: null, code: 'PNG_IHDR_EMPTY'};
      if (!PNG_DEPTHS[colour]) return {type: null, code: 'PNG_IHDR_COLOUR'};
      if (!PNG_DEPTHS[colour].includes(depth)) return {type: null, code: 'PNG_IHDR_DEPTH'};
      if (compression !== 0 || filter !== 0 || interlace > 1) return {type: null, code: 'PNG_IHDR_METHOD'};
      sawIhdr = true;
    }
    if (type === 'IEND') {
      if (length !== 0) return {type: null, code: 'PNG_IEND_NOT_EMPTY'};
      if (crcStart + 4 !== bytes.length) return {type: null, code: 'PNG_TRAILING_BYTES'};
      return sawIhdr ? {type: 'image/png'} : {type: null, code: 'PNG_IHDR_MISSING'};
    }
    offset = crcStart + 4;
    chunks += 1;
  }
  return {type: null, code: sawIhdr ? 'PNG_TRUNCATED' : 'PNG_IHDR_MISSING'};
}

// bytes -> {type} for an image this module accepts, or {type:null, code} naming why it does not.
export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes)) return {type: null, code: 'IMAGE_NOT_BYTES'};
  if (bytes.length < MIN_IMAGE_BYTES) return {type: null, code: 'IMAGE_TOO_SHORT'};
  if (bytes.length > MAX_IMAGE_BYTES) return {type: null, code: 'IMAGE_TOO_LARGE'};
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(bytes);
  const magic = bytes.toString('latin1', 0, 6);
  if (magic === 'GIF87a' || magic === 'GIF89a')
    return bytes[bytes.length - 1] === 0x3b ? {type: 'image/gif'} : {type: null, code: 'IMAGE_TRUNCATED_GIF'};
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      ? {type: 'image/jpeg'} : {type: null, code: 'IMAGE_TRUNCATED_JPEG'};
  return {type: null, code: 'IMAGE_NOT_AN_IMAGE'};
}
