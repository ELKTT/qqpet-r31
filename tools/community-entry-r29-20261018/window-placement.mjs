import {abcClass,Assembler,B,op} from '../animation-expansion-20261016/avm2.mjs';
export function windowPlacement(){
 const c=abcClass('QQPetWindowPlacement27'),{q,str}=c,ext=op(0x60,q('ExternalInterface','flash.external'));
 const call=(n,...v)=>B(ext,str(n),...v,op(0x4f,q('call'),v.length+1));
 const value=(n,...v)=>B(ext,str(n),...v,op(0x46,q('call'),v.length+1));
 const read=n=>value('DataCenter_ReadInt32',str('QQPET_WINDOW27_'+n));
 const write=(n,v)=>call('DataCenter_WriteInt32',str('QQPET_WINDOW27_'+n),v);
 const invoke=(n,...args)=>B(op(0x60,c.Class),...args,op(0x4f,q(n),args.length));
 const ci=c.addMethod(B(0xd0,0x30,0x47),{stack:1}),ctor=c.addMethod(B(0xd0,0x30,0xd0,op(0x49,0),0x47),{stack:1});
 function method(n,code,params=[],locals=params.length+1,stack=12){const id=c.addMethod(code,{params,locals,stack});c.methodTrait(n,id,true);}
 let a=new Assembler();a.emit(0xd0,0x30,0xd3,op(0x25,400)).jump(0x16,'end');
 a.emit(op(0x62,4),op(0x25,300)).jump(0x16,'end');
 a.emit(write('X',B(0xd1)),write('Y',B(0xd2)),write('W',B(0xd3)),write('H',op(0x62,4)),write('VALID',B(0x24,1)));
 a.label('end').emit(0x47);method('capture',a.output(),[q('Number'),q('Number'),q('Number'),q('Number')]);
 a=new Assembler();a.emit(0xd0,0x30,0xd1).jump(0x12,'end');
 a.emit(0xd1,0x70,str(','),op(0x46,q('split'),1),0xd6,0xd2,op(0x66,q('length')),0x24,4).jump(0x14,'end');
 const at=i=>B(0xd2,op(0x24,i),op(0x66,c.runtimeName()),0x75);
 a.emit(invoke('capture',at(0),at(1),at(2),at(3)));a.label('end').emit(0x47);
 method('rectangle',a.output(),[0],3);
 // Remember the real native Flash window name. Query its live rectangle when a
 // prompt appears, so moving the parent need not produce a child WM_MOVE event.
 method('restore',B(0xd0,0x30,B(op(0x60,q('QQPetSharedName28')),str('QQPET_WINDOW27_OWNER'),value('API.GetWindowName',B(0x24,0)),op(0x4f,q('write'),2)),
  invoke('rectangle',value('API.GetWindowPosition',B(0x24,1))),0x47));
 method('listen',B(0xd0,0x30,ext,str('APIEvent.OnWindowMove'),op(0x60,c.Class),op(0x66,q('capture')),op(0x4f,q('addCallback'),2),invoke('restore'),0x47));
 method('centerLater',B(0xd0,0x30,op(0x5d,q('setTimeout','flash.utils')),op(0x60,c.Class),op(0x66,q('center')),0x24,1,0xd1,0xd2,op(0x4f,q('setTimeout','flash.utils'),4),0x47),[q('Number'),q('Number')]);
 a=new Assembler();a.emit(0xd0,0x30,B(op(0x60,q('QQPetSharedName28')),str('QQPET_WINDOW27_OWNER'),op(0x46,q('read'),1)),op(0x63,5),op(0x62,5)).jump(0x12,'cached');
 a.emit(invoke('rectangle',value('API.GetWindowRect',op(0x62,5))));
 a.label('cached').emit(read('VALID'),0x24,1).jump(0x14,'screen');
 // The cached and screen branches must merge as Number in Flash 10.
 a.emit(read('X'),read('W'),0xd1,0xa1,0x24,2,0xa3,0xa0,0x75,0xd7,read('Y'),read('H'),0xd2,0xa1,0x24,2,0xa3,0xa0,0x75,op(0x63,4)).jump(0x10,'move');
 a.label('screen').emit(op(0x60,q('Capabilities','flash.system')),op(0x66,q('screenResolutionX')),0xd1,0xa1,0x24,2,0xa3,0xd7,
  op(0x60,q('Capabilities','flash.system')),op(0x66,q('screenResolutionY')),0xd2,0xa1,0x24,2,0xa3,op(0x63,4));
 // Omitted name selects the current message window in FlashEngine RVA 16F0.
 a.label('move').emit(call('API.MoveTo',B(0xd3),op(0x62,4)),0x47);method('center',a.output(),[q('Number'),q('Number')],6);
 return c.output({constructor:ctor,classInit:ci});
}
