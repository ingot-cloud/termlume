const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw result.error || new Error(result.stderr?.trim() || `${command} 执行失败。`);
  }
  return result;
}

try {
  if (process.platform !== 'darwin') throw new Error('macOS 签名构建需要在 Mac 上运行。');
  const { stdout } = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
  const identities = [...stdout.matchAll(/^\s*\d+\)\s+([a-f0-9]{40})\s+"(Developer ID Application: [^"]+)"/gim)];
  const requested = process.env.APPLE_SIGNING_IDENTITY?.trim();
  const matches = requested
    ? identities.filter(([, hash, name]) => hash.toUpperCase() === requested.toUpperCase() || name === requested)
    : identities;
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? '请通过 APPLE_SIGNING_IDENTITY 指定要使用的 Developer ID Application 签名身份。'
      : '钥匙串中找不到匹配的有效 Developer ID Application 证书及私钥。');
  }

  const [, identity, name] = matches[0];
  run('npm', ['run', 'tauri:build', '--', '--bundles', 'app', '--ci', '--', '--locked'], {
    stdio: 'inherit', env: { ...process.env, APPLE_SIGNING_IDENTITY: identity }
  });
  const app = resolve(__dirname, '../src-tauri/target/release/bundle/macos/Termlume.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const signature = run('/usr/bin/codesign', ['-d', '-r-', app]);
  const requirement = signature.stdout + signature.stderr;
  const team = name.match(/\(([A-Z0-9]{10})\)$/)?.[1];
  if (!team || !requirement.includes('identifier "app.termlume.desktop"') || !requirement.includes(team)) {
    throw new Error('应用签名未匹配 Termlume 的应用标识和签名团队。');
  }
  console.log(`已验证 macOS 发布签名（团队 ${team}）。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
