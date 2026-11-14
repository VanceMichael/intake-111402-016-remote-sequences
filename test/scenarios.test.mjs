import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('changed-shape');
await assert.rejects(client('/subset',{method:'POST',body:{descriptorRevision:'d1',projection:[{name:'temperature'}]}}),error => error.status === 412);
await assert.rejects(client('/subset',{method:'POST',body:{descriptorRevision:'d2',projection:[{name:'private'}]}}),error => error.status === 403);
const subset = await client('/subset',{method:'POST',body:{descriptorRevision:'d2',projection:[{name:'temperature'}]}});
assert.equal(subset.truncated,true);
assert.equal(subset.sequenceEnd,false);
} finally {await source.close();}
});
