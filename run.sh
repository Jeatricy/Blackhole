#!/usr/bin/env bash
# GARGANTUA 一键启动：起静态服务器、等它真的能连上、再开浏览器。
#
#   ./run.sh                        # http://127.0.0.1:8080
#   ./run.sh -p 9000                # 指定端口
#   ./run.sh -q cinematic -s polar  # 画质档 + 视角预设
#   ./run.sh --lan                  # 暴露到局域网（手机测试）
#   ./run.sh -n                     # 只起服务，不开浏览器
#   ./run.sh -t                     # 起服务并跑完整验收测试
#
# 端口被占用时自动往后找，不会静默失败。Ctrl+C 一并关掉服务器。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8080
HOST=127.0.0.1
OPEN=1
RUNTESTS=0
declare -a QS=()

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)    [ $# -ge 2 ] || die "缺少参数：$1"; PORT="$2"; shift 2 ;;
    -q|--quality) [ $# -ge 2 ] || die "缺少参数：$1"; QS+=("quality=$2"); shift 2 ;;
    -s|--preset)  [ $# -ge 2 ] || die "缺少参数：$1"; QS+=("preset=$2"); shift 2 ;;
    -v|--view)    [ $# -ge 2 ] || die "缺少参数：$1"; QS+=("view=$2"); shift 2 ;;
    --lan)        HOST=0.0.0.0; shift ;;
    -n|--no-open) OPEN=0; shift ;;
    -t|--test)    RUNTESTS=1; OPEN=0; shift ;;
    -h|--help)    usage ;;
    *)            die "未知参数：$1（-h 看用法）" ;;
  esac
done

case "$PORT" in
  ''|*[!0-9]*) die "端口必须是数字：$PORT" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "端口超出范围：$PORT"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "找不到 python3"
[ -f "$ROOT/serve.py" ] || die "serve.py 不在 $ROOT"

# 端口占用就往后找，最多 20 个。python 只用标准库，不额外依赖 ss/lsof。
free_port() {
  "$PY" - "$1" <<'EOF'
import socket, sys
p = int(sys.argv[1])
for cand in range(p, p + 20):
    s = socket.socket()
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", cand))
        print(cand); sys.exit(0)
    except OSError:
        continue
    finally:
        s.close()
sys.exit(1)
EOF
}

NEW="$(free_port "$PORT")" || die "从 $PORT 起连续 20 个端口都被占用"
if [ "$NEW" != "$PORT" ]; then
  printf '\033[33m端口 %s 被占用，改用 %s\033[0m\n' "$PORT" "$NEW"
  PORT="$NEW"
fi

# 拼查询串
URL="http://127.0.0.1:$PORT/"
if [ ${#QS[@]} -gt 0 ]; then
  JOINED=""
  for kv in "${QS[@]}"; do JOINED="${JOINED:+$JOINED&}$kv"; done
  URL="$URL?$JOINED"
fi

SRV_PID=""
TEST_PID=""
# 关键：测试进程必须也在这里收掉。否则 Ctrl+C 时 bash 会等前台子进程返回才跑
# EXIT trap，serve.py 就一直占着端口不放。
cleanup() {
  for pid in "$TEST_PID" "$SRV_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -INT "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

cd "$ROOT" || die "进不去 $ROOT"
"$PY" serve.py "$PORT" "$HOST" &
SRV_PID=$!

# 等到端口真的能握手为止，而不是 sleep 猜一个时间
ready=0
for _ in $(seq 1 60); do
  kill -0 "$SRV_PID" 2>/dev/null || die "服务器启动即退出（端口 $PORT）"
  if "$PY" -c "import socket,sys; s=socket.create_connection(('127.0.0.1',$PORT),0.4); s.close()" 2>/dev/null; then
    ready=1; break
  fi
  sleep 0.25
done
[ "$ready" = 1 ] || die "服务器 15s 内没起来（端口 $PORT）"

if [ "$HOST" = 0.0.0.0 ]; then
  LANIP="$("$PY" -c "import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
try:
    s.connect(('8.8.8.8',80)); print(s.getsockname()[0])
except Exception:
    print('127.0.0.1')
finally:
    s.close()" 2>/dev/null || echo 127.0.0.1)"
  printf '\033[36m局域网：http://%s:%s/\033[0m  (同一 WiFi 的手机可直接开)\n' "$LANIP" "$PORT"
fi

if [ "$RUNTESTS" = 1 ]; then
  printf '\033[36m跑验收测试 13 节（1024×576 下约 60-90 分钟，Ctrl+C 可中断）…\033[0m\n'
  # 放到后台再 wait：这样 Ctrl+C 能立刻走 trap，而不是卡在前台子进程上
  "$PY" tests/run_tests.py --port "$PORT" &
  TEST_PID=$!
  wait "$TEST_PID"; rc=$?
  TEST_PID=""
  exit "$rc"
fi

if [ "$OPEN" = 1 ]; then
  opener=""
  for c in xdg-open gio open wslview; do
    if command -v "$c" >/dev/null 2>&1; then opener="$c"; break; fi
  done
  case "$opener" in
    gio) (gio open "$URL" >/dev/null 2>&1 &) ;;
    "")  printf '\033[33m没找到浏览器启动器，请手动打开：%s\033[0m\n' "$URL" ;;
    *)   ("$opener" "$URL" >/dev/null 2>&1 &) ;;
  esac
fi

printf '\033[32mGARGANTUA\033[0m  %s\n' "$URL"
printf 'Ctrl+C 停止\n'
wait "$SRV_PID"
