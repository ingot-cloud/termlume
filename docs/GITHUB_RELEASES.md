# GitHub Release 自动打包

工作流 `.github/workflows/release.yml` 在 Actions 中名为 **Release packages**，支持当前已有的 macOS Apple Silicon 和 Windows x64 离线交付。发布 Release 后先运行检查，再在两种原生 Runner 上构建，全部成功后把产物附加到该 Release。

## 发布版本

首次发布包含 App 内更新功能的版本前，先按 [App 内更新](APP_UPDATES.md) 配置仓库的 `TAURI_SIGNING_PRIVATE_KEY` Actions secret。工作流会验证签名密钥与 App 内公钥匹配，再开始两平台构建；私钥不进入仓库或产物。

1. 将工作流与对应版本代码提交、推送到 `main`。
2. 打开 **Releases → Draft a new release**，创建如 `v0.2.0` 的标签，目标选择包含工作流的提交。
3. 填写更新说明并 **Publish release**。预发布可使用 `v0.2.0-beta.1` 并勾选预发布。
4. 在 **Actions → Release packages** 查看进度，完成后回到同一 Release 的 **Assets** 下载。

标签格式为 `vMAJOR.MINOR.PATCH`，可加 `-beta.1` / `-rc.1` 等预发布标识，每段数字不超过 65535。构建时在 Runner 的工作副本中同步 Node、Tauri、Cargo 包与锁文件的版本，不会向仓库回写提交。产物版本、文件名对应标签，构建记录包含原提交 SHA。

仅推送代码、创建标签或保存草稿不会自动打包。`release: published` 同时覆盖正式版与预发布版；工作流须先进入 `main`，标签也必须包含这些构建脚本。构建期间 Release 先显示源码下载，应用产物要等工作流成功后出现。

## 下载产物

以 `v0.2.0` 为例：

| 产物 | 内容 |
| --- | --- |
| `Termlume-0.2.0-macOS-arm64-offline.zip` | `Termlume.app`，内置 Git；解压后放入 Applications |
| `Termlume-0.2.0-Windows-x64-setup.exe` | NSIS 安装包，内置 Git、OpenSSH、完整 WebView2 离线安装器 |
| `Termlume-0.2.0-Windows-x64-offline.zip` | 上述安装器与说明；解压后运行安装器，不是便携版 |
| 两平台的 `.build.json` | 版本、标签、提交、架构、工具链及依赖审计结果 |
| 两平台的 `.sha256` 和 `SHA256SUMS` | 产物及发布文件的 SHA-256 校验列表 |
| macOS `.app.tar.gz`、两平台更新包 `.sig` 和 `latest.json` | App 内签名更新；全部安装包上传成功后才发布更新清单 |

GitHub 自带的 **Source code (zip/tar.gz)** 是源码包，不是可运行应用。

macOS 沿用当前临时签名，没有 Developer ID 正式签名或 Apple 公证；Windows 当前没有 Authenticode 发布签名。具备发布证书后可继续接入正式签名。离线范围与依赖来源见 [离线安装与运行](OFFLINE_DISTRIBUTION.md)。

## 检查与补跑

- 运行 Node 测试、深浅主题和大小窗口界面回归，再使用 `macos-15` arm64 / `windows-2025` x64 构建并运行 Rust 单元测试。使用 `npm ci` 和 Cargo `--locked`。
- Git、OpenSSH、WebView2 按锁文件校验。Windows 通过安装钩子嵌入锁定且校验过的 WebView2 文件，校验最终 NSIS 内嵌文件、工具资源与 DLL 依赖，运行包内 Git/SSH 自检及六种安装钩子场景；macOS 校验签名、系统库依赖、ZIP 解压后的逐文件一致及可执行权限，并在禁止网络的子进程中运行 Git。
- 两平台都成功后统一上传；再次核对产物、摘要、版本与提交，检查远端标签未被移动。各平台包也保留在 Actions Artifacts 中 14 天。
- 使用自动提供的 `GITHUB_TOKEN`，无需个人 Token。测试和构建只有 `contents: read`，上传作业才有 `contents: write`。组织策略需允许所用 GitHub 官方 Actions 与发布作业的写权限。
- 失败后可 **Re-run failed jobs**；也可在 **Actions → Release packages → Run workflow** 填写原 Release 标签。该入口要求 Release 已存在（允许草稿），不会创建或发布新版本。
- 补跑使用 `--clobber` 替换同名产物，保留其他附件。上传不是事务；若中断，查看日志并补跑上传作业。

如果开启 **Immutable releases**，已发布版本不能追加附件。请先创建带已有标签的草稿 Release，手动运行工作流，产物齐全后再发布草稿。预检查会拦截已锁定版本，避免完成构建才发现无法上传；发布草稿后自动触发的运行也只会提示锁定。

缓存只用于加速，锁文件和最终资源摘要仍会重新核对。Actions 用量以仓库所属套餐和组织限制为准。

`Native tests` 会在相关代码推送到 `main` 或提交 PR 时，分别在 Windows 与 macOS 原生环境运行 Rust 单元测试；Windows 还会构建完整离线 NSIS、运行安装钩子场景测试、解包审计并生成离线 ZIP，提前验证实际发布包。应先等待该检查全部通过，再发布新标签。

修复代码后，**Re-run jobs 仍使用旧运行的提交**（[GitHub 补跑规则](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)）；手动填写同一个旧标签也仍构建该标签的源码，不会自动改用最新 `main`。推荐将修复推送后发布下一个补丁版本，例如 `v0.2.2`。如果必须复用失败的旧版本号，需要明确决定是否更新该标签到修复提交；此操作会改变已发布版本的源码指向，工作流不会自动移动标签或绕过提交一致性检查。不可变 Release 的标签不能更新。

## 本地复现

```sh
npm ci
npm test
npm run release:version -- v0.2.0
npm run tauri:build -- --target aarch64-apple-darwin --bundles app --ci -- --locked
codesign --force --sign - src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Termlume.app
npm run release:package -- macos-arm64
```

Windows 使用 `x86_64-pc-windows-msvc`、`--bundles nsis` 和 `windows-x64`，设置 `RUSTFLAGS=-C target-feature=+crt-static`；打包脚本需要 `7z` 和 PowerShell。输出在 `dist/release/`。本地版本命令会修改五个版本文件，请在发布工作副本运行。`RELEASE_BUNDLE_DIR` 可指定已有构建的 bundle 目录。

官方依据：[Release 触发事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)、[Runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、[Tauri GitHub 构建](https://v2.tauri.app/distribute/pipelines/github/)、[不可变 Release](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)。
