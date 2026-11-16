import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {
  ConsentError,
  StalePlanError,
  SubsetError,
  readDescriptor,
  planSubset,
  claimSubset,
  collect,
  collectSubset
} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';

async function customSource(fixture) {
  const directory = await mkdtemp(join(tmpdir(),'fixture-'));
  const path = join(directory,'source.json');
  await writeFile(path,JSON.stringify(fixture));
  const source = await createSource({fixture:path});
  return {source,directory};
}

function fixtureFor({revision = 'r1', variables, allowedNames = variables.map(variable => variable.name), subset}) {
  return {
    exchanges: [
      {path:'/descriptor',method:'GET',body:{revision,variables,allowedNames},requires:{},sets:{},status:200,query:{}},
      {path:'/subset',method:'POST',body:subset,requires:{},sets:{},status:200,query:{}}
    ],
    cases: {}
  };
}

function grid(name, dimensions, type = 'Grid') {
  return {name,type,dimensions:dimensions.map(([dimensionName,size]) => ({name:dimensionName,size})),attributes:{}};
}

const closeAll = async (source,directory) => {
  await source.close();
  await rm(directory,{recursive:true,force:true});
};

test('按授权变量和区间领取，并收存维度、坐标与序列结束信息', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,{variables:[{name:'temperature',start:1,stop:2}]});
    assert.deepEqual(plan.variables[0].expectedShape,[2]);
    assert.equal(Object.isFrozen(plan),true);

    const claim = await claimSubset(client,plan);
    assert.equal(claim.complete,true);
    assert.deepEqual(claim.completed,['temperature']);
    assert.deepEqual(claim.pending,[]);

    const [row] = claim.rows;
    assert.equal(row.kind,'subset');
    assert.equal(row.name,'temperature');
    assert.deepEqual(row.descriptor,{name:'temperature',shape:[2]});
    assert.deepEqual(row.receivedShape,[2]);
    assert.deepEqual(row.maps,{time:[1,2]});
    assert.deepEqual(row.data,[20,21]);
    assert.equal(row.sequenceEnd,true);
    assert.equal(row.truncated,false);
    assert.equal(row.complete,true);
    assert.deepEqual(row.pendingRanges,[]);

    const audit = await client('/__audit');
    const subsets = audit.requests.filter(entry => entry.path === '/subset');
    assert.equal(subsets.length,1);
    assert.deepEqual(subsets[0].body.projection,[{name:'temperature',start:1,stride:1,stop:2}]);
    assert.deepEqual(subsets[0].body.selection,[]);
    assert.equal(subsets[0].body.descriptorRevision,'d1');
    assert.deepEqual(subsets[0].query,{});
  } finally {await source.close();}
});

test('未授权变量在执行领取前被拒绝，也不产生来源请求', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    assert.throws(() => planSubset(descriptor,{variables:[{name:'private',start:0,stop:0}]}),error =>
      error instanceof ConsentError && error.code === 'not-authorized' && error.status === 403);
    assert.throws(() => planSubset(descriptor,{
      variables:[{name:'temperature',start:0,stop:0}],
      selection:[{dimension:'private',operator:'=',value:1}]
    }),error => error instanceof SubsetError && error.code === 'invalid-selection');
    const audit = await client('/__audit');
    assert.equal(audit.requests.filter(entry => entry.path === '/subset').length,0);
  } finally {await source.close();}
});

test('来源变量名按原值结构化传递，不拼接到路径或查询串', async () => {
  const variableName = 'ice/cover "north" %3B';
  const dimensionName = 'time "UTC"+';
  const {source,directory} = await customSource(fixtureFor({
    variables:[grid(variableName,[[dimensionName,4]])],
    allowedNames:[variableName],
    subset:{
      revision:'r1',
      descriptor:{name:variableName,shape:[2]},
      data:{array:[1.5,1.6],maps:{[dimensionName]:[10,11],unrelated:[99]}},
      sequenceEnd:true,
      truncated:false
    }
  }));
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    assert.equal(descriptor.variables[0].name,variableName);

    const plan = planSubset(descriptor,{
      variables:[{name:variableName,start:0,stop:1}],
      selection:[{dimension:dimensionName,operator:'>=',value:10}]
    });
    assert.equal(plan.variables[0].name,variableName);

    const claim = await claimSubset(client,plan);
    assert.equal(claim.complete,true);
    assert.deepEqual(claim.rows[0].maps,{[dimensionName]:[10,11]});

    const audit = await client('/__audit');
    const subsets = audit.requests.filter(entry => entry.path === '/subset');
    assert.equal(subsets.length,1);
    assert.equal(subsets[0].path,'/subset');
    assert.deepEqual(subsets[0].query,{});
    assert.equal(subsets[0].body.projection[0].name,variableName);
    assert.equal(subsets[0].body.selection[0].name,dimensionName);
    assert.equal(subsets[0].body.selection[0].value,10);

    // Arbitrary caller text that merely resembles a query is not a descriptor
    // name, so it never reaches the source.
    assert.throws(() => planSubset(descriptor,{
      variables:[{name:`${variableName}&start=0&stop=99`,start:0,stop:0}]
    }),error => error instanceof ConsentError);
    assert.equal((await client('/__audit')).requests.filter(entry => entry.path === '/subset').length,1);
  } finally {await closeAll(source,directory);}
});

test('描述更新后旧计划被拒绝，不沿用同一切片表达式', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,{variables:[{name:'temperature',start:0,stop:1}]});

    await client('/__scenario',{method:'POST',body:{name:'changed-shape'}});
    await assert.rejects(claimSubset(client,plan),error => {
      assert.equal(error instanceof StalePlanError,true);
      assert.equal(error.code,'stale-plan');
      assert.equal(error.pending[0].reason,'stale-plan');
      assert.deepEqual(error.pending[0].ranges,[{dimension:'time',start:0,stride:1,stop:1}]);
      return true;
    });

    // The same textual slice against the new descriptor means a different
    // dimension set. It is a new plan, and it is rejected when the source
    // switches back to the old shape.
    const newDescriptor = await readDescriptor(client);
    const newPlan = planSubset(newDescriptor,{
      variables:[{name:'temperature',start:[0,0],stop:[1,2]}]
    });
    assert.deepEqual(newPlan.variables[0].expectedShape,[2,3]);
    await client('/__scenario',{method:'POST',body:{name:'normal'}});
    await assert.rejects(claimSubset(client,newPlan),error => error instanceof StalePlanError && error.code === 'stale-plan');

    const audit = await client('/__audit');
    assert.equal(audit.requests.filter(entry => entry.path === '/subset').length,0);
  } finally {await source.close();}
});

test('来源报告截断时保留已收数值并留下未完成的范围', async () => {
  const source = await createSource({scenario:'changed-shape'});
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,{
      variables:[{name:'temperature',start:[0,0],stop:[1,2]}]
    });
    const claim = await claimSubset(client,plan);

    assert.equal(claim.complete,false);
    assert.deepEqual(claim.completed,[]);
    assert.equal(claim.rows[0].complete,false);
    assert.equal(claim.rows[0].truncated,true);
    assert.equal(claim.rows[0].sequenceEnd,false);
    assert.deepEqual(claim.rows[0].data,[20,21]);
    assert.deepEqual(claim.rows[0].maps,{time:[1,2]});
    assert.deepEqual(claim.rows[0].descriptor,{name:'temperature',shape:[2,3]});
    assert.deepEqual(claim.rows[0].receivedShape,null);

    assert.equal(claim.pending.length,1);
    assert.equal(claim.pending[0].name,'temperature');
    assert.equal(claim.pending[0].reason,'truncated');
    assert.deepEqual(claim.pending[0].expected,[2,3]);
    assert.deepEqual(claim.pending[0].ranges,[
      {dimension:'time',start:0,stride:1,stop:1},
      {dimension:'depth',start:0,stride:1,stop:2}
    ]);
  } finally {await source.close();}
});

test('返回结构与描述不符时不算成功，且不导入未领取的字段', async () => {
  const variable = grid('temperature',[['time',3]]);
  const {source,directory} = await customSource(fixtureFor({
    variables:[variable],
    subset:{
      revision:'r1',
      descriptor:{name:'temperature',shape:[3]},
      data:{array:[20],maps:{time:[7],private:[42]}},
      sequenceEnd:true,
      truncated:false
    }
  }));
  try {
    const client = createClient(source.origin);
    const claim = await collectSubset(client,{
      variables:[{name:'temperature',start:0,stop:2}]
    });

    assert.equal(claim.complete,false);
    assert.equal(claim.rows[0].problem,'short-array');
    assert.equal(claim.rows[0].complete,false);
    assert.deepEqual(claim.rows[0].data,[20]);
    assert.deepEqual(claim.rows[0].maps,{time:[7]});
    assert.deepEqual(claim.pending[0].ranges,[{dimension:'time',start:0,stride:1,stop:2}]);
  } finally {await closeAll(source,directory);}
});

test('缺少结束标记或描述形状变化时保留完整未完成范围', async () => {
  const variable = grid('temperature',[['time',2]]);
  for (const [subset,problem] of [
    [{revision:'r1',descriptor:{name:'temperature',shape:[2]},data:{array:[1,2],maps:{time:[0,1]}},sequenceEnd:false,truncated:false},'sequence-not-ended'],
    [{revision:'r1',descriptor:{name:'temperature',shape:[4]},data:{array:[1,2,3,4],maps:{time:[0,1,2,3]}},sequenceEnd:true,truncated:false},'response-shape'],
    [{revision:'r1',descriptor:{name:'temperature',shape:[2]},data:{array:[1,2],maps:{time:[0,1]}},truncated:false},'missing-completion-flags']
  ]) {
    const {source,directory} = await customSource(fixtureFor({variables:[variable],subset}));
    try {
      const claim = await collectSubset(createClient(source.origin),{
        variables:[{name:'temperature',start:0,stop:1}]
      });
      assert.equal(claim.complete,false);
      assert.equal(claim.rows[0].problem,problem);
      assert.deepEqual(claim.pending[0].ranges,[{dimension:'time',start:0,stride:1,stop:1}]);
    } finally {await closeAll(source,directory);}
  }
});

test('计划内容被改写时拒绝执行', async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,{variables:[{name:'temperature',start:0,stop:1}]});
    const tampered = {...plan,variables:[{...plan.variables[0],ranges:[{start:0,stride:1,stop:3}],expectedShape:[4]}]};
    await assert.rejects(claimSubset(client,tampered),error => error instanceof SubsetError && error.code === 'invalid-plan');
  } finally {await source.close();}
});

test('来源响应 revision 与计划不符时按过期处理并留下全部未完成范围', async () => {
  const {source,directory} = await customSource(fixtureFor({
    variables:[grid('temperature',[['time',2]])],
    subset:{
      revision:'r2',
      descriptor:{name:'temperature',shape:[2]},
      data:{array:[1,2],maps:{time:[0,1]}},
      sequenceEnd:true,
      truncated:false
    }
  }));
  try {
    const client = createClient(source.origin);
    const descriptor = await readDescriptor(client);
    const plan = planSubset(descriptor,{variables:[{name:'temperature',start:0,stop:1}]});
    await assert.rejects(claimSubset(client,plan),error => {
      assert.equal(error instanceof StalePlanError,true);
      assert.equal(error.code,'stale-plan');
      assert.deepEqual(error.completed,[]);
      assert.deepEqual(error.rows,[]);
      assert.equal(error.pending.length,1);
      assert.equal(error.pending[0].reason,'stale-plan');
      assert.deepEqual(error.pending[0].ranges,[{dimension:'time',start:0,stride:1,stop:1}]);
      return true;
    });
  } finally {await closeAll(source,directory);}
});

test('嵌套序列按收到结构收存，并保留序列结束信息', async () => {
  const {source,directory} = await customSource(fixtureFor({
    variables:[{name:'profile',type:'Sequence',dimensions:[],attributes:{}}],
    subset:{
      revision:'r1',
      descriptor:{name:'profile',shape:[]},
      data:{sequence:[[1,2],[3,4],[5,6]]},
      sequenceEnd:true,
      truncated:false
    }
  }));
  try {
    const client = createClient(source.origin);
    const claim = await collectSubset(client,{variables:[{name:'profile'}]});
    assert.equal(claim.complete,true);
    const [row] = claim.rows;
    assert.equal(row.type,'Sequence');
    assert.deepEqual(row.receivedShape,[3,2]);
    assert.deepEqual(row.data,[[1,2],[3,4],[5,6]]);
    assert.equal(row.sequenceEnd,true);
    assert.equal(row.truncated,false);
    assert.deepEqual(row.pendingRanges,[]);
  } finally {await closeAll(source,directory);}
});

test('collect(client, request) 返回可归档原件并附带领取状态', async () => {
  const directory = await mkdtemp(join(tmpdir(),'claim-archive-'));
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const rows = await collect(client,{variables:[{name:'temperature',start:0,stop:1}]});
    assert.equal(Array.isArray(rows),true);
    assert.equal(rows.length,1);
    assert.equal(rows.complete,true);
    assert.deepEqual(rows.pending,[]);
    assert.equal(Object.keys(rows).length,1);
    const serialized = JSON.parse(JSON.stringify(rows));
    assert.equal(serialized.length,1);
    assert.equal(Object.hasOwn(serialized,'complete'),false);
    assert.equal(serialized[0].complete,true);

    const archive = new Archive(directory);
    const result = await archive.put(rows,{source:source.origin,adapter:'subset'});
    assert.equal(result.added,1);
    const [stored] = await archive.list();
    assert.deepEqual(stored.row.maps,{time:[1,2]});
    assert.equal(stored.row.sequenceEnd,true);
    assert.equal(stored.row.descriptor.shape.length,1);
  } finally {
    await source.close();
    await rm(directory,{recursive:true,force:true});
  }
});
