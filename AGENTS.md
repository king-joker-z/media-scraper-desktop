# AGENTS.md — AI 协作指南

> 本文件面向 AI 编码助手（Claude / CatPaw / Cursor 等），提供在本仓库高效、安全工作的全部上下文。
> 修改代码前请先读完「架构」「约定」「陷阱」三节。功能级细节见 `docs/模块能力说明.md`。

## 项目概述

**Media Scraper Desktop**：本地视频整理与刮削桌面工具。所有处理在本地完成（除可选的 AI 命名走 OpenAI 兼容 API），无后端服务。

- 技术栈：Electron 39 + React 19 + TypeScript 5.9 + electron-vite 5（Vite 7）
- 媒体处理：`ffmpeg-static` / `ffprobe-static`（打包时随应用分发）、`sharp`（图片转码）
- 平台：macOS / Windows（Linux 配置存在但非主目标）
- 语言：UI 与代码注释均为**中文**，提交信息使用中文

## 常用命令

```bash
npm run dev          # 开发模式（HMR）。注意：从其他 Electron 应用的终端启动需先 unset ELECTRON_RUN_AS_NODE
npm run lint         # ESLint（flat config）
npm run typecheck    # tsc 双工程（node + web）
npm test             # node:test 单元测试（test/*.test.mjs，真实临时目录夹具，可生成真实视频）
npm run build        # typecheck + electron-vite build
npm run build:win    # Windows NSIS 安装包（dist/*.exe）
npm run build:mac    # macOS DMG（dist/*.dmg，ad-hoc 签名）
```

**提交前必须通过**：`lint`、`typecheck`、`test` 三项全绿。CI（`.github/workflows/build.yml`）quality job 执行同样三项，失败会阻断 Windows/macOS 构建 job。

## 架构

三进程结构，类型单一来源：

```
src/shared/types.ts     ← 唯一的跨进程类型来源（只允许类型，禁止运行时代码）
src/shared/*.mjs        ← 纯函数共享规则（rename-rules / merge-rules），main 与 renderer 都直接 import
src/main/               ← 主进程：全部文件写入、ffmpeg/ffprobe 调用、AI 请求都发生在这里
src/preload/            ← contextBridge 暴露 window.api（渲染端唯一入口）
src/renderer/           ← React UI：无 Node 权限，一切经 window.api
```

关键设计：

1. **`.mjs` + 手写 `.d.ts` 配对**：主进程业务逻辑全部是 `.mjs`（Node ESM，可直接被 `node --test` 测试），旁边的手写 `.d.ts` 用 `declare module './xxx.mjs'` 为 TS 侧提供类型。新增主进程模块时沿用此模式。
2. **TaskCenter**（`core/task-center.mjs`）：所有批量任务的统一并发调度器（并发 1–20，默认 5，设置页可调）。产出 `TaskEvent`（start/progress/item-done/item-error/done/cancelled），主进程 120ms 节流后经 `tasks:event` 频道广播；渲染端 `TaskProgress`（全局进度条）与 `TaskCenter` 组件（任务抽屉）订阅展示。新批量任务必须接入 TaskCenter 以获得并发控制、取消与进度展示。
3. **页面常驻挂载 + 指纹同步**：`App.tsx` 一次性挂载全部 10 个页面，切换只切显隐 class（状态不丢）；每页通过 `useWorkspaceSync(workspace, active, scan)` 在变为可见时对比 `computeFingerprint(root)`（递归文件 相对路径+大小+mtime 的 MD5），**有变化自动重扫，无变化直接展示缓存**。不要用 `key` 强制重挂载页面。
4. **`media://` 自定义协议**：渲染端访问本地图片/视频的唯一通道（`renderer/src/utils/media.ts` 的 `mediaUrl()`）。主进程维护允许根集合（已选工作区 + 截帧临时目录），范围外一律 403；透传 Range 请求（视频拖动进度条依赖）；图片响应强制 `Cache-Control: no-store`（封面是同路径覆盖写入，禁缓存防旧图）。URL 解码后的路径还原与白名单归一化统一走 `core/media-path.mjs`（盘符/反斜杠/UNC/`..` 穿越防护），不要在 `index.ts` 里另写归一化逻辑。
5. **两段式重命名**（`modules/rename/execute.mjs`）：先全部改到临时名再改到目标名，规避 A↔B 交换冲突。
6. **操作日志 + 撤销**（`core/op-log.mjs` + `modules/undo/undo.mjs`）：清理/重命名/归档/合并删源/去重删除完成后写 JSON 到 `userData/op-logs/`；重命名与 NFO 归档类日志支持**一键撤销**（按日志反向恢复，成功后标记 `undoneAt`，重复撤销被拒绝）。渲染端 `OpLogPanel` 展示，可跳转系统文件管理器定位。日志写入不阻塞主流程。
7. **FFmpeg 进程池**（`core/ffmpeg-pool.mjs`）：所有 ffmpeg/ffprobe 子进程经 `runPooled`/`spawnPooled` 受池控（1–8，默认 4，设置页 `ffmpegPoolSize` 可调），防大批量任务同时起几十个子进程打满 CPU/内存。池大小可运行时 `setPoolSize` 调整。
8. **进程注册表**（`core/process-registry.mjs`）：全部子进程经 `trackChild` 登记，取消/退出时统一收尾——POSIX 发 SIGTERM、Windows 向 stdin 写 `q`（ffmpeg 优雅退出，来得及写 mp4 moov），宽限期后兜底 SIGKILL。`before-quit` 轮询等活跃进程归零（上限 3s）再强杀。
9. **LRU 有界缓存**（`core/lru-cache.mjs`）：probe 缓存、AI 命名缓存、文件哈希缓存统一用 `createLruCache(cap)`，防长期使用后 Map 无界增长。
10. **扫描钉住（pinning）**（`core/scanner.mjs`）：`pinScanRecords(root)` 后流水线各步经 `applyScanMutations(root, { deleted, moved })` 增量维护记录，`createScanPlan` 直接复用不重复遍历磁盘；流水线结束必须 `unpinScanRecords()`（建议 try/finally）。未钉住时 `applyScanMutations` 是 no-op。
11. **自动化流水线**（`modules/pipeline/pipeline.mjs`）：clean/nfo/dedupe/health 四模块可编排成有序步骤串行执行，预设持久化在设置（`pipelinePresets`）；配合 `core/dir-watch.mjs` 目录监控（尾随防抖）实现「丢入新片自动执行预设」。

## 目录速查

| 路径                           | 职责                                                                                                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`            | 主进程入口：窗口、`media://` 协议、全部 `ipcMain.handle` 注册、任务事件节流广播、退出前进程收尾                                                                                                                                         |
| `src/main/core/`               | 基础设施：scanner（扫描+指纹+pinning）、task-center、settings、probe（ffprobe+缓存）、frames（截帧/场景切分）、fs-ops（唯一文件写入口）、image（sharp）、file-hash、op-log、ffmpeg-pool、process-registry、lru-cache、media-path、dir-watch、task-report |
| `src/main/modules/`            | 业务能力：clean / merge / rename(execute+ai) / poster / nfo / dedupe / health / pipeline / undo                                                                                                                                         |
| `src/shared/`                  | `types.ts`（类型唯一来源）、`rename-rules.mjs`、`merge-rules.mjs`（纯函数规则，双端复用）                                                                                                                                               |
| `src/renderer/src/pages/`      | 10 个页面，与侧边栏模块一一对应                                                                                                                                                                                                         |
| `src/renderer/src/components/` | ConfirmDialog / TaskCenter / TaskProgress / VideoModal / MergeSortableList / PosterDetail / OpLogPanel / ErrorBoundary                                                                                                                  |
| `test/`                        | 23 个 `node:test` 测试文件，与主进程模块基本一一对应                                                                                                                                                                                    |

## 约定（新增/修改代码时遵守）

- 类型一律加到 `src/shared/types.ts`；`.mjs` 改签名必须同步更新其 `.d.ts`。
- 渲染端需要新能力 → 主进程加 `ipcMain.handle` → `preload/index.ts` 暴露 → `preload/index.d.ts` 补类型，三步缺一不可。
- 文件删除/移动/改名只允许走 `core/fs-ops.mjs`；重名冲突由 `ensureUniquePath`/`moveWithCollision` 追加 ` (n)` 后缀处理。
- 共享纯逻辑（命名规则、合并判定）放 `src/shared/*.mjs`，保持零依赖、可单测。
- 危险操作（删除类）UI 必经 `ConfirmDialog`；高风险计划（删除>50 项 / >1GB / 无视频）要求输入确认词。
- 页面要接 `active` prop + `useWorkspaceSync`，不要自行在 `useEffect(() => {...}, [])` 里无条件扫描。
- Prettier 格式化（无分号、单引号、100 列）；ESLint 含 react-hooks 规则（渲染期间禁止写 ref，需放 effect 内）。

## 测试约定

- 运行器：`node --test test/**/*.test.mjs`（Node 22 内置，无 Jest/Vitest）。
- 夹具：真实临时目录（`fs.mkdtemp`），媒体类测试用 ffmpeg lavfi 生成真实小视频（如 `test/frames.test.mjs`）。测试真实跑 ffmpeg，保持快速（时长几秒、低分辨率）。
- 网络类（AI）测试注入 `fetchImpl` mock，不打真实请求。
- 取消语义：TaskCenter 的取消是「停止派发新任务 + AbortSignal 通知在途」，在途项可自行决定收尾。

## 陷阱（踩过的坑）

- **`ELECTRON_RUN_AS_NODE`**：从其他 Electron 应用（如 IDE 内嵌终端）继承此变量会导致 `npm run dev` 时 Electron 以纯 Node 模式启动并崩溃（`electron.app` undefined）。启动前 `unset ELECTRON_RUN_AS_NODE`。
- **ffmpeg 路径**：打包后 `ffmpeg-static`/`ffprobe-static` 在 `app.asar.unpacked`，务必经 `resolveFfmpegPath()`/`resolveFfprobePath()` 取路径（已配置 `asarUnpack`），不要直接引用包内路径。
- **sharp 原生模块**：`.node` 二进制无法从 asar 内 dlopen，**Windows 打包后直接崩溃**。`asarUnpack` 必须同时包含 `node_modules/sharp/**` 和 `node_modules/@img/**`（sharp 0.35+ 平台二进制在可选依赖 @img/* 中，漏了 @img 一样崩）。
- **media:// Windows 路径**：工作区根来自系统对话框（反斜杠、盘符可能小写），URL 解码后是正斜杠——不归一化白名单全误判 403。统一走 `core/media-path.mjs`；UNC 路径（`\\NAS\share`）要保留双斜杠前缀，且必须 `resolve()` 归一化 `..` 防路径穿越绕过白名单。
- **Windows 文件名限制**：`rename-rules.mjs` 的 `validateStems` 已覆盖三类——保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，rename 报 EINVAL）、末尾点号/空格（Windows 自动截断导致名实不符）、ASCII 控制字符。AI 命名的 system prompt 也内置了这些约束。
- **ffmpeg concat 清单**：Windows 上 `buildConcatList` 生成的清单必须把 `\` 替换为 `/`，否则 concat demuxer 解析失败。
- **Windows 杀 ffmpeg**：Windows 无 POSIX 信号，`process.kill()` 等于强杀，mp4 moov 来不及写导致输出损坏。`process-registry.mjs` 已处理（stdin 写 `q` + 延长宽限期），新增子进程类型时注意其优雅退出方式。
- **Windows 瞬态文件锁**：杀软/索引器会短暂锁住刚写入的文件，`fs-ops.mjs` 的 `withLockRetry` 已对删除/移动做重试，新增写操作复用它。
- **图片缓存**：封面保存是同路径覆盖写，渲染端 `<img>` 需配合 URL 版本参数 + 协议层 `no-store`，否则显示旧图。
- **macOS 隔离属性**：本机下载的 DMG 首次打开可能报「已损坏」，属 Gatekeeper quarantine（ad-hoc 签名），`xattr -cr` 可解。
- **合并断点续传**：中间段就绪判定必须校验时长（±1s），否则上次取消留下的截断段会被误判为可复用，导致输出时长校验失败。
- **合并产物再参与合并**：扫描合并候选时必须用 `isMergeOutputName` 排除 `*-merged.mp4`。
- **CI artifact 配额**：私有仓 Actions 存储有限，workflow 已加「只保留最新 4 个 artifact」修剪步骤 + 7 天过期；新增上传步骤时沿用 `retention-days` 并不要删修剪步骤。
- **react-hooks/purity**：渲染期间禁止调 `Date.now()` 等 impure 函数（ESLint 报错），生成 ID 用 `crypto.randomUUID()`。
- **`no-control-regex`**：命名校验正则刻意匹配控制字符（`\x00-\x1f`），用行内 `eslint-disable-next-line` 豁免，不要为过 lint 删掉控制字符段。

## CI / 发布

- 推送 `main` 或 PR → quality（lint+typecheck+test）→ Windows NSIS（**x64 + arm64 matrix**）/ macOS DMG 并行构建，产物传 artifact。
- Windows arm64 为原生构建（WoA 设备如 Surface Pro 免模拟层跑 ffmpeg 转码）。
- artifact 配额保护：仅保留最新 4 个 + `retention-days: 7`，每个构建 job 末尾自动修剪旧 artifact。
- 打 `v*` tag → 构建产物自动上传 GitHub Release（`--publish always`）；分支/PR 构建显式 `--publish never`，防撞同名草稿 Release 资产 422。
- macOS 当前为 ad-hoc 签名（`identity: null`），无公证；Windows NSIS 为辅助安装模式（可选路径），图标 `build/icon.ico`。
