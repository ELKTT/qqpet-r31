import {generateKeyPairSync,randomBytes,sign,X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {need} from './portable-common.mjs';

function der(tag,body){body=Buffer.from(body);let n=body.length,length=[];if(n<128)length=[n];else{while(n){length.unshift(n&255);n=Math.floor(n/256);}length.unshift(128|length.length);}return Buffer.concat([Buffer.from([tag,...length]),body]);}
const seq=(...values)=>der(0x30,Buffer.concat(values));
const oid=hex=>der(6,Buffer.from(hex,'hex'));
const rsaSha256=()=>seq(oid('2a864886f70d01010b'),der(5,[]));
const bool=value=>der(1,[value?255:0]);
function utc(date){need(date.getUTCFullYear()>=1950&&date.getUTCFullYear()<2050,'TLS_DATE_OUT_OF_RANGE');return der(0x17,Buffer.from(date.toISOString().slice(2,19).replace(/[-:T]/g,'')+'Z'));}
const pem=(kind,bytes)=>Buffer.from('-----BEGIN '+kind+'-----\n'+bytes.toString('base64').match(/.{1,64}/g).join('\n')+'\n-----END '+kind+'-----\n');

// Generate a portable RSA certificate entirely in memory; no Windows certificate-store writes.
export function createTlsKit(origin,now=new Date()){
  const match=/^https:\/\/((?:[0-9]{1,3}\.){3}[0-9]{1,3}):([1-9][0-9]{0,4})$/.exec(origin);
  need(match&&Number(match[2])<=65535&&match[1].split('.').every(n=>Number(n)<=255),'TLS_ORIGIN_INVALID');
  const ip=match[1],{privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const serial=randomBytes(20);serial[0]&=127;serial[0]|=1;
  const name=seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from(ip)))));
  const extension=(id,value,critical=false)=>seq(oid(id),...(critical?[bool(true)]:[]),der(4,value));
  const extensions=der(0xa3,seq(
    extension('551d11',seq(der(0x87,Buffer.from(ip.split('.').map(Number))))),
    extension('551d13',seq(),true),
    extension('551d25',seq(oid('2b06010505070301'))),
    extension('551d0f',der(3,[5,0xa0]),true)));
  const tbs=seq(der(0xa0,der(2,[2])),der(2,serial),rsaSha256(),name,
    seq(utc(new Date(now.getTime()-300000)),utc(new Date(now.getTime()+365*86400000))),name,
    publicKey.export({type:'spki',format:'der'}),extensions);
  const certificate=pem('CERTIFICATE',seq(tbs,rsaSha256(),der(3,Buffer.concat([Buffer.from([0]),sign('RSA-SHA256',tbs,privateKey)]))));
  const key=privateKey.export({type:'pkcs8',format:'pem'}),parsed=new X509Certificate(certificate);
  need(parsed.checkIP(ip)&&parsed.verify(publicKey)&&parsed.checkPrivateKey(privateKey),'TLS_CERTIFICATE_INVALID');
  need(createPublicKey(createPrivateKey(key)).export({type:'spki',format:'der'}).equals(publicKey.export({type:'spki',format:'der'})),'TLS_KEY_INVALID');
  return {certificate,key:Buffer.from(key),client:Buffer.from(JSON.stringify({schemaVersion:1,loginOrigin:origin,certificateSha256:parsed.fingerprint256.replaceAll(':','').toLowerCase()},null,2)+'\n')};
}
