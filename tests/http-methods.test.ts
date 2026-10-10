import {it,expect} from 'vitest';
import net from 'node:net';
import {createClient} from '../src/index';
it('sends TRACE, QUERY, WebDAV and custom methods unchanged on the wire',async()=>{
 const received:string[]=[];
 const sockets=new Set<net.Socket>();
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let text='';socket.on('data',chunk=>{text+=chunk.toString();if(!text.includes('\r\n\r\n'))return;received.push(text.split(' ')[0]);socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  const url=`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  for(const method of ['TRACE','QUERY','PROPFIND','CUSTOM-VERB']) {
   const op={responses:{200:{description:'OK'}}};
   const item=['TRACE','QUERY'].includes(method)?{[method.toLowerCase()]:op}:{additionalOperations:{[method]:op}};
   const spec={openapi:'3.2.0',info:{title:'Methods',version:'1'},servers:[{url}],paths:{'/':item}};
   const result=await createClient().send({spec,target:{path:'/',method}});
   expect(result.response?.status).toBe(200);
  }
  expect(received).toEqual(['TRACE','QUERY','PROPFIND','CUSTOM-VERB']);
 }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});
