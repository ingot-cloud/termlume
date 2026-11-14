# 离线安装与运行

Windows x64 安装包内置 MinGit、Win32-OpenSSH 和完整 WebView2 Standalone 离线安装器。缺少 WebView2 时，NSIS 从自身释放完整安装器并静默执行，不下载 Bootstrapper。已有 WebView2 可直接复用；未设置会调用在线更新器的 minimumWebview2Version 分支。

Mac Apple Silicon 包内置用于 SSH 保险库同步的 Git 2.56.1 客户端，Git 从官方源码构建，仅链接 macOS 自带的系统库；应用按资源目录调用它，避免系统 Git 可能引导安装 Xcode 命令行工具。SSH、剪贴板、外部文本编辑与 WebKit 使用 macOS 自带能力。HTTPS Git 同步继续走内置 libgit2。

两个平台的界面脚本、编辑器、字体样式和终端资源均在应用内，不从 CDN 获取。安装、启动、保险库解锁、主机配置和本地备份不要求互联网；SSH/SFTP/Git 远程操作需要能访问目标服务器。用户主动配置的自动同步仍按原设置工作，网络失败不阻塞本地工作区打开。

## 构建与来源

- Windows 工具归档固定在 scripts/windows-tools.lock.json，许可与来源通知随安装保留。
- 完整 WebView2 x64 离线安装器固定在 scripts/webview2.lock.json，构建前校验长度和 SHA-256，最终校验 NSIS 内嵌文件与该归档一致。Tauri 的构建阶段仍可联网解析官方下载地址；交付安装包本身不需要下载依赖。
- Mac Git 源码、摘要和构建选项固定在 scripts/macos-tools.lock.json；编译时关闭应用同步不使用的 HTTP、图形界面、Perl/Python、Rust 子系统和 gettext，不链接 Homebrew 库。资源包含 Git、COPYING、源码地址与清单。构建机需要编译工具，用户运行时不需要。
- Mac 包保持当前临时签名方式；离线能力不等于正式签名或公证状态。

## 验证

构建后检查 Windows 安装模式、完整 WebView2 文件摘要、全部 Git/OpenSSH 资源及被调用二进制的 DLL 依赖。检查预处理后的 NSIS 脚本，确保生效路径没有下载 Bootstrapper 或调用在线 Edge 更新器。为兼容本机构建工具的预处理限制，仅在审计副本中替换 Tauri 的本地工具插件调用，保留所有下载命令和安装条件，原安装脚本不变。Windows 最终安装和断网首启仍需 Windows 实机验收。

Mac 主程序静态内置 OpenSSL，避免链接开发机 Homebrew 动态库，并随资源保留许可。检查主程序与 Git 的动态库依赖仅来自系统位置，并验证签名和资源摘要。scripts/test-macos-offline.sh 在进程级禁止网络的沙箱中，用应用内 Git 创建、提交、读取临时仓库；不会改变系统网络设置。原生 App 使用隔离工作区在同类沙箱中验证启动及本地操作，随后恢复用户工作区。

Windows 建议在断网、未装 WebView2/Git/OpenSSH 的测试系统安装，再启动 App 并检查本地主机管理、保险库及附带 Test-Bundled-Tools.ps1。Mac 可在断网环境解压并打开包内 App，无需运行依赖安装命令。

参考：[WebView2 离线部署](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)、[Tauri 离线安装模式](https://v2.tauri.app/distribute/windows-installer/#offline-installer)、[Git 的 Mac 安装依赖](https://git-scm.com/install/mac)。
