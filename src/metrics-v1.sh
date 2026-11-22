#!/bin/sh
LC_ALL=C
export LC_ALL
while :; do
  now=$(date +%s) || exit
  cpu=$(awk '/^cpu / { printf "%.0f %.0f", $2+$3+$4+$5+$6+$7+$8+$9, $5+$6; exit }' /proc/stat)
  mem=$(awk '/^MemTotal:/ {total=$2} /^MemAvailable:/ {free=$2} END {print total, free+0}' /proc/meminfo)
  disk=$(df -Pk / | awk 'NR == 2 {print $2, $4}')
  net=$(awk -F: '/:/ {iface=$1; gsub(/[ \t]/,"",iface); if (iface != "lo") { data=$2; sub(/^[ \t]+/,"",data); split(data,a,/[ \t]+/); r+=a[1]; t+=a[9] }} END {printf "%.0f %.0f", r, t}' /proc/net/dev)
  io=$(awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ {r+=$6; w+=$10} END {printf "%.0f %.0f", r*512, w*512}' /proc/diskstats)
  load=$(awk '{print $1}' /proc/loadavg)
  up=$(awk '{print $1}' /proc/uptime)
  printf '%s %s %s %s %s %s %s %s\n' "$now" "$cpu" "$mem" "$disk" "$net" "$io" "$load" "$up" || exit
  sleep 3
done
