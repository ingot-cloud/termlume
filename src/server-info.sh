# Read-only snapshot, run on a separate SSH exec channel without a PTY.
export LC_ALL=C
section() { printf '\n__TERMLUME_INFO__%s\n' "$1"; }
section version
printf '1\n'
section platform
uname -s 2>/dev/null
section hostname
hostname 2>/dev/null
section kernel
uname -r 2>/dev/null
section architecture
uname -m 2>/dev/null
disk_io_linux() {
  # Whole block devices only; partitions are already included in their parent.
  for disk in /sys/block/*; do
    name=${disk##*/}
    case "$name" in loop*|ram*|zram*|fd*|sr*) continue ;; esac
    [ -r "$disk/stat" ] && [ -r "$disk/dev" ] || continue
    IFS= read -r device < "$disk/dev" || continue
    sequence=-
    if [ -r "$disk/diskseq" ]; then IFS= read -r sequence < "$disk/diskseq"; fi
    # Kernel sector counters always use 512-byte sectors, even on 4K disks.
    awk -v name="$name" -v id="$device:$sequence" 'NF >= 7 { print name, id, $3, $7, $1, $5, (NF >= 10 ? $10 : "-"), $4, (NF >= 8 ? $8 : "-"), (NF >= 11 ? $11 : "-") }' "$disk/stat" 2>/dev/null
  done
}
disk_io_darwin() {
  # Retain only driver identity, byte counters and whole-disk BSD names.
  ioreg -r -c IOBlockStorageDriver -l -w0 2>/dev/null |
    awk '/^\+-o / || /"Statistics" =/ || /"BSD Name" = "disk[0-9]+"/'
}
case "$(uname -s 2>/dev/null)" in
  Linux)
    section os
    if [ -r /etc/os-release ]; then
      sed -n '/^PRETTY_NAME=/p' /etc/os-release
    fi
    section cpuModel
    awk -F ': *' '/^(model name|Hardware|Processor)[[:space:]]*:/ { print $2; exit }' /proc/cpuinfo 2>/dev/null
    section cpuCount
    getconf _NPROCESSORS_ONLN 2>/dev/null || awk '/^processor[[:space:]]*:/ { n++ } END { if(n) print n }' /proc/cpuinfo 2>/dev/null
    section memory
    cat /proc/meminfo 2>/dev/null
    section uptime
    cat /proc/uptime 2>/dev/null
    section load
    cat /proc/loadavg 2>/dev/null
    section networkDefault
    awk '$2 == "00000000" && $8 == "00000000" { print $1 }' /proc/net/route 2>/dev/null
    section diskIoBeforeTime
    cat /proc/uptime 2>/dev/null
    section diskIoBefore
    disk_io_linux
    section networkBeforeTime
    cat /proc/uptime 2>/dev/null
    section networkBefore
    cat /proc/net/dev 2>/dev/null
    section cpuBefore
    sed -n '1p' /proc/stat 2>/dev/null
    sleep 1
    section cpuAfter
    sed -n '1p' /proc/stat 2>/dev/null
    section networkAfterTime
    cat /proc/uptime 2>/dev/null
    section networkAfter
    cat /proc/net/dev 2>/dev/null
    section diskIoAfterTime
    cat /proc/uptime 2>/dev/null
    section diskIoAfter
    disk_io_linux
    ;;
  Darwin)
    section os
    sw_vers -productVersion 2>/dev/null
    section cpuModel
    sysctl -n machdep.cpu.brand_string 2>/dev/null
    section cpuCount
    sysctl -n hw.logicalcpu 2>/dev/null
    section memoryTotal
    sysctl -n hw.memsize 2>/dev/null
    section memoryPages
    vm_stat 2>/dev/null
    section bootTime
    sysctl -n kern.boottime 2>/dev/null
    section epoch
    date +%s
    section load
    sysctl -n vm.loadavg 2>/dev/null
    section networkDefault
    route -n get default 2>/dev/null | awk '$1 == "interface:" { print $2 }'
    section diskIoBeforeTime
    date +%s
    section diskIoBefore
    disk_io_darwin
    section networkBeforeTime
    date +%s
    section networkBefore
    netstat -ibn 2>/dev/null
    sleep 1
    section networkAfterTime
    date +%s
    section networkAfter
    netstat -ibn 2>/dev/null
    section diskIoAfterTime
    date +%s
    section diskIoAfter
    disk_io_darwin
    ;;
esac
section disks
# Local filesystems only: a stalled network mount must not delay the snapshot.
df -lPk -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -lPk 2>/dev/null
section end
printf 'ok\n'
