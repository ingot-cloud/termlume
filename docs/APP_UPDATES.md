# App 内更新

在「设置 → 关于与更新」查看当前版本，点击「检查更新」。默认启动约 8 秒后检查一次正式版本，可在同页关闭启动检查。发现新版本后，先显示版本说明，再由用户选择下载。下载可取消；签名验证通过后，点击「重启并安装」完成更新。

安装前会检查 SSH 会话、传输、文件编辑器、端口转发和 Git 同步。需要先结束这些工作，应用不会为了安装更新直接中断它们。更新只替换应用文件，沿用 `app.termlume.desktop` 标识及原工作区、凭据和偏好。

发版执行、异常处理和真实升级完成标准见 [发版操作规范](RELEASE_PLAYBOOK.md)。发布任务须包含本机验收，不能仅确认新版本可被发现或下载。

## 更新来源与签名

仅使用 `ingot-cloud/termlume` 的最新正式 GitHub Release，按 macOS arm64 / Windows x64 选择原生安装包。先通过 Release 最新地址的 HTTPS 重定向确定版本，不依赖匿名 GitHub API 的小时配额；旧版本未提供更新清单时仍能正确判断已是最新版。新 Release 已发布、更新附件尚未上传时，显示更新包准备中，可稍后重试。

安装使用官方 `tauri-plugin-updater`。公钥固定在 `src-tauri/tauri.conf.json`，`requireSignedVersion` 开启；文件签名和签名内的版本必须同时匹配，下载或校验失败不会替换 App。macOS 使用签名的 `.app.tar.gz`，Windows 使用现有离线 NSIS `.exe` 和签名文件。普通 ZIP 继续供手动下载。

## 发布前的一次配置

本机私钥保存在 `~/.config/termlume/updater/release.key`，权限 600，目录权限 700；对应 `.pub` 是已内嵌到 App 的公钥。私钥不在仓库或构建产物中。请安全备份私钥；用户安装此公钥的 App 后，后续更新必须使用同一私钥签名。不要直接重新生成或替换公钥。

需要将该私钥保存为 GitHub 仓库 `ingot-cloud/termlume` 的 Actions secret：

- `TAURI_SIGNING_PRIVATE_KEY`：`release.key` 文件完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：仅私钥有密码时设置；当前生成的私钥无密码。

配置 secret 涉及向 GitHub 提供私钥，必须获得仓库所有者授权。不要将私钥粘贴到聊天、提交或日志中。公钥可以公开。

发布流程会在前置检查中签署随机挑战，验证配置的私钥与内嵌公钥匹配；没有正确签名配置时，在耗时构建前明确失败。私钥只传给验证及签名步骤，不传给 `npm ci` 等其他步骤。普通 Native tests 不需要生产签名私钥，仍验证离线安装包。

Windows 的原生测试调用需设置 `TERMLUME_TEST_WINDOWS_MANIFEST=1`，两份 Actions 工作流已在测试步骤中设置。Tauri 的模拟运行时也链接 Common Controls v6；库单元测试不会自动带上应用资源，因此需单独嵌入测试 manifest，避免测试启动时出现 `STATUS_ENTRYPOINT_NOT_FOUND`。随后构建 App 时不设置该变量，继续使用 Tauri 的默认应用 manifest。此处理参考 [Tauri 上游问题](https://github.com/tauri-apps/tauri/issues/11028)，不跳过更新下载或签名测试。

## Actions 产物

原有离线包、审计与校验文件保留，并增加：

- `Termlume-VERSION-macOS-arm64.app.tar.gz` 及 `.sig`。
- `Termlume-VERSION-Windows-x64-setup.exe.sig`，对应原有 NSIS 安装器。
- `latest.json`，包含两平台下载链接、签名、版本、发布日期和说明。

macOS App 先沿用当前临时签名，再生成更新 tar 包，解压复核后签署更新签名；更新签名与 Apple Developer 签名用途不同。Windows 安装器沿用现有离线资源审计，再签署更新签名。发布审计独立验证 Ed25519 文件签名、可信版本注释和同一提交后，先上传所有安装包，最后上传 `latest.json` 与包含它的校验清单，防止客户端看见尚未上传完的更新。

已有 `v0.2.2` 发布包不包含此功能，也不提供 `latest.json`。需要先安装包含本次功能的 App；后续使用新工作流发布的新版本才会提供 App 内更新。现有已发布标签不变。

`v0.2.3` 官方版存在文件编辑器状态误判，会在下载和验签成功后拦截安装；该版本用户需先手动下载安装 `v0.2.4` 或后续修复版。`v0.2.4` 使用真实对话框的 `open` 状态判断，编辑器打开时继续保护未保存的工作。

## 验证

Node 测试覆盖签名内容、版本绑定、换钥、篡改、跨平台清单及发布签名要求。Rust 使用独立临时 App 和一次性测试公钥，实际验证签名下载、拒绝篡改/伪造版本以及 macOS 安装替换与权限；不会安装测试程序到 `/Applications`。测试安装器仅包含文本文件，不启动它。界面回归覆盖深浅主题、窄窗口、长说明滚动、下载进度、取消以及活动工作拦截。最终仍须在本机安装后的原生 App 中检查真实 GitHub 版本。

2026-11-15 已实际完成本机维护客户端到 [v0.2.4](https://github.com/ingot-cloud/termlume/releases/tag/v0.2.4) 的 App 内检查、下载、验签、安装和自动重启，安装文件匹配签名发布包，用户数据保留；升级后再次检查显示已是最新版本。维护客户端标记版本为 v0.2.2，已先装入安装入口修正，不等同于 v0.2.2 官方包。后续每次发版仍须按本次目标版本重新验收，不能只引用这次成功记录。

官方参考：[Tauri Updater](https://v2.tauri.app/plugin/updater/)。
