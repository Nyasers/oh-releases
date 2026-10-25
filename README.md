# OH Releases

一个 Hana v2 App，订阅 [HanaAgent](https://github.com/liliMozi/openhanako) 的 Release。新版本出现就发系统通知，并在独立卡片里逐版展示更新内容与可下载资产。整条链路不需要 Agent 参与，也不依赖 GitHub API 配额。

## 它做什么

- **订阅**：定时读 `releases.atom`（带 ETag，未变化时 304 零字节），按 tag 去重判断是否新版
- **回填**：首次运行从 tags 分页往回抓历史版本，遇到没有 digest 的断口继续往前找接续点
- **展示**：一张整页卡，顶部切“版本 / 设置”；版本视图左侧版本列表，正文区是变更条目，右侧是安装包 / 压缩包 / 清单三组资产
- **下载**：常驻下载服务维护一个全局连接池，断点续传、分片并行、进度回传，下完按官方 sha256 校验；下载源由用户自己配（直连 GitHub 或自填反代前缀）
- **下载页**：主页第三个视图，实时看总速度、连接占用、每个任务的进度；支持暂停、继续、取消，连接数按 2 的幂调节

## 目录

```
manifest.json          App 声明：权限、卡片
assets/icon.svg        身份图标
src/app.js             入口：路由、定时计划、通知、工具
src/lib/store.js       node:sqlite 存储（WAL，data.db）
src/lib/upstream.js    GitHub 读取：atom、tags、expanded_assets
src/lib/backfill.js    历史回填与断口接续
src/lib/poll.js        轮询、附件抓取、通知文案
src/lib/settings.js    设置项定义、默认值与校验
src/lib/download.js    下载任务编排，经下载服务落到 runtime/downloader.mjs
src/lib/download-service.js  与常驻下载服务的双向通信（runtime.fetch）
runtime/service.mjs    常驻下载服务：任务表、连接池、状态回传
runtime/pool.mjs       进程级连接池（跨任务共享）
runtime/downloader.mjs 下载器本体（跑在 local-machine 运行时里）
ui/                    主页（版本 / 下载 / 设置三个视图）
ui/assets/cover.svg    卡片封面
scripts/               构建、打包、检查、模拟测试
vendor/                App SDK 的 tgz（构建期依赖，故入库）
```

## 开发

```sh
pnpm install
pnpm run check          # 语法/import/manifest 检查 + 构建
pnpm run test:backfill  # 回填与断口逻辑（离线，打桩上游）
pnpm run test:download  # 下载器逻辑（离线，打桩文件与网络）
pnpm run pack           # 产出 releases/oh-releases-v0.1.0.zip
pnpm run install:local  # 装进本机宿主
```

`dist/` 与 `releases/` 是构建产物，不入库，每轮由 `scripts/build-app.mjs` 重建。

一次性的探针脚本、临时截图、代理进程日志一律写到仓库里的 `.tmp/`，用完删掉。

写进 App 数据目录的名字另有一套：`app-data/<appId>/.runtime-tmp` 是宿主为受管运行时
建的子进程 TMPDIR，不归 App 管；`app-data/<appId>/downloads` 是本 App 的默认落点。

## 运行时权限

`manifest.json` 的 `capabilities` 只留实际调用的：

| 权限 | 用途 |
|---|---|
| `app/tools.expose-to-model` | 向模型暴露“检查更新”“列版本”两个工具 |
| `app/tasks.manage` | 定时轮询计划（没这个权限计划不会触发） |
| `app/notifications.show` | 新版通知，只收 `{title, body}` |
| `app/runtime.execute` | 启动任何受管运行时的前置条件 |
| `app/runtime.local-machine` | 下载器要脱离文件系统隔离，才能写任意目录（不限 dataDir） |
| `app/runtime.network` | 下载器的出站请求（不受 `network.allowedHosts` 约束） |
| `app/resources.read` | 设置页的“选择”调用 `hana.resources.pick` 选下载目录 |

## 下载源

不内置任何镜像。默认为直连 `https://github.com`；在设置里点“修改”填一个反代前缀
（例如 `https://ghproxy.net`），下载地址就是 `<前缀>/github.com/<owner>/<repo>/releases/download/<tag>/<asset>`。
镜像只是反代前缀，不认占位符模板。下载完会按 GitHub 官方 sha256 校验；
上游没给 sha256 的版本仍然允许下载，但结果里 `verified: false`。

**没有** `app/ui.open-external`：宿主的界面能力白名单里，`external.open` 只允许 `page / widget / settings / function-panel`，不含 `card`，而这面卡在宿主里就是 `card` 槽位。所以卡底的数据来源只作纯文本展示，不做成可点链接。

## 设置在哪

`contributes.settings` 已撤除：设置不再是宿主设置窗里的一个标签页，而是主页卡顶部“版本 / 设置”切换出来的第二个视图。两个视图读写同一个后端（`GET /settings`、`PUT /settings`），配置的真相在 App 自己的库里。

## 已知边界

- 不比对版本号大小，只用 tag 去重。上游 tag 命名不保证单调，比对大小反而会误判
- `v0.390.0` 在 tags 列表里不存在（`v0.391.2` 的 previousTag 指向它），接续逻辑按“找不到就继续往前”处理
- `v0.351.5` 往下整段无 digest，属于上游历史数据边界

## 许可

Mozilla Public License 2.0，见 `LICENSE`。
