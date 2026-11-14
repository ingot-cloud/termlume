# Windows 兼容性审计（2026-11-13）

以当前 Tauri 桌面应用为准。本轮已补齐此前列出的六项 Windows 缺失能力，Touch ID 保持 Mac 专用。Windows x64 已交叉构建；Windows 原生安装、服务连接和交互仍需在实机验收。

| 功能 | Windows 当前状态 | 依据与可用方式 |
| --- | --- | --- |
| SSH 密码、登录配置密码、私钥口令 | 已实现跨平台应用内加密 | `store.rs`、`ssh.rs`、`assets.rs`；工作区使用 XChaCha20-Poly1305，本机密码默认不进入备份和 Git |
| 保险库主密码、恢复密钥、自动解锁 | 已实现跨平台 | `vault.rs`、`startup_unlock.rs`；自动解锁文件由本机随机密钥加密 |
| 常用快捷键 | 已适配 Ctrl | `ui/shortcuts.js`；终端无选中文字时 Ctrl+C 仍发送中断 |
| SSH Agent 认证和 Agent 密钥列表 | 已适配 | `keys.rs`、`ssh.rs` 接入 Windows OpenSSH 命名管道；使用已启动的 ssh-agent 服务与已加载密钥，可用 SSH_AUTH_SOCK 指定命名管道 |
| 整目录下载 | 已适配 | `transfer.rs`、`platform.rs`；Windows 同卷发布目录，拒绝覆盖已存在的目标，保持临时目录和取消/失败清理。Windows 无法表示的文件名和链接按现有跳过规则处理 |
| 调起外部编辑器并回写 | 已适配 | `platform.rs` 使用 Windows edit 操作，无对应编辑器时退回记事本；沿用临时副本、确认上传和远端变化冲突检查，不用 open 执行脚本 |
| Git SSH 同步 | 已适配 | 安装器内置 MinGit 和 Win32-OpenSSH，应用按安装资源目录定位并为子进程补齐私有工具 PATH；不依赖系统 Git/OpenSSH。仍需配置自己的可用密钥与已核验的 known_hosts |
| 公钥与恢复密钥复制 | 已适配 | Windows Unicode 剪贴板原生接口，不调用 PowerShell 或依赖 shell 编码 |
| 系统等宽字体扫描 | 已适配 | GDI 枚举本机固定宽度字体，支持 Unicode 字体名，过滤垂直字体与重复结果 |
| Touch ID | 仅 Mac | 本轮按要求不实现 Windows Hello；使用主密码或恢复密钥 |

密码/私钥 SSH、单跳连接、端口转发、SFTP 单文件传输、内置编辑器、加密备份和 HTTPS Git 同步有跨平台实现。编译通过不代表 Windows 上的每项功能已经实机验收。

服务器信息采集另有远端条件：当前脚本面向 Linux/macOS，并要求远端执行 `sh`。这是远端服务器限制，与运行 Windows 客户端不同。

## 钥匙串弹窗修复

此前仍保留了旧 SSH 凭据的读取/删除、旧自动解锁凭据的读取/清理，以及 Electron 原型的 `safeStorage`。这些兼容代码可能触发系统授权，是之前遗漏的依赖。

本次移除应用运行时的系统密码存储访问，包含迁移和清理路径，并移除直接的 `security-framework` 依赖及 Swift `SecItemCopyMatching` 桥接。Electron 原型也改用随机本机密钥和 AES-256-GCM。macOS 的 Git 同步 SSH 显式设置 `UseKeychain=no` 和 `AddKeysToAgent=no`，避免读取用户 SSH 配置中的钥匙串设置。

- 已保存在应用加密工作区内的密码继续使用。
- 旧版仅在系统钥匙串里的 SSH 密码、登录配置密码、私钥口令需要重新输入并保存；界面不再将缺少应用内密文的引用显示为可用凭据。
- 旧自动解锁配置先要求手动验证主密码或恢复密钥，成功后转为应用内加密格式。写入失败保留旧配置以便重试。
- 旧系统记录保持原样，应用不读取、不写入也不尝试删除它们。

Touch ID 是用户主动启用的 Mac 生物识别能力，使用 Secure Enclave 和本机凭据文件，不使用通用密码钥匙串。SSH Agent 是外部服务，Agent 自身的认证行为由该服务控制。开发时的正式证书签名脚本仍可查询 macOS 签名身份；这是开发构建流程，临时签名试用版运行时不执行该脚本。

回归覆盖旧凭据重新保存、旧自动解锁手动转换、转换写入失败重试、凭据篡改/丢失安全回退，以及运行时源码禁止系统密码存储 API 的检查。


## 本轮检查与 Windows 验收

- Node 测试继续检查应用内凭据和禁止运行时密码存储 API；Mac 原生回归覆盖 Agent、Git SSH、整目录传输和外部编辑回写/冲突。
- Windows x64 的应用与测试目标均进行交叉编译检查；Windows 专用原子目录发布测试覆盖 Unicode 路径及拒绝覆盖已有数据，但尚未在 Windows 上运行。
- 新建主机在常规/窄窗口及 Win32/MacIntel 条件下回归：无分组时隐藏继承选项，选组/新组后显示，清空组取消隐藏继承，认证切换只显示对应字段，连接路径和登录配置归入更多设置。
- Windows 请重点验证：Agent 列表及认证、目录下载/重名/取消、外部编辑保存后上传与冲突拒绝、SSH Git 推拉、公钥/恢复密钥复制与中文等宽字体选择。

实现参考 Windows 官方 API：[目录移动](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)、[Unicode 剪贴板](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-operations)、[字体枚举](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-enumfontfamiliesexw)、[字体间距标志](https://learn.microsoft.com/windows/win32/api/wingdi/ns-wingdi-textmetrica)、[编辑文件操作](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecutew)。


## Windows Git / OpenSSH 内置交付

Windows 安装包携带 [MinGit 2.56.1](https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1) 和 [Microsoft Win32-OpenSSH 10.4](https://github.com/PowerShell/Win32-OpenSSH/releases/tag/10.4.0.0p1-Preview) 客户端。二进制归档以官方 SHA-256 和长度固定，完整 MinGit 运行时及许可证保留；Win32-OpenSSH 保留客户端、辅助程序、libcrypto 和许可通知，不打包或执行 sshd 的服务安装脚本。

使用 Tauri Windows 专用资源配置，将工具安装到应用自己的 tools/windows/。运行时从 resource_dir 初始化路径，仅使用内置 Git 与 SSH；缺失时提示修复 Termlume，不回退到用户 PATH。Git 子进程显式设置私有 PATH、GIT_EXEC_PATH、GIT_SSH_VARIANT，保持全局配置与钩子隔离。宿主环境未改变，应用不会注册或启动系统 SSH 服务。

资源校验包括 388 个文件摘要，以及实际调用的 19 个 x64 PE 程序/DLL 的依赖闭包，未发现需要单独安装的 DLL。MinGit 中未使用的凭据管理器组件不会被调用；Termlume 的凭据仍在应用中加密保存。Agent 认证是与已有 Agent 的互操作能力，仍需要用户加载自己的密钥；直接密码/私钥连接以及内置 SSH 客户端不要求安装 Agent 服务。

Windows 测试包附带 Test-Bundled-Tools.ps1：仅在临时目录和子进程中检查内置 Git/SSH 版本、Git 对象/提交读写，并确认 Git 能通过内置 Shell 调起内置 SSH；子进程 PATH 只含内置工具和 Windows System32，不访问远端网络或用户私钥。脚本尚待 Windows 实机执行。完整离线安装包现已同时内置 WebView2 Standalone 安装器，缺失时从安装包释放并安装，不需要下载依赖；详见 OFFLINE_DISTRIBUTION.md。

构建依据：[MinGit 定位](https://gitforwindows.org/mingit.html)、[Tauri 平台配置](https://v2.tauri.app/develop/configuration-files/)、[Tauri 构建环境变量](https://v2.tauri.app/reference/environment-variables/)。
