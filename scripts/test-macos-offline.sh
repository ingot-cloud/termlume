#!/bin/bash
set -euo pipefail
app_path=${1:-/Applications/Termlume.app}
git_binary="$app_path/Contents/Resources/tools/macos/bin/git"
test -x "$git_binary"
fixture=$(mktemp -d /tmp/termlume-offline-git.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
touch "$fixture/empty-config"
run_git() {
  /usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
    /usr/bin/env PATH="$(dirname "$git_binary"):/usr/bin:/bin" \
    GIT_EXEC_PATH="$(dirname "$git_binary")" GIT_CONFIG_GLOBAL="$fixture/empty-config" \
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    GIT_AUTHOR_NAME=Termlume GIT_AUTHOR_EMAIL=offline@termlume.invalid \
    GIT_COMMITTER_NAME=Termlume GIT_COMMITTER_EMAIL=offline@termlume.invalid \
    "$git_binary" "$@"
}
cd "$fixture"
run_git --version
run_git init --bare --quiet --template=
blob=$(printf 'offline payload\n' | run_git hash-object -w --stdin)
tree=$(printf '100644 blob %s\tfixture.txt\n' "$blob" | run_git mktree)
commit=$(printf 'offline commit\n' | run_git commit-tree "$tree")
run_git update-ref refs/heads/offline "$commit"
test "$(run_git show refs/heads/offline:fixture.txt)" = 'offline payload'
echo 'PASS: bundled macOS Git object round trip with network denied'
