import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {createClient} from '../src/index';
const require=createRequire(import.meta.url);
const md4=require('js-md4');
const digest=(s:string)=>crypto.createHash('md5').update(s).digest('hex');
const sha=(s:string)=>crypto.createHash('sha256').update(s).digest('hex');
const hmac=(key:any,s:any,alg='sha256')=>crypto.createHmac(alg,key).update(s).digest();
const percent=(s:string)=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const fields=(s:string)=>Object.fromEntries([...s.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1],m[2] ?? m[3]]));
const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const challenge=Buffer.from('1234567890abcdef','hex');
let origin='';
const requests:any[]=[];
const server=http.createServer((req,res)=>{
 const authorization=req.headers.authorization || '';const url=new URL(req.url!,origin);requests.push({path:url.pathname,authorization,headers:req.headers,url});
 const fail=(message:string)=>{res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({message}));};
 try {
  if(url.pathname==='/digest'){
   if(!authorization){res.writeHead(401,{'WWW-Authenticate':'Digest realm="fixture", nonce="fixed-nonce", qop="auth", algorithm=MD5'});res.end();return;}
   const p=fields(authorization);const expected=digest(`${digest('user:fixture:password')}:fixed-nonce:${p.nc}:${p.cnonce}:auth:${digest('GET:'+p.uri)}`);
   if(p.response!==expected)return fail('Invalid digest response');
  }
  if(url.pathname==='/ntlm'){
   if(!authorization){res.writeHead(401,{'WWW-Authenticate':'NTLM'});res.end();return;}
   const b=Buffer.from(authorization.replace(/^NTLM /,''),'base64');
   if(b.readUInt32LE(8)===1){const domain=Buffer.from('LAB','utf16le');const t=Buffer.alloc(48+domain.length+4);t.write('NTLMSSP\0');t.writeUInt32LE(2,8);t.writeUInt16LE(domain.length,12);t.writeUInt16LE(domain.length,14);t.writeUInt32LE(48,16);t.writeUInt32LE(0x00888205,20);challenge.copy(t,24);t.writeUInt16LE(4,40);t.writeUInt16LE(4,42);t.writeUInt32LE(48+domain.length,44);domain.copy(t,48);res.writeHead(401,{'WWW-Authenticate':'NTLM '+t.toString('base64')});res.end();return;}
   if(b.readUInt32LE(8)!==3)return fail('Expected NTLM authenticate');
   const nt=b.subarray(b.readUInt32LE(24),b.readUInt32LE(24)+b.readUInt16LE(20));
   const pw=Buffer.from(md4.arrayBuffer(Buffer.from('password','utf16le')));const key=hmac(pw,Buffer.from('USERLAB','utf16le'),'md5');
   const proof=hmac(key,Buffer.concat([challenge,nt.subarray(16)]),'md5');if(!proof.equals(nt.subarray(0,16)))return fail('Invalid NTLMv2 proof');
  }
  if(url.pathname==='/oauth1'){
   const p=fields(authorization);const signature=decodeURIComponent(p.oauth_signature || '');delete p.oauth_signature;
   const normalized=Object.entries(p).map(([k,v])=>[percent(k),percent(decodeURIComponent(v))]).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}=${v}`).join('&');
   const base=['GET',percent(origin+'/oauth1'),percent(normalized)].join('&');
   if(signature!==hmac('consumer-secret&token-secret',base,'sha1').toString('base64'))return fail('Invalid OAuth1 signature');
  }
  if(url.pathname==='/hawk'){
   const p=fields(authorization);const normalized=`hawk.1.header\n${p.ts}\n${p.nonce}\nGET\n/hawk\n127.0.0.1\n${url.port}\n\n\n`;
   if(p.mac!==hmac('hawk-secret',normalized).toString('base64'))return fail('Invalid Hawk MAC');
  }
  if(url.pathname==='/jwt'||url.pathname==='/asap'){
   const parts=authorization.replace(/^Bearer /,'').split('.');const unsigned=parts.slice(0,2).join('.');const sig=Buffer.from(parts[2] || '','base64url');
   const valid=url.pathname==='/jwt'?hmac('jwt-secret',unsigned).equals(sig):crypto.verify('RSA-SHA256',Buffer.from(unsigned),pair.publicKey,sig);
   if(!valid)return fail('Invalid JWT signature');
  }
  if(url.pathname==='/aws4'){
   const match=/Credential=access-key\/([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=(\w+)/.exec(authorization);if(!match)return fail('Missing AWS signature: '+authorization);
   const scope=match[1];const [day,region,service]=scope.split('/');const signed=match[2];const headers=signed.split(';').map(k=>`${k}:${String(req.headers[k] || '').trim()}\n`).join('');
   const canonical=['GET','/aws4','',headers,signed,sha('')].join('\n');const toSign=['AWS4-HMAC-SHA256',req.headers['x-amz-date'],scope,sha(canonical)].join('\n');
   const key=hmac(hmac(hmac(hmac('AWS4aws-secret',day),region),service),'aws4_request');if(hmac(key,toSign).toString('hex')!==match[3])return fail('Invalid AWS signature');
  }
  if(url.pathname==='/edgegrid'){
   const signed=authorization.slice(0,authorization.indexOf('signature='));const stamp=/timestamp=([^;]+)/.exec(signed)?.[1] || '';const signingKey=hmac('edge-secret',stamp).toString('base64');const input=['GET','http',req.headers.host,'/edgegrid','','',signed].join('\t');
   if(authorization!==signed+'signature='+hmac(signingKey,input).toString('base64'))return fail('Invalid EdgeGrid signature');
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authorization,headers:req.headers,query:Object.fromEntries(url.searchParams)}));
 }catch(error){fail(String(error));}
});
beforeAll(async()=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;});
afterAll(()=>{server.closeAllConnections();server.close();});
async function send(type:string,auth:any={},route=type,extra:any={}){
 const path='/'+route;const spec={openapi:'3.2.0',info:{title:'Authentication fixtures',version:'1'},servers:[{url:origin}],paths:{[path]:{get:{responses:{200:{description:'Authenticated'}}}}}};
 const result=await createClient().send({spec,target:{path,method:'get'},auth:{type,...auth},...extra} as any);
 expect(result.error,JSON.stringify(result.error)).toBeUndefined();expect(result.response.status,JSON.stringify(result.response.body)).toBe(200);return result;
}
describe('every advertised HTTP authentication over a real local transport',()=>{
 it('none sends no authorization',async()=>expect((await send('none')).response.body).toHaveProperty('authorization',''));
 it('Basic preserves UTF-8 username and password',async()=>expect((await send('basic',{username:'用户',password:'p:a'})).response.body).toHaveProperty('authorization','Basic '+Buffer.from('用户:p:a').toString('base64')));
 it('Bearer resolves scoped variables',async()=>expect((await send('bearer',{token:'{{token}}'},'bearer',{variables:{token:'bearer-token'}})).response.body).toHaveProperty('authorization','Bearer bearer-token'));
 it('API key supports headers and encoded query values',async()=>{expect((await send('apikey',{key:'X-Key',value:'key-value'})).response.body).toHaveProperty('headers.x-key','key-value');expect((await send('apikey',{key:'key',value:'a + /',in:'query'})).response.body).toHaveProperty('query.key','a + /');});
 it('Digest completes the challenge and verifies the response hash',async()=>{await send('digest',{parameters:{username:'user',password:'password'}});expect(requests.filter(r=>r.path==='/digest').length).toBeGreaterThan(1);});
 it('OAuth1 verifies HMAC-SHA1 signature',async()=>{await send('oauth1',{parameters:{consumerKey:'consumer',consumerSecret:'consumer-secret',token:'token',tokenSecret:'token-secret',signatureMethod:'HMAC-SHA1',addParamsToHeader:true,nonce:'nonce',timestamp:'1700000000'}});});
 it('OAuth2 Bearer header, custom prefix and query placement resolve variables',async()=>{
  expect((await send('oauth2',{parameters:{accessToken:'{{token}}',addTokenTo:'header'}},'oauth2',{variables:{token:'oauth-token'}})).response.body).toHaveProperty('authorization','Bearer oauth-token');
  expect((await send('oauth2',{parameters:{accessToken:'custom',addTokenTo:'header',headerPrefix:'Token'}})).response.body).toHaveProperty('authorization','Token custom');
  const r=await send('oauth2',{parameters:{accessToken:'a + /',addTokenTo:'queryParams'}});expect(r.response.body).toHaveProperty('query.access_token','a + /');expect(r.response.body).toHaveProperty('authorization','');
 });
 it('JWT verifies HS256 signature',async()=>{await send('jwt',{parameters:{algorithm:'HS256',secret:'jwt-secret',payload:'{"sub":"fixture"}',addTokenTo:'header',headerPrefix:'Bearer'}});});
 it('Hawk verifies the request MAC',async()=>{await send('hawk',{parameters:{authId:'id',authKey:'hawk-secret',algorithm:'sha256',nonce:'nonce',timestamp:'1700000000'}});});
 it('AWS Signature verifies the canonical request',async()=>{await send('aws4',{parameters:{accessKey:'access-key',secretKey:'aws-secret',region:'us-east-1',service:'execute-api'}});});
 it('NTLM completes type 1/2/3 exchange with a valid NTLMv2 proof',async()=>{await send('ntlm',{parameters:{username:'user',password:'password',domain:'LAB',workstation:'WORKSTATION'}});expect(requests.filter(r=>r.path==='/ntlm').length).toBeGreaterThan(1);});
 it('ASAP verifies the RSA signed token',async()=>{await send('asap',{parameters:{alg:'RS256',kid:'fixture-key',iss:'fixture',aud:'test',privateKey}});});
 it('Akamai EdgeGrid verifies the signing key and canonical request',async()=>{await send('edgegrid',{parameters:{clientToken:'client',clientSecret:'edge-secret',accessToken:'access'}});});
 it('OAuth2 uses a token created by the pre-request script and preserves assertions plus scope deletions',async()=>{
  const r=await send('oauth2',{parameters:{accessToken:'{{freshToken}}'}},'oauth2',{
   variables:{removeEnv:'old'},globals:{removeGlobal:'old'},collectionVariables:{removeCollection:'old'},localVariables:{removeLocal:'old'},
   scripts:{preRequest:{exec:'pm.environment.set("freshToken","script-token");pm.environment.unset("removeEnv");pm.globals.set("newGlobal","G");pm.globals.unset("removeGlobal");pm.collectionVariables.set("newCollection","C");pm.collectionVariables.unset("removeCollection");pm.variables.set("newLocal","L");pm.variables.unset("removeLocal");'},test:{exec:'pm.test("authorized",()=>pm.expect(pm.response.json().authorization).to.equal("Bearer script-token"));pm.test("intentional failure",()=>pm.expect(1).to.equal(2));'}}});
  expect(r.response.body).toHaveProperty('authorization','Bearer script-token');expect(r.scripts?.assertions.map(a=>a.passed)).toEqual([true,false]);
  const scopes=r.scripts?.prerequest[0] as any;expect(scopes.environment).toMatchObject({freshToken:'script-token'});expect(scopes.environment).not.toHaveProperty('removeEnv');expect(scopes.globals).toEqual({newGlobal:'G'});expect(scopes.collection).toMatchObject({newCollection:'C'});expect(scopes.collection).not.toHaveProperty('removeCollection');expect(scopes.local).not.toHaveProperty('removeLocal');expect(scopes.local).toHaveProperty('newLocal','L');
 });
});
