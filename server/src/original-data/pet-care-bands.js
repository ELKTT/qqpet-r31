export const careMaximum=level=>3000+100*Math.min(level,30);
export const proportionalCare=gameplay=>gameplay?.feedbackRules?.revision===2;
export function lowCare(state,gameplay){
 const maximum=careMaximum(state.level);
 return proportionalCare(gameplay)
  ?{hunger:state.hunger*100<=maximum*24,cleanliness:state.cleanliness*100<=maximum*48}
  :{hunger:state.hunger<gameplay.lowHunger,cleanliness:state.cleanliness<gameplay.lowCleanliness};
}
