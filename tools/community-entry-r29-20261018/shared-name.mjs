import {abcClass,Assembler,B,op} from '../animation-expansion-20261016/avm2.mjs';

// DataCenterAPI ReadString passes &buffer to a byte-copy API. Store bounded
// UTF-16 code units through the existing Int32 contract instead. These keys
// hold only native window names; they never contain account data.
export function sharedName(){
 const c=abcClass('QQPetSharedName28'),{q,str}=c;
 const ext=op(0x60,q('ExternalInterface','flash.external'));
 const key=suffix=>B(0xd1,str(suffix),0xa0);
 const cell=()=>B(key('_C'),0xd3,0xa0);
 const read=k=>B(ext,str('DataCenter_ReadInt32'),k,op(0x46,q('call'),2));
 const write=(k,v)=>B(ext,str('DataCenter_WriteInt32'),k,v,op(0x4f,q('call'),3));
 const method=(name,a,params,locals,returns=0)=>c.methodTrait(name,c.addMethod(a.output(),{params,locals,returns,stack:8}),true);
 const ci=c.addMethod(B(0xd0,0x30,0x47),{stack:1});
 const ctor=c.addMethod(B(0xd0,0x30,0xd0,op(0x49,0),0x47),{stack:1});
 // Flash 10 verifies all branch merges, including locals unused at return.
 // Initialize loop locals before guards and keep their types stable on backedges.
 let a=new Assembler();a.emit(0xd0,0x30,0x24,0,0xd7,write(key('_L'),B(0x24,0)),0xd2).jump(0x12,'end');
 a.emit(0xd2,op(0x66,q('length')),op(0x25,256)).jump(0x17,'end');
 a.emit(0x24,0,0xd7).jump(0x10,'test');
 a.label('each').emit(0x09,write(cell(),B(0xd2,0xd3,op(0x46,q('charCodeAt'),1))),op(0xc2,3));
 a.label('test').emit(0xd3,0xd2,op(0x66,q('length'))).jump(0x15,'each');
 a.emit(write(key('_L'),B(0xd2,op(0x66,q('length')))));a.label('end').emit(0x47);
 method('write',a,[q('String'),q('String')],4);
 a=new Assembler();a.emit(0xd0,0x30,0x24,0,0xd7,str(''),op(0x63,4),0x24,0,0x75,op(0x63,5),read(key('_L')),0x75,0xd6,0xd2,0x24,1).jump(0x16,'empty');
 a.emit(0xd2,op(0x25,256)).jump(0x17,'empty');
 a.emit(0xd2,0xd2,0x73).jump(0x14,'empty');
 a.emit(str(''),op(0x63,4),0x24,0,0xd7).jump(0x10,'test');
 a.label('each').emit(0x09,read(cell()),0x75,op(0x63,5),op(0x62,5),0x24,0).jump(0x16,'empty');
 a.emit(op(0x62,5),op(0x25,32767),0x24,2,0xa2,0x24,1,0xa0).jump(0x17,'empty');
 a.emit(op(0x62,5),op(0x62,5),0x73).jump(0x14,'empty');
 a.emit(op(0x62,4),op(0x60,q('String')),op(0x62,5),op(0x46,q('fromCharCode'),1),0xa0,0x70,op(0x63,4),op(0xc2,3));
 a.label('test').emit(0xd3,0xd2).jump(0x15,'each');
 a.emit(op(0x62,4),0x48);a.label('empty').emit(str(''),0x48);
 method('read',a,[q('String')],6,q('String'));
 return c.output({constructor:ctor,classInit:ci});
}
