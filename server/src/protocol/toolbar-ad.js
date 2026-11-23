export const TOOLBAR_AD_COMMAND = 0x0563;

export function decodeToolbarAdRequest(body) {
  if (!Buffer.isBuffer(body) || body.length !== 0) throw new TypeError('INVALID_TOOLBAR_AD_REQUEST');
  return {type:'ToolbarAdRequest'};
}

// Only the statically established native "no dynamic image" branch is supported.
// The two words are opaque explicit inputs, not invented status/id semantics.
export function encodeNoToolbarAdvertisement(value) {
  if (!value || Object.keys(value).length !== 2 || !/^[0-9a-f]{4}$/i.test(value.unknownPrefixHex ?? '') ||
      !/^[0-9a-f]{8}$/i.test(value.unknownIdHex ?? '')) throw new TypeError('INVALID_TOOLBAR_AD_PROFILE');
  return Buffer.concat([Buffer.from(value.unknownPrefixHex+value.unknownIdHex,'hex'),
    Buffer.from('000000000000','hex')]); // Three explicit empty BE16 strings.
}
