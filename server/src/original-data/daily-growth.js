// One million equal buckets, represented by only 191 integer weights.
// Probability strictly decreases from 10 to 200; the 200-point award has
// exactly 1,000 / 1,000,000 = 0.1%. RNG state shares the daily claim transaction.
export const GROWTH_WEIGHTS=Object.freeze(Array.from({length:191},(_,i)=>
  1000+44*(190-i)+(i<190?55:0)+(i<170?1:0)));
export function drawDailyGrowth(seed) {
  let state=seed>>>0;
  do{state=(Math.imul(state,1664525)+1013904223)>>>0;}while(state>=4294000000);
  let bucket=state%1000000,index=0;
  while(bucket>=GROWTH_WEIGHTS[index])bucket-=GROWTH_WEIGHTS[index++];
  return {state,value:10+index};
}
