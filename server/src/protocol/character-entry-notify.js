// E-088: BasicProtocol 19AF0 consumes command 0554 as byte kind, BE16 text
// length + text, BE16 URL length + URL, BE32 action. Desktop 1B610 kind 0
// reaches 1B4A0; the first-message path selects native entry at 1B340.
// Review64: Desktop 1B4ED writes the wire action to MAIN (+8). Nonhidden
// 1B340 preserves it and sets only SUB (+0x244) to 201; Show owns the RID.
// 214 is an action carried by 0554, not a separate network command.
export const CHARACTER_ENTRY_NOTIFY_COMMAND = 0x0554;
export function encodeCharacterEntryNotify({firstAdoption=false,action=0,speech}={}) {
  if(typeof firstAdoption!=='boolean')throw new TypeError('INVALID_ENTRY_KIND');
  if(firstAdoption&&(action!==0&&action!==214||speech!==undefined))throw new TypeError('BIRTH_ENTRY_CONFLICT');
  return encodeServerAnimation({kind:0,action:firstAdoption?214:action,speech,allowBirth:firstAdoption});
}
import {encodePetSpeech} from './pet-speech.js';
export function encodeServerAnimation({kind=2,action,speech,allowBirth=false}){
  if(![0,2].includes(kind)||!Number.isInteger(action)||action<0||action>=10000000||action===214&&!allowBirth)throw new TypeError('INVALID_SERVER_ANIMATION');
  const body=speech===undefined?Buffer.alloc(9):encodePetSpeech(speech);
  body[0]=kind;body.writeUInt32BE(action,body.length-4);
  return body;
}
