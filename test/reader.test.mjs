import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('变量目录保留维度而不提前领取数据', async () => {
  const rows = await collect(client);
  assert.equal(rows[0].type, 'Grid');
  assert.equal(rows[0].dimensions[0].size, 4);
  assert.equal(rows[0].attributes.units, 'degree_C');
});
