# The probe runs in a separate SSH exec channel. Its own cwd is the login
# directory. Locate the interactive channel served by the same SSH process.
[ -n "$SSH_CONNECTION" ] || exit 1
process_table() {
  if [ -d /proc/self ]; then
    for file in /proc/[0-9]*/stat; do
      IFS= read -r stat 2>/dev/null < "$file" || continue
      pid=${stat%% *}
      name=${stat#*(}
      name=${name%)*}
      # Do not let arbitrary proc names introduce extra rows into the table.
      case "$name" in
        sshd|sshd:*|sshd-session|sshd-session:*|dropbear) name=sshd ;;
        sh|bash|zsh|fish|dash|ksh|mksh|ash|-sh|-bash|-zsh|-fish|-dash|-ksh|-mksh|-ash) name=sh ;;
        *) name=other ;;
      esac
      # Fields after the parenthesized comm: state, ppid, pgrp, sid, tty, tpgid.
      set -- ${stat##*') '}
      printf '%s %s %s %s %s %s\n' "$pid" "$2" "$3" "$6" "$5" "$name"
    done
  else
    LC_ALL=C ps -ax -o pid=,ppid=,pgid=,tpgid=,tty=,comm=
  fi
}
shell_pid=$(process_table | awk -v probe="$$" '
  function handler(pid) {
    while (pid > 1 && pid in parent && parent[pid] != pid) {
      if (name[pid] ~ /^(sshd|sshd-session|dropbear)$/) return pid
      pid = parent[pid]
    }
    return 0
  }
  /^[[:space:]]*[0-9]+[[:space:]]/ {
    pid = $1; parent[pid] = $2; name[pid] = $6
    sub(/^.*\//, "", name[pid]); sub(/:.*/, "", name[pid]); sub(/^-/, "", name[pid])
    if ($5 != "0" && $5 !~ /^\?+$/) tty[pid] = $5
    if ($1 == $3 && $3 == $4) foreground[pid] = 1
  }
  END {
    server = handler(probe)
    if (!server) exit 1
    for (pid in tty) {
      if (handler(pid) != server) continue
      if (terminal && terminal != tty[pid]) exit 1
      terminal = tty[pid]
      if (foreground[pid] && name[pid] ~ /^(sh|bash|dash|ash|zsh|fish|ksh|mksh)$/) {
        if (shell) exit 1
        shell = pid
      }
    }
    if (!shell) exit 1
    print shell
  }
') || exit 1

if [ -d /proc/self ]; then
  # cd -P handles procfs magic links without GNU readlink -z (e.g. BusyBox).
  CDPATH= cd -P "/proc/$shell_pid/cwd" 2>/dev/null || exit 1
  printf '%s\0' "$PWD"
else
  # lsof escapes bytes it cannot display. Verify the path against the vnode
  # before offering it, including when the SSH login has no UTF-8 locale.
  LC_ALL=en_US.UTF-8 lsof -a -p "$shell_pid" -d cwd -FDin0 2>/dev/null |
    perl -0777 -ne '
      /\Ap\d+\0\nfcwd\0D(0x[0-9a-fA-F]+)\0i(\d+)\0n(\/[^\0]*)\0\n\z/ or exit 1;
      my ($dev, $ino, $path) = (hex($1), $2, $3);
      my @st = stat($path);
      exit 1 unless @st && $st[0] == $dev && $st[1] == $ino;
      print $path, "\0";
    '
fi
