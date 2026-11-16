# 远程数组服务的约束式资料领取

远程观测子集入口。授权网关将 DAP2 DDS/DAS 与 DataDDS 投影为本地 JSON；适配器可按授权变量与区间领取一小段观测，并连同数组维度、网格坐标和序列结束信息一起收存，不需要先下载整个数据集。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取坐标与数值并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

按区间领取需要给出结构化请求，适配器不会把变量名拼成路径或 DAP 表达式：

```sh
CLAIM='{"variables":[{"name":"temperature","start":0,"stop":1}]}' npm run demo
CLAIM='{"variables":[{"name":"temperature","ranges":[{"start":0,"stop":1},{"start":0,"stop":2}]}]}' \
  SCENARIO=changed-shape npm run demo
```

第一条完整领取一维切片；第二条对应来源改形后的二维描述，来源报告截断时 complete=false，pending 列出未完成范围，已收的数值仍照常归档。不设置 CLAIM 时仅读取并归档变量目录。

```sh
docker build --network=none -t remote-sequences .
docker run --rm --network=none remote-sequences npm test
docker run --rm --network=none remote-sequences npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。planSubset/claimSubset 实现约束式领取，契约见 contracts.md。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本，CLAIM 给出领取请求。测试和演示自己创建空目录，不依赖上次执行遗留状态。
