import {expect,it,vi} from 'vitest';
import {createClient,createManualSession,discoverMcpCapabilities} from '../src/index';
import {sendJsonRpc} from '../src/protocols/mcp/jsonrpc';
it('GraphQL uses the injected transport instead of global fetch',async()=>{
 const injected=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{ok:true}}),{headers:{'Content-Type':'application/json'}}));
 const spec={openapi:'3.2.0',info:{title:'test',version:'1'},paths:{'/g':{post:{'x-protocol':'graphql','x-graphql':{endpoint:'https://not-a-real-host.invalid/g',query:'{ok}'},responses:{200:{description:'OK'}}}}}};
 const result=await createClient().send({spec,target:{path:'/g',method:'post'},fetch:injected});
 expect(injected).toHaveBeenCalled();expect(result.response.status).toBe(200);
});
it('MCP discovery and manual sessions inject fetch into initialization, notifications, listing and DELETE',async()=>{
 const injected=vi.fn(async (_url:any,init:any)=>{
  if(init.method==='DELETE') return new Response(null,{status:204});
  const body=JSON.parse(init.body);
  if(body.id===undefined) return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'test',version:'1'}}:{tools:[],resources:[],resourceTemplates:[],prompts:[]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'session'}});
 });
 await discoverMcpCapabilities('https://not-a-real-host.invalid/mcp',{fetch:injected as typeof fetch});
 const session=createManualSession({kind:'mcp',endpoint:'https://not-a-real-host.invalid/mcp',fetch:injected as typeof fetch});
 await session.open();await session.close();
 expect(injected.mock.calls.some(([,init])=>init.method==='DELETE')).toBe(true);
});
it('MCP timeout remains attached while receiving response body',async()=>{
 const injected=vi.fn(async (_url:any,init:any)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(new Error('aborted')),{once:true});}}),{headers:{'Content-Type':'text/event-stream'}}));
 await expect(sendJsonRpc('https://unused.invalid',{jsonrpc:'2.0',id:1,method:'test'},{fetch:injected as typeof fetch,startedAt:Date.now(),timeoutMs:10})).rejects.toThrow('aborted');
});
