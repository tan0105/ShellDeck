# ShellDeck

Windows 专用、免登录、绿色便携的 SSH/SFTP 桌面工作台。

当前版本：**0.1.0**，第一版功能和打包链路已落地。

## 已实现

- Electron + Vue 3 + xterm.js + `ssh2` + `better-sqlite3`，文件夹分发（入口 exe + `runtime` 依赖目录）
- 服务器清单：增删改、搜索、标签筛选、密码/私钥明文保存、Excel 导入导出，最多 50 台
- 认证方式：密码或 SSH 私钥（OpenSSH/PEM，支持私钥口令）
- 标签：已有标签直接多选，支持快速新增；服务器编辑框为紧凑布局
- 会话工作区：1/2/4/6/9 格、按布局容量自动分页、拖动换位、放大、自动/手动文字缩放、重复会话确认
- 服务器列表：单击切换，右键菜单直接打开终端、文件、编辑、复制密码或删除
- 主题：浅色/深色模式切换（太阳/月亮图标），深色使用 IntelliJ IDEA 风格配色
- SSH 终端：多会话并发、PTY、断线重连、`sudo -i` 自动填密码、常用指令（最多 50 条）和 `{{参数}}` 替换
- SFTP：列目录、路径跳转、上传文件/文件夹、上传下载进度/速度/ETA、同名覆盖确认、下载、文本编辑（≤2 MB）、权限修改、重命名、删除、root 模式
- root 模式：使用服务器保存的密码；密码错误时弹框重填（仅本次会话）；切换 root 保持当前目录
- 系统集成：关闭到托盘、托盘菜单、单实例（再次启动恢复并聚焦已有窗口，不改变大小）、窗口状态恢复、退出前运行中任务确认
- 数据：`data/ssh.db`（WAL，明文），备份/恢复，数据目录入口
- 更新：当前暂时移除应用内更新配置；更新方式为退出后替换 `runtime` 目录，更新签名和 helper 代码保留待后续启用

## 分发结构

```text
release\ShellDeck\
  ShellDeck.exe        入口启动器（顶层）
  runtime\             Electron 运行依赖、app.asar、locales、DLL
  data\                首次启动生成：ssh.db、backups、updates
```

- 双击顶层 `ShellDeck.exe` 启动；`runtime` 与入口必须放在同一目录。
- 入口启动器把数据目录固定到顶层 `data`，数据不会写进 `runtime`。
- 这是文件夹版，没有自解压，也没有 `runtime-cache`；本机实测首开约 1 秒，二次启动约 0.2 秒且不改变窗口大小。

## 开发与构建


```bash
npm install
npm run dev        # Vite + Electron 开发模式
npm run dist       # 构建 release\ShellDeck\（入口 + runtime）
```

electron-builder 的中间产物放在工作区外的 `../ShellDeck-build`，最终文件夹放在 `release/ShellDeck`。入口启动器由 `scripts/launcher/ShellDeckLauncher.cs` 编译，依赖 Windows 自带的 .NET Framework 4.x。


`better-sqlite3` 13.x 是 N-API 预编译包，不需要 VS 编译；打包时 `npmRebuild: false`，`.node` 由 `asarUnpack` 解包。

## 数据位置

- 开发：仓库根目录 `data/ssh.db`
- 打包后：`release\ShellDeck\data\ssh.db`（入口启动器设置 `SHELLDECK_DATA_DIR`）
- 目录不可写时启动直接报错退出，不改写到 AppData
- 密码、指令明文保存，界面的“设置 → 数据”可打开目录、备份和恢复

## 测试

本地 SSH/SFTP 测试服务：

```bash
# 127.0.0.1:12222 / tester / testpw
```

自动化验证：

```bash
npm run build:web
node scripts/e2e.cjs              # 开发版（dist）：终端、SFTP、指令、更新签名、托盘隐藏
node scripts/e2e-packaged.cjs     # release\ShellDeck\runtime 打包版功能
node scripts/e2e-update-helper.cjs # 更新 helper 替换 runtime exe、备份、重启、失败回滚
node scripts/e2e-ui.cjs           # 布局切换自动分页、服务器右键菜单
node scripts/e2e-file-menu.cjs    # 文件/终端右键、标签、主题、紧凑编辑框
node scripts/e2e-key-auth.cjs     # SSH 私钥登录、标签选择、明文密码、紧凑编辑框
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-folder.ps1
                                  # 文件夹布局、启动耗时、数据位置、二次启动保持原大小
```

`scripts/e2e.cjs` 会校验签名清单下载、篡改清单拒绝、主进程数据库内容（服务器/指令/主机指纹）。

## 更新

当前版本暂不提供应用内更新配置。更新方式：退出程序，用新版本的 `runtime` 目录覆盖旧目录，保留顶层 `data`；入口有变化时替换整个文件夹并保留 `data`。更新签名清单和 helper 代码保留，后续再设计具体更新流程。


## 已知限制（第一版）

- root 模式尚未在真实 Linux + sudo 环境验收；测试服务没有 sudo，仅验证了普通 SFTP 和错误路径。root 列目录依赖 GNU `find -printf`。
- 应用内更新界面暂时移除，更新为手动替换 `runtime`/整个文件夹；helper 的替换、备份、重启和失败回滚已单独验证。
- 密钥登录已用本地 SSH 密钥服务验证终端连接；SFTP 使用同一套认证参数。密码、私钥、口令均为本机明文存储。
- 顶层入口启动器依赖 Windows 自带的 .NET Framework 4.x；入口和程序都未签名，首次运行可能触发 SmartScreen 或杀软提示。
- AGW 源当前按静态目录布局读取；没有厂家接口规格时不做字段映射。
- 上传同名冲突（含嵌套目录）合并为一次确认；SFTP 不保留目录层级拖拽，文件夹请用“上传文件夹”。
- 托盘菜单、单实例、窗口还原、真实 Linux sudo 未纳入自动化用例；Excel 导入导出和数据库恢复走 Windows 原生文件对话框，未做 UI 自动化（数据库导入/备份后端已验证）。
- 不包含登录/权限、NAS 跳板、SSH 小工具配对和遥测。

## 文档

- [落地实现方案](docs/实现方案.md)
