# Media Scraper Desktop

跨平台本地视频整理与刮削桌面工具，面向 Windows 与 macOS。所有处理在本地完成（可选的 AI 命名走 OpenAI 兼容 API），无后端服务。

## 功能

- **目录清理**：扫描工作区生成「保留 / 删除 / 上移 / 待人工选择」计划，确认后执行；图片-视频自动配对、封面统一 `-poster.jpg`、子目录视频解散上移、空目录清理
- **视频合并**：多片段合并为单个 MP4；参数一致走无重编码 concat（秒级），不一致自动转码统一；支持横竖屏筛选、拖拽排序、断点续传、输出校验、合并后删源
- **批量重命名**：纯序号 / 正则清洗 / AI 命名 / 仅改扩展名四种模式，封面随视频联动改名，预览可编辑，两段式执行规避交换冲突
- **封面管理**：批量截帧（时间均布 + 场景切分检测），逐片精选帧、任意秒数补截，批量保存
- **NFO 归档**：按「一片一目录」归档并生成 Emby/Jellyfin/Kodi 兼容的 `.nfo` 元数据
- **视频去重**：大小分组 + 采样哈希找完全重复；可选相似重复聚类（同片不同压制）；快速模式跳过大目录全量探测
- **健康检查**：ffmpeg 全量解码校验损坏视频，统计缺 poster / 缺 NFO / 体积分布（只读）
- **自动化流水线**：清理 / 去重 / 归档 / 体检编排为预设串行执行；可配目录监控，丢入新片防抖后自动跑预设
- **媒体库**：卡片网格浏览、搜索、记忆进度的流式播放
- **操作日志与撤销**：所有写操作留痕，重命名 / NFO 归档支持一键撤销
- **其他**：删除默认进系统回收站（可改永久删除）、应用内自动更新、存储占用管理（截帧缓存/合并临时目录/日志清理）

## 技术栈

Electron 39 + React 19 + TypeScript + electron-vite（Vite 7）；`ffmpeg-static` / `ffprobe-static` 随包分发；`sharp` 图片转码。

## 开发

```bash
npm install
npm run dev    # 注意：从其他 Electron 应用的终端启动需先 unset ELECTRON_RUN_AS_NODE
```

## 校验与构建

```bash
npm run lint
npm run typecheck
npm test           # node:test 单元测试（真实临时目录夹具，媒体类测试生成真实小视频）
npm run build:mac  # macOS DMG
npm run build:win  # Windows NSIS（--x64 / --arm64）
```

> Windows 安装包在 GitHub Actions 的 Windows runner 上生成（x64 + arm64 双架构）；macOS DMG 在 macOS runner 上生成。推送 `v*` tag 自动发布 GitHub Release。

## 安装与打开（未签名阶段）

应用尚未使用 Apple Developer ID 签名 / 公证，从浏览器下载后会被系统隔离：

- **macOS 提示“已损坏，无法打开”**：这是 Gatekeeper 隔离标记所致，并非程序损坏。安装后在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Media Scraper.app"
```

- **Windows 提示 SmartScreen 警告**：点击“更多信息”→“仍要运行”即可。

> 后续申请 Apple Developer ID 后会在 CI 接入签名与公证，届时以上步骤不再需要。

## 规则摘要

文件写入操作均遵循“扫描 → 预览 → 用户确认 → 执行 → 报告”。删除默认移入系统回收站（可在设置改为永久删除）；隐藏文件与隐藏目录不参与处理。

更多实现细节见 [AGENTS.md](AGENTS.md) 与 [docs/模块能力说明.md](docs/模块能力说明.md)。
