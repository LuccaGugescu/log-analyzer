#!/bin/sh
# Writes realistic log lines into /var/log/mock and rotates them like
# logrotate, so the app's discovery has rotated siblings to skip:
#   app/server.log  (+ server.1.log, server.2.log, server.3.log.gz)
#   nginx/access.log, nginx/error.log (+ access.log.1)
#   worker-YYYY-MM-DD.log (dated files, older days left behind)
#   plus noise the app must ignore: an empty file, a stale file, wtmp
set -eu
root=/var/log/mock
mkdir -p "$root/app" "$root/nginx"
chmod 755 "$root" "$root/app" "$root/nginx"

: > "$root/app/empty.log"
echo "archived long ago" > "$root/app/legacy.log"
touch -d '2020-01-01' "$root/app/legacy.log"
printf 'binary' > "$root/wtmp"
echo "$(date -u -d @$(( $(date +%s) - 86400 )) +%FT%TZ) INFO yesterday's worker run" > "$root/worker-$(date -u -d @$(( $(date +%s) - 86400 )) +%F).log"
touch -d '@'$(( $(date +%s) - 86400 )) "$root"/worker-*.log
echo "old rotation" > "$root/nginx/access.log.1"

pick() { shift $(( $(od -An -N1 -tu1 /dev/urandom) % $# )); echo "$1"; }
now() { date -u +%FT%T.000Z; }

rotate_app() {
  cd "$root/app"
  [ -f server.2.log ] && gzip -cf server.2.log > server.3.log.gz && rm server.2.log
  [ -f server.1.log ] && mv server.1.log server.2.log
  [ -f server.log ] && mv server.log server.1.log
  : > server.log
  echo "$(now) INFO log rotated" >> server.log
  cd - > /dev/null
}

# Start with a few past rotations already on disk.
for n in 1 2 3; do
  echo "$(now) INFO boot $n" >> "$root/app/server.log"
  rotate_app
done

i=0
while true; do
  i=$(( i + 1 ))
  level=$(pick INFO INFO INFO INFO INFO DEBUG WARN WARN ERROR)
  user=$(pick alice bob carol dave erin)
  case $level in
    ERROR) msg=$(pick "payment failed: card declined user=$user" "db query timeout after 5000ms" "upstream auth-service returned 503") ;;
    WARN) msg=$(pick "slow request /api/orders took 1840ms" "retrying job 7731 (attempt 2)" "cache miss rate 41%") ;;
    DEBUG) msg="session refreshed user=$user" ;;
    *) msg=$(pick "user=$user logged in" "order created id=$((1000 + i)) user=$user" "GET /api/products 200 34ms" "health check ok") ;;
  esac
  echo "$(now) $level $msg" >> "$root/app/server.log"

  status=$(pick 200 200 200 200 201 304 404 500)
  path=$(pick / /api/products /api/orders /login /static/app.js)
  echo "10.0.0.$(( i % 250 + 1 )) - - [$(date -u '+%d/%b/%Y:%H:%M:%S +0000')] \"GET $path HTTP/1.1\" $status 512 \"-\" \"Mozilla/5.0\"" >> "$root/nginx/access.log"
  [ "$status" = 500 ] && echo "$(date -u '+%Y/%m/%d %H:%M:%S') [error] 7#7: *$i upstream timed out while reading response header" >> "$root/nginx/error.log"

  [ $(( i % 5 )) -eq 0 ] && echo "$(now) INFO worker processed batch $i in $(( i % 900 + 100 ))ms" >> "$root/worker-$(date -u +%F).log"

  # Rotate every ~3 minutes so rotation handling is visible quickly.
  [ $(( i % 90 )) -eq 0 ] && rotate_app

  chmod -R a+rX "$root" 2>/dev/null || true
  sleep 2
done
