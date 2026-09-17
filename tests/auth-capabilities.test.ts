import {describe,it,expect} from 'vitest';
import {buildCollection} from '../src/protocols/http/collection';
import capabilities from '../src/auth-capabilities.json';
const op={responses:{200:{description:'OK'}}};
const spec={openapi:'3.2.0',info:{title:'Auth',version:'1'},servers:[{url:'http://localhost'}],paths:{'/auth':{get:op}}};
const located={path:'/auth',method:'get',operation:op,pathItem:{get:op},parameters:[],servers:spec.servers};
describe('public HTTP authentication capabilities',()=>{
 for(const capability of capabilities.filter(c=>!['none','basic','bearer','apikey'].includes(c.type)))it(`preserves ${capability.type} parameters and variables`,()=>{
  const built=buildCollection(located as any,spec,{spec,target:{path:'/auth',method:'get'},auth:{type:capability.type,parameters:{username:'{{username}}',includeBodyHash:true,accessToken:'{{token}}'}}} as any);
  const serialized=JSON.stringify(built);
  expect(serialized).toContain(`"type":"${capability.type === "aws4" ? "awsv4" : capability.type}"`);
  expect(serialized).toContain('{{username}}');expect(serialized).toContain('includeBodyHash');
  expect(capability.protocols).toEqual(['http','sse']);
 });
 it('rejects unknown auth instead of silently sending anonymously',()=>{
 expect(()=>buildCollection(located as any,spec,{spec,target:{path:'/auth',method:'get'},auth:{type:'unknown'}} as any)).toThrow(/Unsupported HTTP authentication/);
 });
});

it.each([{},{accessToken:"token",addTokenTo:"query"},{accessToken:"token",tokenType:"MAC"}])("rejects incomplete or unsupported OAuth2 instead of anonymous requests", (parameters)=>{
 expect(()=>buildCollection(located as any,spec,{spec,target:{path:"/auth",method:"get"},auth:{type:"oauth2",parameters}} as any)).toThrow(/OAuth 2.0/);
});
