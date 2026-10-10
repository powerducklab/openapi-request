import {it,expect} from 'vitest';
import {sampleFromSchema} from '../src/openapi/sample.js';
it('bounds multiplicative nested array expansion with a shared budget',()=>{
 let schema:any={type:'string'};
 for(let i=0;i<12;i++)schema={type:'array',minItems:5,items:schema};
 const value=sampleFromSchema(schema);
 const stack=[value];let nodes=0;
 while(stack.length){const item=stack.pop();nodes++;if(Array.isArray(item))stack.push(...item);}
 expect(nodes).toBeLessThan(51000);
 expect(JSON.stringify(value).length).toBeLessThan(500000);
});
it('each independent sample gets a fresh budget and ordinary samples retain their shape',()=>{
 const schema={type:'array',minItems:2,items:{type:'object',properties:{id:{type:'integer',minimum:3}}}};
 expect(sampleFromSchema(schema)).toEqual([{id:3},{id:3}]);
 expect(sampleFromSchema(schema)).toEqual([{id:3},{id:3}]);
});
it('caps caller-supplied recursion depths for cyclic schemas',()=>{
 const schema:any={type:'array',minItems:1};schema.items=schema;
 expect(()=>sampleFromSchema(schema,0,{maxDepth:Infinity})).not.toThrow();
});
