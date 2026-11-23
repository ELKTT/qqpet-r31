const lunar=new Intl.DateTimeFormat('en-u-ca-chinese',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'});
if(lunar.resolvedOptions().calendar!=='chinese')throw new Error('CHINESE_CALENDAR_UNAVAILABLE');
export function beijingDate(now){
 if(!Number.isSafeInteger(now)||now<0||now>0xffffffff*1000)throw new TypeError('INVALID_ANIMATION_CLOCK');
 return new Date(now+8*3600000).toISOString().slice(0,10);
}
// Only the annual month/day is needed. February 29 is observed on that date in leap years.
export function annualBirthday(value){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||!/^\d{2}-\d{2}$/.test(value))throw new TypeError('INVALID_BIRTHDAY');
 const d=new Date('2000-'+value+'T00:00:00Z');
 if(!Number.isFinite(d.getTime())||d.toISOString().slice(5,10)!==value)throw new TypeError('INVALID_BIRTHDAY');
 return value;
}
export function petBirthdayDate(stored,adoptionTime){
 if(typeof stored==='string'&&stored.length)return stored;
 return Number.isSafeInteger(adoptionTime)&&adoptionTime>=0?beijingDate(adoptionTime):null;
}
function easter(year){
 const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),n=h+l-7*m+114;
 return [Math.floor(n/31),n%31+1];
}
export function animationHolidays(now){
 const date=beijingDate(now),[year,month,day]=date.split('-').map(Number),weekday=new Date(date+'T00:00:00Z').getUTCDay(),events=[];
 const fixed={'01-01':'newyear','02-14':'valentine','03-08':'women','04-01':'aprilfools','05-01':'labor','06-01':'children','09-10':'teachers','10-01':'national','12-25':'christmas'};
 if(fixed[date.slice(5)])events.push(fixed[date.slice(5)]);
 if(month===5&&weekday===0&&day>=8&&day<=14)events.push('mothers');
 if(month===6&&weekday===0&&day>=15&&day<=21)events.push('fathers');
 if(month===11&&weekday===4&&day>=22&&day<=28)events.push('thanksgiving');
 const [em,ed]=easter(year);if(month===em&&day===ed)events.push('easter');
 const parts=Object.fromEntries(lunar.formatToParts(now).map(p=>[p.type,p.value]));
 const festival={'1-1':'spring','5-5':'dragonboat','7-7':'qixi','8-15':'midautumn'}[parts.month+'-'+parts.day];
 // ICU marks intercalary months with "bis"; they deliberately do not match.
 if(festival)events.push(festival);
 return {date,events};
}
