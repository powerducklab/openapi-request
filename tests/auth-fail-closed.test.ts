import { expect, it } from 'vitest';
import http from 'node:http';
import { createClient } from '../src/index.js';
it('never sends unsigned requests after JWT preparation fails, and recovers with valid credentials', async () => {
 let requests = 0;
 const server = http.createServer((req,res) => { requests++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({authorization:req.headers.authorization})); });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as any).port;
 const client=createClient();
 const base:any={spec:{openapi:'3.2.0',info:{title:'auth',version:'1'},paths:{'/echo':{post:{responses:{200:{description:'ok'}}}}}}, target:{path:'/echo',method:'post'},serverUrl:`http://127.0.0.1:${port}`};
 try {
  for (const parameters of [{algorithm:'HS256',secret:'test-secret',payload:'{invalid'}, {algorithm:'HS256',secret:'',payload:'{}'}, {algorithm:'RS256',privateKey:'not-a-key',payload:'{}'}]) {
   await expect(client.send({...base,auth:{type:'jwt',parameters}})).rejects.toMatchObject({code:'AUTH_CONFIGURATION'});
   expect(requests).toBe(0);
  }
  const result=await client.send({...base,auth:{type:'jwt',parameters:{algorithm:'HS256',secret:'test-secret',payload:'{"sub":"test"}'}}});
  expect(result.response.status).toBe(200); expect(requests).toBe(1);
 } finally { await client.dispose(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
},20000);
