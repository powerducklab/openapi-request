import {afterEach,expect,it,vi} from 'vitest';
import {runGraphQL} from '../src/protocols/graphql/client';
const config={endpoint:'https://example.test/graphql',query:'{hello}',variables:{},headers:{},useGet:false} as any;
afterEach(()=>vi.unstubAllGlobals());
it('passes an already cancelled signal to fetch',async()=>{
 const controller=new AbortController();controller.abort();
 let aborted=false;
 vi.stubGlobal('fetch',vi.fn(async(_url,options)=>{aborted=options.signal.aborted;throw new DOMException('aborted','AbortError');}));
 const result=await runGraphQL(config,{signal:controller.signal} as any);
 expect(aborted).toBe(true);expect(result.error?.code).toBe('ABORTED');
});
it('caps JSON and SSE response bytes and cancels the body reader',async()=>{
 for(const contentType of ['application/json','text/event-stream']) {
  const cancel=vi.fn();
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(100)));},cancel});
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(stream,{headers:{'content-type':contentType}})));
  const result=await runGraphQL(config,{maxResponseSize:16} as any);
  expect(result.error?.code).toBe('maxResponseSize');expect(cancel).toHaveBeenCalledTimes(1);
 }
});
it('reports UTF-8 byte sizes and rejects malformed successful responses',async()=>{
 const raw=JSON.stringify({data:{hello:'你好'}});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(raw,{headers:{'content-type':'application/json'}})));
 const result=await runGraphQL(config,{} as any);
 expect(result.response.sizeBytes).toBe(new TextEncoder().encode(raw).byteLength);
 expect(result.error).toBeUndefined();
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>not graphql</html>',{status:200})));
 expect((await runGraphQL(config,{} as any)).error?.code).toBe('GRAPHQL_INVALID_RESPONSE');
});
it('honors stream deadlines and caller cancellation after response headers',async()=>{
 for(const callerCancels of [false,true]) {
  const abort=new AbortController();
  vi.stubGlobal('fetch',vi.fn(async(_url,options)=>new Response(new ReadableStream({start(controller){
   options.signal.addEventListener('abort',()=>controller.error(new DOMException('aborted','AbortError')),{once:true});
  }}),{headers:{'content-type':'text/event-stream'}})));
  const pending=runGraphQL(config,{signal:abort.signal,timeout:1000,maxStreamMs:20} as any);
  if(callerCancels) {await Promise.resolve();abort.abort();}
  const result=await pending;
  expect(result.error).toBeDefined();
  if(callerCancels)expect(result.error?.code).toBe('ABORTED');
 }
});

 it('rejects scripts before sending and honors disabled redirects',async()=>{
  const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{status:200,headers:{'Content-Type':'application/json'}}));
  try {
    await expect(runGraphQL(config,{scripts:{preRequest:{exec:'throw new Error("stop")'}}} as any)).rejects.toThrow(/scripts/);
    expect(fetchMock).not.toHaveBeenCalled();
    await runGraphQL(config,{runner:{requester:{followRedirects:false}}} as any);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({redirect:'manual',credentials:'omit'}));
  } finally { fetchMock.mockRestore(); }
 });
