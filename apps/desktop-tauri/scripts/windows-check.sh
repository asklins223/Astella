#!/bin/sh
# Windows 交叉 check（macOS 本机）：补齐 cargo-xwin 在 mac 上缺的两件东西后跑 check。
#   - llvm-lib / llvm-rc：Xcode 没有，这里用 ar / 空对象 shim 顶上（只影响本机 check）
#   - target/<triple>/{debug,release}/deps：sherpa 构建脚本假定存在，交叉首跑时 cargo 还没建
# 用法：scripts/windows-check.sh [--features voice-engine] [--release] [其余 cargo 参数]
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${HOME}/.local/bin"
mkdir -p "$BIN"

if [ ! -x "$BIN/llvm-lib" ]; then
  cat > "$BIN/llvm-lib" <<'SH'
#!/bin/sh
out=""
objs=""
for a in "$@"; do
  case "$a" in
    -nologo|/NOLOGO) ;;
    -out:*|/OUT:*) out="${a#-out:}"; out="${out#/OUT:}" ;;
    *) objs="$objs $a" ;;
  esac
done
[ -n "$out" ] || exit 2
exec /usr/bin/ar rcs "$out" $objs
SH
  chmod +x "$BIN/llvm-lib"
fi

if [ ! -x "$BIN/llvm-rc" ]; then
  cat > "$BIN/llvm-rc" <<'SH'
#!/bin/sh
out=""
prev=""
for a in "$@"; do
  case "$prev" in /fo|-fo) out="$a" ;; esac
  prev="$a"
done
[ -n "$out" ] || exit 2
: > "$out"
SH
  chmod +x "$BIN/llvm-rc"
fi

mkdir -p "$ROOT/target/x86_64-pc-windows-msvc/debug/deps" \
         "$ROOT/target/x86_64-pc-windows-msvc/debug/examples" \
         "$ROOT/target/x86_64-pc-windows-msvc/release/deps" \
         "$ROOT/target/x86_64-pc-windows-msvc/release/examples"

cd "$ROOT"
PATH="$BIN:$PATH" exec cargo xwin check --target x86_64-pc-windows-msvc --all-targets "$@"