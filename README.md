# Flightlog · 用量观察

Magpie 侧栏里的历史负载仪表盘。可以按模型家族、具体模型、Client 交叉筛选最近 1、7、14、30 天或全部记录。四项指标一起随筛选更新。趋势图支持 TPM、RPM 和并发三个视角，每段可在下方明细表核对。分组表中的名称可以点击下钻。

## 使用

本机验证版本为 Magpie 0.1.4402、Bun 1.4.0。宿主需要支持页面服务和带游标的请求 feed。安装目录可以放在 Magpie 仓库以外。

```sh
magpie plugin add github:DylanLIiii/magpie-flightlog
```

打开 Magpie 的「插件 → 用量观察」侧栏页。首次打开会建立索引，完整回溯成功后页面自动更新。后端运行期间每 60 秒检查增量，页面右上方的「刷新数据」读取最新已提交索引。插件停用期间 Magpie 自己仍然记账，下次启动时继续追赶游标。端口冲突可在插件选项中设置 `port`，默认 3467。

独立查看时，可在同一台机器启动相同服务。运行时只需 Bun，自带 SQLite，无须安装 npm 依赖。

```sh
git clone https://github.com/DylanLIiii/magpie-flightlog.git
cd magpie-flightlog
bun run start
# 浏览器打开 http://127.0.0.1:3467/
```

独立启动可用 `MAGPIE_ADDR=127.0.0.1:3425` 指向本机网关，用 `FLIGHTLOG_PORT` 改页面端口。`FLIGHTLOG_STATE` 可指定索引目录，默认 `$XDG_STATE_HOME/magpie-flightlog` 或 `~/.local/state/magpie-flightlog`。索引按宿主目录和网关地址分开，DB 文件权限为 0600。插件页面服务与独立模式都只监听回环，本机其他具有回环网络访问权的进程也可以读取聚合数据。Web 模式由 Magpie 将该服务代理给能打开插件页的浏览器。

## 来源与保留

- **网关账本**位于 `magpie data` 给出的 files 目录下的 `usage.jsonl`。网关追加写入，源码中未见按天自动淘汰的承诺或固定历史天数。Usage 页的「清空」通过设置中的标记隐藏记录，原始文件可能仍然保留。其他机器、会话导入、恢复备份或手工移走日志都会改变实际覆盖。
- **诊断日志**可通过 `magpie log --path` 定位。上游 `internal/applog` 在 5 MiB 时将 `app.log` 轮换为 `app.old.log`，不能按固定天数回溯。`quota history` 的 45 天是额度读数的保留期。两者均未用于推算历史请求量。
- **插件消费的来源**是 `GET /v1/magpie/usage/requests?cursor=start&limit=500`。它合并网关账本、Magpie 本身获准读取的会话、客户端上报及同步记录，并应用宿主的清空和去重逻辑。因此 feed 可能覆盖早于本机网关日志的记录。插件本身只请求元数据接口。Magpie 读取 feed 时会自行维护 `usage-feed.jsonl`。
- **持续采集**使用 feed 的稳定 ID 做 upsert，处理 `deleted`，将本页更新和下一游标在同一 SQLite 事务提交。初次回溯和游标失效后的重建使用独立一代数据，最后一页提交后才切换显示。网关的删除标记保留 30 天，遇到失效、重置或筛选指纹变化会重新回溯。私有索引随 feed 删除同步，当前有效记录不设固定 TTL。可停用后删除插件索引，再次打开会重建。
- **实时快照**每轮读取 `GET /v1/magpie/concurrency` 的全局 `requests`，仅保留数值和采样时间。超过两分钟或读取失败显示缺失。历史趋势来自区间重建。原始应用日志、带正文的会话或请求归档、供应商配置和登录库都不属于插件输入。
- **页面限制**是 `connect-src 'none'`，页面桥接的 `usage:summary`、`usage:day` 提供聚合摘要。`package.json` 声明 `magpie.page.service`，Bun 宿主调用 `server(input, options)`；入口等待 `_magpie/bridge.js` 的握手，然后在当前 frame 导航到 `magpie.service`，桌面模式使用约定的回环端口。聚合由宿主服务在本机完成，页面以服务端 HTML 返回，无页面 fetch、第三方 CDN 或模型请求钩子。`onUsage` 仅覆盖新写入，其有界队列允许丢行，且无法回放历史或删除，故此实现选用 feed。

[中文 README](https://github.com/yetone/magpie/blob/main/README.zh-CN.md) · [插件契约与页面隔离](https://github.com/yetone/magpie/blob/dc507ae/docs/subsystems/plugin-runtime.md) · [请求 feed 与并发 API](https://github.com/yetone/magpie/blob/dc507ae/docs/reference.md) · [账本与解码窗口](https://github.com/yetone/magpie/blob/dc507ae/internal/usage/usage.go) · [清空语义](https://github.com/yetone/magpie/blob/dc507ae/internal/usage/cleared.go)

## 指标口径

| 项目 | 计算方式 |
| --- | --- |
| 时间 | 解析带时区的 RFC 3339 后归一到 Unix 毫秒。界面统一显示 UTC。N 天是截至查询时刻的 N × 24 小时半开区间。全部从首条可见记录到现在。网关的 `t` 是起点；会话与上报行沿用来源提供的账本时间。 |
| 请求与结果 | 排除探测、MCP、搜索辅助源；`handed_on` 的已计费重试只贡献 token。其余最终行各算一次请求。取消使用宿主 `canceled` 或 499 且 `err_type=agent_canceled`。本地拒绝、其他错误状态或宿主错误标记计入错误。剩余 2xx 归完成，其余归未知。因会话记录可能没有 HTTP 状态，不能把每条结束记录都解释成成功。 |
| TPM | `(in + out) / 窗口分钟数`。输入是 Magpie 的非缓存输入；缓存读写分列，推理已经包含在输出时不会再次相加。缺少任一计数的行不贡献 TPM，覆盖数在详情中。零是账本报告值；供应商未上报但被宿主记作零时无法区分。 |
| RPM | 最终请求数除以整个窗口分钟数。TPM 与 RPM 的峰值按 UTC 对齐的自然分钟取最大值。边缘分钟只计落在窗口内的行，不外推。token 一次记在该行时间戳，无法反映流中每个 token 实际抵达的时刻。 |
| TPS | 对成功且有可靠流式计时的本机网关请求，按 Magpie `DecodeOf` 计算有效输出与解码时长，以总有效输出除以总有效秒数。可定位首文本时扣除推理；排除隐藏推理缺证、短于 100 ms、超过 10,000 tok/s、缓冲后集中返回等不可用样本。峰值是单请求最大有效 TPS。 |
| 并发 | 对本机已结束、`ms > 0` 的最终网关行扫过 `[t,t+ms)` 的起止事件，同刻先结束再开始，纳入从窗口前延伸进来的请求。在每个趋势分段内保留最大重叠数。共享机器、会话、客户端上报、耗时缺失和仍未结算的请求不参与。无可重建区间显示 `—`。 |
| 维度 | Client 表示产品级归属，优先取 `client`，否则取宿主记录的 `agent`。泛称 local/other 与缺失归未知。具体模型优先取回复声明的 `served`，缺失时展示账本路由模型。模型家族按可辨名称规则归类，组别名和未识别型号显示未分类。不会据 IP、账号或密钥推断终端身份。 |
| 趋势与比较 | 48 个等时段。每段 TPM/RPM 是该段均速；全窗峰值仍按一分钟。无记录处留下缺口。用于比较的前段是紧邻的同等时长，使用相同筛选；历史起点不足、前期无请求或该指标基数为零时均不可比。首末时间与有记录天数都不能证明期间连续采集。 |

索引只保存聚合所需字段、不可逆的宿主行 ID 和同步游标。来自 feed 的会话 ID、账号名、密钥标识、地址和错误原文均不写入索引或返回浏览器。可读错误状态使用固定提示。`/api/metrics` 可供本机调试，只返回汇总与筛选选项。

## 验证

```sh
bun test
# Linux 上可选的真实宿主与浏览器集成测试，需 Python Playwright 与 Chromium
FLIGHTLOG_CHROMIUM=/path/to/chrome python3 test/host_smoke.py
```

集成测试创建临时 HOME、XDG 配置、本地端口和一条明确的测试账本记录。测试实际执行 `magpie plugin add`，从 Magpie Web 侧栏打开插件，遍历五个窗口、三种筛选、趋势明细、390px 手机布局和减弱动效，然后关闭测试进程。真实 feed 的覆盖核对另行执行，测试样例不会合入真实账本。

8 项自动化测试共 46 个断言通过。隔离的 Magpie Web 宿主及 Chromium 端到端通过。另外在 360px 宽度核对了真实数据页面，未出现整页横向溢出。桌面原生 WebView、其他操作系统和公网反向代理未实测。
