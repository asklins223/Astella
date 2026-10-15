#!/bin/bash
# Cubism Native Framework Metal 着色器库生成（阶段 4b）。
#
# 运行时 CubismShader_Metal 从 App bundle 的 FrameworkMetallibs/ 目录加载预编译
# .metallib（MetalShaders.metallib 主库 + 每种 5.3 混合模式组合的
# FragShaderSrcBlend<颜色><Alpha>.metallib 等），缺失时对应 ShaderSet 为 nil。
# 组合矩阵与 SDK CMake（Framework/src/Rendering/Metal/Shaders/CMakeLists.txt 的
# FrameworkShaders 目标）一致：6 个基础片元 × 16 色彩混合 × 5 Alpha 混合，
# 跳过 Normal+Over（由 MetalShaders.metallib 内的基础片元提供）。
#
# 由 Xcode Run Script 阶段调用（依赖检查关闭：增量按输出 mtime 跳过）。
# 输入：SRC / OUT / SDK 环境变量。
set -euo pipefail

if [ -z "${SRC:-}" ] || [ -z "${OUT:-}" ] || [ -z "${SDK:-}" ]; then
  echo "gen-framework-metallibs.sh: SRC/OUT/SDK 环境变量必须由调用方提供" >&2
  exit 1
fi

mkdir -p "$OUT"

# 公共依赖（任一更新都触发重编；空格分隔字符串便于导出到 xargs 子进程）。
COMMON_DEPS="$SRC/MetalShaderTypes.h $SRC/BlendShaderStructs.h $SRC/BlendShaderFuncs.h $SRC/FragShaderSrcColorBlend.metal $SRC/FragShaderSrcAlphaBlend.metal"

# 无宏定义的基础库：MetalShaders（setup mask/copy/normal 系列）+ 两个顶点库。
compile_plain() {
  local name="$1"
  local out="$OUT/${name}.metallib"
  if [ -f "$out" ]; then
    local newer=0 dep
    for dep in $COMMON_DEPS "$SRC/${name}.metal"; do
      if [ "$dep" -nt "$out" ]; then newer=1; break; fi
    done
    [ "$newer" -eq 0 ] && return 0
  fi
  echo "[metallib] $name"
  xcrun -sdk "$SDK" metal -c "$SRC/${name}.metal" -o "$out.air"
  xcrun -sdk "$SDK" metallib "$out.air" -o "$out"
  rm -f "$out.air"
}

compile_plain MetalShaders
compile_plain VertShaderSrcBlend
compile_plain VertShaderSrcMaskedBlend

# 混合着色器笛卡尔积（每个组合一次 -D 编译；输出名 = 基础名 + Color + Alpha）。
# 组合按运行时 CubismShader_Metal::GenerateShaders 实际查找的矩阵生成：
# 16 种色彩 × 5 种 Alpha（Over/Atop/Out/ConjointOver/DisjointOver）- NormalOver。
# 色彩索引 = 着色器编号（FragShaderSrcColorBlend.metal 的 CSM_COLOR_BLEND_MODE，
# 与 CMake Color_Blend_Mode_* 一致）；Alpha 索引 = Core/着色器一致的编号
# （0 Over / 1 Atop / 2 Out / 3 ConjointOver / 4 DisjointOver）。SDK CMake 的
# alpha 表漏了 Out 且索引偏移，直接照搬会生成运行时查不到（或内容错位）的库。
BLENDS=(
  "FragShaderSrcBlend"
  "FragShaderSrcMaskBlend"
  "FragShaderSrcMaskInvertedBlend"
  "FragShaderSrcPremultipliedAlphaBlend"
  "FragShaderSrcMaskPremultipliedAlphaBlend"
  "FragShaderSrcMaskInvertedPremultipliedAlphaBlend"
)
# 色彩混合：名字:索引（与 csmBlendMode / CMake 的 color_blend_modes 一致）。
COLORS=(
  "Normal:0" "Add:1" "AddGlow:2" "Darken:3" "Multiply:4" "ColorBurn:5"
  "LinearBurn:6" "Lighten:7" "Screen:8" "ColorDodge:9" "Overlay:10"
  "SoftLight:11" "HardLight:12" "LinearLight:13" "Hue:14" "Color:15"
)
ALPHAS=(
  "Over:0" "Atop:1" "Out:2" "ConjointOver:3" "DisjointOver:4"
)

blend_one() {
  local base="$1" color="$2" ci="$3" alpha="$4" ai="$5"
  # Normal+Over 由 MetalShaders.metallib 提供，跳过（与 SDK CMake 一致）。
  if [ "$color" = "Normal" ] && [ "$alpha" = "Over" ]; then return 0; fi
  local out="$OUT/${base}${color}${alpha}.metallib"
  local src="$SRC/${base}.metal"
  if [ -f "$out" ]; then
    local newer=0 dep
    for dep in $COMMON_DEPS "$src"; do
      if [ "$dep" -nt "$out" ]; then newer=1; break; fi
    done
    [ "$newer" -eq 0 ] && return 0
  fi
  xcrun -sdk "$SDK" metal \
    -D "CSM_COLOR_BLEND_MODE=${ci}" -D "CSM_ALPHA_BLEND_MODE=${ai}" \
    -c "$src" -o "$out.air"
  xcrun -sdk "$SDK" metallib "$out.air" -o "$out"
  rm -f "$out.air"
  echo "[metallib] ${base}${color}${alpha}"
}
export -f blend_one
export SRC OUT SDK COMMON_DEPS

# 展开任务列表并行编译（首次构建约 414 个组合；增量构建按 mtime 全部跳过）。
TASKS=$(mktemp)
trap 'rm -f "$TASKS"' EXIT
for base in "${BLENDS[@]}"; do
  for c in "${COLORS[@]}"; do
    cname="${c%%:*}"; ci="${c##*:}"
    for a in "${ALPHAS[@]}"; do
      aname="${a%%:*}"; ai="${a##*:}"
      if [ "$cname" = "Normal" ] && [ "$aname" = "Over" ]; then continue; fi
      echo "$base $cname $ci $aname $ai" >> "$TASKS"
    done
  done
done

xargs -P "${METALLIB_JOBS:-8}" -n 5 bash -c 'blend_one "$@"' _ < "$TASKS"

COUNT=$(find "$OUT" -name '*.metallib' | wc -l | tr -d ' ')
echo "[metallib] FrameworkMetallibs 共 ${COUNT} 个库（期望 477）"
if [ "$COUNT" -lt 477 ]; then
  echo "[metallib] 错误：着色器库数量不足" >&2
  exit 1
fi
