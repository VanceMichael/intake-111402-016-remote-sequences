# 来源网关契约

GET /descriptor 返回 revision、variables{name,type,dimensions,attributes}、allowedNames；POST /subset 接受 descriptorRevision、projection、selection，返回 revision、descriptor、data、sequenceEnd、truncated。projection 为结构化变量和 start/stride/stop，不是原样 DAP 表达式；网关负责线路编码。revision 不符返回 412。Grid 包含 array 与 maps，Sequence 可嵌套。

## 本地来源操作

默认场景 normal，其他场景为 changed-shape。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

## 约束式领取通道

src/reader.mjs 提供 planSubset/claimSubset（别名 collectSubset），collect(client, request) 为便捷入口。

领取请求为 {variables:[{name, ranges|start/stride/stop|按维数组}], selection?}。一维变量可用标量 start/stride/stop；多维须按维给出 ranges 对象、数组或 start/stop/stride 数组。区间按 stop 含端点计，且必须落在当前描述维度内；只为所需变量与区间领取，不额外投影其他字段。调用方只给出结构化值，适配器不拼接 DAP 表达式、URL 或查询串；来源变量名与维度名按原值放入 JSON，反引号不会进入路径。

planSubset 把描述 revision、变量形状、区间、期望形状和选择条件封成带 sha256 指纹的冻结计划。claimSubset 先重新读取描述：revision、变量、类型、维度名与大小任一不符，或计划内容被改写，均以 stale-plan/invalid-plan 拒绝，不把旧切片套到新描述上；未授权变量在 planSubset 即被拒绝（not-authorized），不发出 /subset。

每条结果行包含 kind=subset、revision、planFingerprint、requested（区间与期望形状）、descriptor（来源回报的 name/shape）、declaredShape、receivedShape、maps（仅请求维度的网格坐标）、data、receivedCount、expectedCount、sequenceEnd、truncated、complete、pendingRanges、problem。返回数组的嵌套维度由数据实际形状验证；网格必须有与数据范围一致的坐标。truncated=true、sequenceEnd=false、缺少这两个标记、声明/实际形状不符或到达数量不足时，complete=false，按已收前缀给出待续区间：一维为剩余 start/stop，多维无法可靠定位前缀时保留整段。已收到的数值照常保留，不用作整段成功的证明。

claimSubset 返回 {revision, planFingerprint, complete, completed, rows, pending}。描述在领取中途变化（来源 412 或响应 revision 不符）抛 StalePlanError，带已完成变量、已收行与全部未完成范围。可归档的 rows 满足 Archive.put 的 id 约定，provenance 建议至少带 source、adapter、revision、planFingerprint；归档本身仍不表示区间完整。
