# ShellDeck

Windows 专用、免登录、绿色便携的 SSH/SFTP 桌面工作台。

## 为什么做

日常用的 SSH/SFTP 工具功能很多，但真正常用的只有连接服务器、开终端、传文件、标签和几条常用指令。菜单层级、低频功能和无关提示让每次操作都变长。

ShellDeck 是用 AI 从零实现的个人客户端，只保留每天会用到的高频路径，界面和交互按自己的使用习惯定制。不追求替代大型客户端，也不加入登录、遥测、NAS 跳板等低频能力。

## 功能

- Electron + Vue 3 + xterm.js + `ssh2` + `better-sqlite3`，绿色文件夹分发
- 服务器清单：不限数量，IP 优先排序，搜索、标签筛选、备注预览、详情查看、Excel 导入导出
- 服务器交互：单击选择；双击依次打开终端、文件，两者都已打开时给出提示；右键打开会话、编辑、复制密码或删除
- 认证：密码或 SSH 私钥（OpenSSH/PEM，支持私钥口令）
- 编辑器：紧凑单行布局、明文密码、已有标签多选、快速新增标签、多行备注
- 会话工作区：1/2/4/6/9 格、按布局容量自动分页、切换布局自动重排、拖动换位、放大、自动/手动文字缩放
- 终端：多会话并发、PTY、断线重连、`sudo -i` 自动填密码、常用指令不限数量、终端内模糊搜索、`{{参数}}` 替换
- 常用指令：管理弹窗支持按名称/内容搜索，终端下拉框支持跳字模糊匹配和键盘选择
- SFTP：路径跳转、上传文件/文件夹、上传下载进度/速度/ETA、同名覆盖确认、下载、文本编辑（≤2 MB）、权限修改、重命名、删除
- root 模式：优先使用服务器保存的密码，密码错误时弹框重填；切换 root 保持当前目录
- 文件管理和终端都有右键菜单；文件支持复制、剪切、粘贴、移动、刷新
- 主题：浅色/深色切换，深色采用 IntelliJ IDEA 风格，弹窗、会话列表和表单一并适配
- 系统集成：关闭到托盘、托盘菜单、单实例恢复并聚焦已有窗口、窗口状态恢复
- 数据：本机 SQLite（WAL，明文），支持打开目录、备份、恢复
- 更新：内置 GitHub Releases、加速源和自定义前缀；签名清单、SHA-256 校验、app.asar 增量安装；更新弹窗只有“立即更新”和“下次再说”

## 分发结构

```text
release/ShellDeck/
  ShellDeck.exe        入口启动器（顶层）
  runtime/             Electron 运行依赖、app.asar、locales、DLL
  data/                首次启动生成：ssh.db、backups、updates
```

双击顶层 `ShellDeck.exe` 启动，`runtime` 与入口必须放在同一目录。数据目录固定在顶层 `data`，不会写进 `runtime`，也不写 AppData。

## 开发与构建

要求 Node.js 22+。

```bash
npm install
npm run dev        # Vite + Electron 开发模式
npm run dist       # 构建 release/ShellDeck
```

`better-sqlite3` 13.x 使用 N-API 预编译包，不需要 VS 编译。打包时设置 `npmRebuild: false`，`.node` 由 `asarUnpack` 解包。入口启动器由 `scripts/launcher/ShellDeckLauncher.cs` 编译，依赖 Windows 自带的 .NET Framework 4.x。

## 数据位置

- 开发模式：仓库根目录 `data/ssh.db`
- 打包后：`release/ShellDeck/data/ssh.db`
- 目录不可写时启动直接报错退出，不改写到 AppData
- 密码、私钥、口令均为本机明文存储；设置里可打开数据目录、备份和恢复

## 测试

自动化脚本使用临时数据目录和临时用户目录，不读写 `release/ShellDeck/data`。

```bash
npm run build:web
node scripts/e2e.cjs              # 终端、SFTP、指令、更新签名、托盘隐藏
node scripts/e2e-packaged.cjs     # 打包版终端、SFTP、更新弹窗
node scripts/e2e-update-helper.cjs # 更新 helper 替换、备份、重启、失败回滚
node scripts/e2e-ui.cjs           # 布局切换自动分页、服务器右键菜单
node scripts/e2e-file-menu.cjs    # 文件/终端右键、标签、主题、紧凑编辑框
node scripts/e2e-key-auth.cjs     # SSH 私钥登录、标签选择
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/e2e-folder.ps1
                                  # 文件夹布局、启动耗时、数据位置、二次启动
```

`e2e.cjs` 需要本机 `127.0.0.1:12222` 的测试 SSH 服务（用户 `tester`、密码 `testpw`）；仓库不附带该服务，可用容器或任意测试镜像自行启动。

## 更新

应用内更新走 GitHub Releases：

- 仓库内置在 `shared/update-config.json`，设置里不暴露地址
- 「设置 → 更新」只选择网络方式：自动、直连、内置加速或自定义加速前缀；自动模式先直连，失败后依次尝试内置加速
- 每次 Release 上传 `app.asar`、`release.json`、`release.json.sig`
- 普通更新只下载并替换 `runtime/resources/app.asar`，数据目录不动
- Electron、原生模块或入口启动器变化时，用 `--format full` 生成整包清单；整包目前需手动替换 `runtime`
- 加速服务只转发请求，不改变签名校验；清单和资产仍按内置公钥、SHA-256 校验

生成签名清单（私钥在本地 `.release-keys/private.pem`，已被 `.gitignore` 忽略）：

```bash
npm run release -- --version 0.2.0 \
  --file release/ShellDeck/runtime/resources/app.asar \
  --url https://github.com/tan0105/ShellDeck/releases/latest/download/app.asar \
  --notes "更新说明"
```

应用内置公钥在 `electron/updater.cjs`；签名默认读取 `.release-keys/private.pem`，也可用 `--key` 或 `SHELLDECK_RELEASE_KEY` 指定其他位置。

## 已知限制

- root 模式尚未在真实 Linux + sudo 环境完整验收；root 列目录依赖 GNU `find -printf`
- app.asar 更新要求 Electron 版本一致；整包自动替换和二进制差分暂未实现
- GitHub 更新假定仓库公开、无需认证；私有仓库需要额外加 token 支持
- 密码、私钥、口令均为本机明文存储
- 入口和程序未签名，首次运行可能触发 SmartScreen 或杀软提示
- 上传同名冲突（含嵌套目录）合并为一次确认；文件夹请用“上传文件夹”
- 不包含登录/权限、NAS 跳板、遥测或云端同步

## 文档

- [落地实现方案](docs/实现方案.md)
