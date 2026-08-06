# Media Scraper Desktop

跨平台本地视频整理与刮削工具，面向 Windows 与 macOS。

## 当前工程能力

- Electron + React + TypeScript 工程骨架
- GitHub Actions 构建 Windows `exe` 与 macOS `dmg`
- 后续实现工作区扫描、媒体探测、文件清理、poster 管理、重命名、NFO 归档与视频合并

## 开发

```bash
npm install
npm run dev
```

## 校验与构建

```bash
npm run lint
npm run typecheck
npm run build:mac
npm run build:win
```

> Windows 安装包在 GitHub Actions 的 Windows runner 上生成；macOS DMG 在 macOS runner 上生成。

## 安装与打开（未签名阶段）

应用尚未使用 Apple Developer ID 签名 / 公证，从浏览器下载后会被系统隔离：

- **macOS 提示“已损坏，无法打开”**：这是 Gatekeeper 隔离标记所致，并非程序损坏。安装后在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Media Scraper.app"
```

- **Windows 提示 SmartScreen 警告**：点击“更多信息”→“仍要运行”即可。

> 后续申请 Apple Developer ID 后会在 CI 接入签名与公证，届时以上步骤不再需要。

## 规则摘要

文件写入操作均遵循“扫描 → 预览 → 用户确认 → 执行 → 报告”。永久删除不可恢复；隐藏文件与隐藏目录不参与处理。
