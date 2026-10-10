import {it,expect} from 'vitest';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '../src/index';

it('uploads file bytes and repeated fields and rejects missing files before dispatch',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'multipart-'));
 const file=join(directory,'upload.txt');await writeFile(file,'uploaded-file-content');
 let requests=0;
 const server=http.createServer(async(req,res)=>{requests++;const parts=[];for await(const chunk of req)parts.push(chunk);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({body:Buffer.concat(parts).toString(),contentType:req.headers['content-type']}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const address=server.address() as any;
  const spec={openapi:'3.2.0',info:{title:'upload',version:'1'},servers:[{url:`http://127.0.0.1:${address.port}`}],paths:{'/upload':{post:{requestBody:{content:{'multipart/form-data':{schema:{type:'object'}}}},responses:{200:{description:'OK'}}}}}};
  const base={spec,target:{path:'/upload',method:'post'}};
  const result=await createClient().send({...base,values:{body:[['tag','one'],['tag','two'],['logo',{__file:file}]]}});
  expect(result.response?.status).toBe(200);
  const body=result.response?.body as any;
  expect(body.contentType).toMatch(/multipart\/form-data; boundary=/);
  expect(body.body).toContain('uploaded-file-content');
  expect(body.body.match(/name="tag"/g)).toHaveLength(2);
  expect(body.body).toContain('filename="upload.txt"');
  await expect(createClient().send({...base,values:{body:{logo:{__file:join(directory,'missing')}}}})).rejects.toMatchObject({code:'FILE_READ_ERROR'});
  expect(requests).toBe(1);
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
it('does not bypass restricted resolvers and allows cancellation during a stalled file check',async()=>{
 const spec={openapi:'3.2.0',info:{title:'upload',version:'1'},servers:[{url:'http://127.0.0.1:1'}],paths:{'/':{post:{requestBody:{content:{'multipart/form-data':{schema:{type:'object'}}}},responses:{200:{description:'OK'}}}}}};
 const base={spec,target:{path:'/',method:'post'},values:{body:{file:{__file:'/private/file'}}}};
 await expect(createClient().send({...base,runner:{fileResolver:{readFile(){}}} as any})).rejects.toMatchObject({code:'FILE_READ_ERROR'});
 const controller=new AbortController();
 const result=createClient().send({...base,signal:controller.signal,runner:{fileResolver:{stat(){},createReadStream(){throw new Error('must not dispatch');}}} as any});
 setTimeout(()=>controller.abort(),10);
 expect((await result).response.stopReason).toBe('aborted');
 await expect(createClient().send({...base,timeout:20,runner:{fileResolver:{stat(){},createReadStream(){}}} as any})).rejects.toThrow('Timed out reading upload files');
});

it.each(['application/json','application/x-www-form-urlencoded','multipart/form-data'])('preserves GET request bodies and receives response bodies for %s',async contentType=>{
 const directory=await mkdtemp(join(tmpdir(),'get-body-'));
 const file=join(directory,'file.txt');await writeFile(file,'get-upload-bytes');
 const server=http.createServer(async(req,res)=>{const parts=[];for await(const chunk of req)parts.push(chunk);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({method:req.method,body:Buffer.concat(parts).toString()}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const spec={openapi:'3.2.0',info:{title:'GET body',version:'1'},servers:[{url:`http://127.0.0.1:${(server.address() as any).port}`}],paths:{'/':{get:{requestBody:{content:{[contentType]:{schema:{type:'object'}}}},responses:{200:{description:'OK'}}}}}};
  const payload=contentType==='multipart/form-data'?[['files',{__file:file}],['files',{__file:file}]]:{q:'hello'};
  const result=await createClient().send({spec,target:{path:'/',method:'get'},values:{body:payload}});
  expect(result.response.status).toBe(200);
  const echo=result.response.body as any;
  expect(echo.method).toBe('GET');
  if(contentType==='multipart/form-data') {expect(echo.body.match(/get-upload-bytes/g)).toHaveLength(2);}
  else if(contentType==='application/json') expect(JSON.parse(echo.body)).toEqual({q:'hello'});
  else expect(echo.body).toBe('q=hello');
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
});
