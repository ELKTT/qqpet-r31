import {encodeClientText} from './client-text.js';
// Desktop SHA5a01ae95: 1B610 kind=1 -> 1B4A0, copies nonempty info into
// ActionInfo's bubble text and queues action=0 through the existing speech path.
export function encodePetSpeech(text) {
  if(typeof text!=='string'||text.length===0||/[\x00-\x1f<>]/.test(text))throw new TypeError('INVALID_PET_SPEECH');
  const bytes=encodeClientText(text,{replaceUnrepresentable:true});if(bytes.length>511)throw new TypeError('PET_SPEECH_TOO_LONG');
  const length=Buffer.alloc(2);length.writeUInt16BE(bytes.length);
  return Buffer.concat([Buffer.from([1]),length,bytes,Buffer.alloc(6)]);
}
