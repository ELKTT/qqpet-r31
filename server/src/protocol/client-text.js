let reverse;
// Protocol text includes GBK punctuation and symbols as well as Chinese names.
// Keep account nickname validation separate from this display-text encoder.
export function encodeClientText(text,{replaceUnrepresentable=false}={}) {
  if(typeof text!=='string')throw new TypeError('INVALID_CLIENT_TEXT');
  if(!reverse){
    reverse=new Map();const decoder=new TextDecoder('gbk',{fatal:true});
    for(let lead=0x81;lead<=0xfe;lead++)for(let trail=0x40;trail<=0xfe;trail++) {
      if(trail===0x7f)continue;
      try{const character=decoder.decode(Uint8Array.of(lead,trail));if(character.length===1&&!reverse.has(character))reverse.set(character,[lead,trail]);}catch{}
    }
  }
  const bytes=[];
  for(const character of text){const code=character.codePointAt(0);
    if(code>=0x20&&code<=0x7e){bytes.push(code);continue;}
    const pair=reverse.get(character);
    if(pair)bytes.push(...pair);
    else if(replaceUnrepresentable)bytes.push(0x3f);
    else throw new TypeError('CLIENT_TEXT_NOT_ENCODABLE');
  }
  return Buffer.from(bytes);
}
