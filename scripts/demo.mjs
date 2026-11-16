import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {claimSubset, planSubset, readDescriptor} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const client = createClient(source.origin);
  const descriptor = await readDescriptor(client);
  console.log('变量目录',JSON.stringify(descriptor.variables.map(variable => ({
    name:variable.name,type:variable.type,dimensions:variable.dimensions
  }))));

  // Only the exhibition interval is requested; the rest of the cruise remains
  // undownloaded at the gateway.
  const request = process.env.CLAIM
    ? JSON.parse(process.env.CLAIM)
    : {variables:[{name:'temperature',start:0,stop:1}]};
  const plan = planSubset(descriptor,request);
  const claim = await claimSubset(client,plan);
  console.log('领取状态',JSON.stringify({revision:claim.revision,complete:claim.complete,
    completed:claim.completed,pending:claim.pending}));
  console.log('实际收件',JSON.stringify(await archive.put(claim.rows,{source:source.origin,
    adapter:'subset',revision:claim.revision,planFingerprint:claim.planFingerprint})));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('来源交互',JSON.stringify(await client('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
