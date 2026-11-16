import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect, claimSubset, planSubset, readDescriptor} from './reader.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(resolve(process.env.DATA_DIR ?? '.state'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const client = createClient(source.origin);
  // CLAIM selects the constrained channel, e.g.
  // CLAIM='{"variables":[{"name":"temperature","start":0,"stop":1}]}'
  // Without it only the variable catalogue is read.
  const request = process.env.CLAIM ? JSON.parse(process.env.CLAIM) : null;
  if (request === null) {
    const rows = await collect(client);
    console.log(JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
  } else {
    // One descriptor read builds the plan; claimSubset re-reads and refuses the
    // plan if the revision or shape changed in between.
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,request);
    const claim = await claimSubset(client,plan);
    console.log(JSON.stringify({revision:claim.revision,complete:claim.complete,
      completed:claim.completed,pending:claim.pending}));
    const stored = await archive.put(claim.rows,{source:source.origin,adapter:'subset',
      revision:claim.revision,planFingerprint:claim.planFingerprint});
    console.log(JSON.stringify({archived:stored,complete:claim.complete}));
  }
} catch(error) {
  console.error(JSON.stringify({error:error.message,code:error.code ?? null,
    completed:error.completed ?? [],pending:error.pending ?? []}));
}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
