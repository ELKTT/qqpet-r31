// ORIG-CARE-ANIMATION-001: BasicProtocol RVA 19AF0 decodes 0554 as
// u8 kind | BE16 info length + bytes | BE16 URL length + bytes | BE32 action.
// Desktop RVA 1B430 submits kind 2 directly to the original action queue,
// bypassing the first-entry latch. Config maps 511 to eat_food and 512 to wash.
export function encodeCareActionNotify(action) {
  const actions={feed:511,clean:512,medicine:213,revive:42,death:41,'death-transition':33,sick:31,'sick-heavy':31,'sick-critical':31,hungry:501,dirty:502,leave:202};
  if(!Object.hasOwn(actions,action))throw new TypeError('INVALID_CARE_ACTION');
  const body=Buffer.alloc(9);
  body[0]=2;
  body.writeUInt32BE(actions[action],5);
  return body;
}
