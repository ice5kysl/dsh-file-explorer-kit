#!/usr/bin/env bash
# 把 dsh-file-explorer 安装进本机个人 dsh 的 web profile（官方 dsh plugin add 路径）。
# 前置：已在插件目录构建（npm run build），dsh 在 PATH。
# 用法（monorepo 布局）：bash plugins/dsh-file-explorer/scripts/install-personal.sh
# 用法（独立仓库布局）：bash scripts/install-personal.sh
set -euo pipefail

# 定位插件目录：从本脚本位置向上找到 name=dsh-file-explorer 的 package.json，
# 因此脚本在 monorepo 或独立仓库里都能运行。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR=""
DIR="$SCRIPT_DIR"
while [[ "$DIR" != "/" ]]; do
  if [[ -f "$DIR/package.json" ]] && grep -q '"dsh-file-explorer"' "$DIR/package.json"; then
    PLUGIN_DIR="$DIR"
    break
  fi
  DIR="$(dirname "$DIR")"
done

if [[ -z "$PLUGIN_DIR" ]]; then
  echo "❌ 找不到 dsh-file-explorer 的 package.json（从 $SCRIPT_DIR 向上查找失败）" >&2
  exit 1
fi

if [[ ! -f "$PLUGIN_DIR/lib/index.js" || ! -f "$PLUGIN_DIR/lib/client.js" ]]; then
  echo "❌ 未找到构建产物，请先在插件目录执行 npm run build" >&2
  exit 1
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "❌ 未找到 dsh，请先安装 @deepseek-ai/dsh" >&2
  exit 1
fi

echo "▶ 安装 dsh-file-explorer 到 web profile（$HOME/.dsh/profiles/web）"
# dsh plugin --profile web add <path> 会把包作为组合包追加到 dsh.profile.bundles
# 并链接到 profile；包内 cordis.patch.yml 随后插入 Loader 行。
dsh plugin --profile web add "$PLUGIN_DIR"

echo
echo "▶ 校验组合树（打印包含 file-explorer 的行）："
dsh --profile web --dump-config | grep -n "file-explorer" || true

echo
echo "✅ 安装完成。"
echo "  现在需要重启 dsh web 才能生效：退出当前 dsh web 进程后重新执行 dsh web，"
echo "  然后刷新浏览器（http://127.0.0.1:3080）。"
echo "  生效后：会话标题栏出现「对话 | 轨迹 | 文件」三个 tab，点「文件」"
echo "  即可在会话内浏览工作区目录并预览文件。"
