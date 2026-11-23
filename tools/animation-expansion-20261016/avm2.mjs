import {deflateSync} from 'node:zlib';
import {swfStructure} from '../../server/src/deployment/swf-strings.js';
import {B,U} from '../gameplay-round4-20261015/local-desktop.mjs';
import {need} from '../complete-release/common.mjs';
export {B,U};
export const op=(n,...v)=>B(n,...v.map(U));
export const word=(n,size=2)=>{const b=Buffer.alloc(size);size===2?b.writeUInt16LE(n):b.writeUInt32LE(n);return b;};
export const tag=(n,b)=>B(word((n<<6)|63),word(b.length,4),b);
export class Assembler {
 constructor(){this.parts=[];this.labels=new Map();this.size=0;}
 emit(...v){const b=B(...v);this.parts.push({offset:this.size,b});this.size+=b.length;return this;}
 label(name){need(!this.labels.has(name),'DUPLICATE_AVM2_LABEL');this.labels.set(name,this.size);return this;}
 jump(code,name){this.parts.push({offset:this.size,code,name});this.size+=4;return this;}
 output(){return B(...this.parts.map(p=>{if(p.b)return p.b;need(this.labels.has(p.name),'MISSING_AVM2_LABEL:'+p.name);const v=Buffer.alloc(3);v.writeIntLE(this.labels.get(p.name)-p.offset-4,0,3);return B(p.code,v);}));}
}
// Re-encode existing branch destinations while preserving every untouched instruction.
export function editCode(body,{before=new Map(),replace=new Map(),after=new Map()}={}){
 const asm=new Assembler(),raw=Buffer.from(body.code,'hex');
 for(let i=0;i<body.instructions.length;i++){
  const ins=body.instructions[i],end=body.instructions[i+1]?.offset??raw.length;
  asm.label('old'+ins.offset);if(before.has(ins.offset))before.get(ins.offset)(asm);
  if(replace.has(ins.offset)){replace.get(ins.offset)(asm);}
  else if(ins.op==='lookupswitch')throw Error('SWITCH_RELOCATION_NOT_SUPPORTED');
  else if(['jump','iftrue','iffalse','ifeq','ifne','iflt','ifle','ifgt','ifge','ifstricteq','ifstrictne','ifnlt','ifnle','ifngt','ifnge'].includes(ins.op))asm.jump(raw[ins.offset],'old'+ins.values[0]);
  else asm.emit(raw.subarray(ins.offset,end));
  if(after.has(ins.offset))after.get(ins.offset)(asm);
 }
 asm.label('old'+raw.length);return asm.output();
}
// Minimal ABC writer: one class, explicit signatures/traits/scope depths, no compiler dependency.
export function abcClass(name,superPackage='',superName='Object'){
 // ABC string index 0 is reserved. An empty package URI must refer to a real
 // empty-string entry; using index 0 creates a wildcard namespace in Flash.
 const strings=['',''],spaces=[''],names=[null],methods=[],bodies=[],instanceTraits=[],classTraits=[],staticIds=new Set();
 const s=v=>{let n=strings.indexOf(v,1);if(n<0){n=strings.length;strings.push(v);}return n;};
 const q=(n,pkg='')=>{let ns=spaces.indexOf(pkg);if(ns<0){ns=spaces.length;spaces.push(pkg);}s(pkg);let id=names.findIndex(v=>v?.ns===ns+1&&strings[v.n]===n);if(id<0){id=names.length;names.push({ns:ns+1,n:s(n)});}return id;};
 const runtimeName=()=>{let n=names.findIndex(v=>v?.kind===27);if(n<0){n=names.length;names.push({kind:27});}return n;};
 const Class=q(name),Super=q(superName,superPackage),ObjectQ=q('Object');
 const str=v=>op(0x2c,s(v));
 const addMethod=(code,{params=[],returns=0,stack=8,locals=params.length+1,scope,maxScope,exceptions=[]}={})=>{const id=methods.length;methods.push(B(U(params.length),U(returns),...params.map(U),0,0));bodies.push({id,code,stack,locals,scope,maxScope,exceptions});return id;};
 const methodTrait=(n,id,isStatic=false)=>{(isStatic?classTraits:instanceTraits).push(B(U(q(n)),1,0,U(id)));if(isStatic)staticIds.add(id);};
 const slot=(n,type=0,isStatic=false)=>(isStatic?classTraits:instanceTraits).push(B(U(q(n)),0,0,U(type),0));
 function output({constructor,classInit,scriptAncestors}){
  const ancestors=scriptAncestors??[ObjectQ],code=B(0xd0,0x30,0x65,0,...ancestors.map(n=>B(op(0x60,n),0x30)),op(0x60,Super),op(0x58,0),...ancestors.map(()=>B(0x1d)),op(0x68,Class),0x47);
  const classDepth=ancestors.length+2,script=addMethod(code,{stack:2,locals:1,scope:1,maxScope:classDepth});
  const pool=B(1,1,1,U(strings.length),...strings.slice(1).map(v=>{const b=Buffer.from(v);return B(U(b.length),b);}),U(spaces.length+1),...spaces.map(v=>B(0x16,U(s(v)))),2,1,1,U(names.length),...names.slice(1).map(v=>v.kind===27?B(27,1):B(7,U(v.ns),U(v.n))));
  const encoded=bodies.map(v=>{const depth=v.scope??(v.id===classInit||staticIds.has(v.id)?classDepth:classDepth+1);return B(U(v.id),U(v.stack),U(v.locals),U(depth),U(v.maxScope??depth+1),U(v.code.length),v.code,U(v.exceptions.length),...v.exceptions.map(e=>B(...e.map(U))),0);});
  return B(word(16),word(46),pool,U(methods.length),...methods,0,1,U(Class),U(Super),0,0,U(constructor),U(instanceTraits.length),...instanceTraits,U(classInit),U(classTraits.length),...classTraits,1,U(script),1,U(Class),4,1,0,U(bodies.length),...encoded);
 }
 return{q,s,str,runtimeName,addMethod,methodTrait,slot,output,Class,Super};
}
export function insertAbc(raw,abc){const s=swfStructure(raw),at=s.tags.find(t=>t.code===82)?.start??s.tags.find(t=>t.code===1).start;const body=B(s.body.subarray(0,at),tag(82,B(word(0,4),0,abc)),s.body.subarray(at)),head=Buffer.from(raw.subarray(0,8));head.write('CWS');head[3]=Math.max(head[3],9);head.writeUInt32LE(body.length+8,4);return B(head,deflateSync(body));}
