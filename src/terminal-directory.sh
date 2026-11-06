# An exec channel has the same OpenSSH connection tuple as the terminal,
# but no TTY. Find the foreground shell belonging to that connection only.
[ -d /proc/self ] && [ -n "$SSH_CONNECTION" ] || exit 1

shell_pid=$(
  for stat_file in /proc/[0-9]*/stat; do
    IFS= read -r stat 2>/dev/null < "$stat_file" || continue
    pid=${stat%% *}
    # Skip the parenthesized process name and read pgrp and tpgid.
    set -- ${stat##*') '}
    [ "$pid" = "$3" ] && [ "$3" = "$6" ] || continue
    IFS= read -r command 2>/dev/null < "/proc/$pid/comm" || continue
    case "$command" in
      (bash|zsh|fish|sh|dash|ksh|ash) ;;
      (*) continue ;;
    esac
    env_file="/proc/$pid/environ"
    grep -zFqx -- "SSH_CONNECTION=$SSH_CONNECTION" "$env_file" 2>/dev/null &&
      grep -zq '^SSH_TTY=/dev/' "$env_file" 2>/dev/null &&
      printf '%s\n' "$pid"
  done
)
case "$shell_pid" in
  ''|*[!0-9]*) exit 1 ;;
esac
readlink -z -- "/proc/$shell_pid/cwd"
