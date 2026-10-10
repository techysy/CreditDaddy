#!/usr/bin/env bash
# CreditDaddy 发版前审查脚本
# 用法：./scripts/release-check.sh [版本号]
# 示例：./scripts/release-check.sh 1.2.0

set -euo pipefail

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo -e "${BLUE}  CreditDaddy 发版前审查${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
echo ""

ERRORS=0
WARNINGS=0

# ── 1. 版本号三处一致 ──────────────────────────────────────
echo -e "${YELLOW}[1/15] 🔢 版本号一致性检查${NC}"
PKG=$(node -p "require('./package.json').version")
DESKTOP=$(node -p "require('./desktop/package.json').version")
MANIFEST=$(grep -E '^version[[:space:]]*=' fnos-packaging/manifest | sed -E 's/.*=[[:space:]]*//' | tr -d '\r')

if [ -n "${1:-}" ] && [ "$PKG" != "$1" ]; then
  echo -e "  ${RED}✗ package.json ($PKG) ≠ 期望版本 ($1)${NC}"
  ERRORS=$((ERRORS + 1))
fi

if [ "$PKG" != "$DESKTOP" ]; then
  echo -e "  ${RED}✗ desktop/package.json ($DESKTOP) ≠ package.json ($PKG)${NC}"
  ERRORS=$((ERRORS + 1))
fi

if [ "$PKG" != "$MANIFEST" ]; then
  echo -e "  ${RED}✗ fnos-packaging/manifest ($MANIFEST) ≠ package.json ($PKG)${NC}"
  ERRORS=$((ERRORS + 1))
fi

if [ $ERRORS -eq 0 ]; then
  echo -e "  ${GREEN}✓ 版本号一致：$PKG${NC}"
fi
VERSION="$PKG"
echo ""

# ── 2. 语法检查 ────────────────────────────────────────────
echo -e "${YELLOW}[2/15] 🗂️ JS 语法检查${NC}"
SYNTAX_FAIL=0
for f in bin/*.js src/*.js desktop/main.js desktop/preload.js desktop/preload-container.js desktop/passwordStore.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>&1; then
    echo -e "  ${RED}✗ $f 语法错误${NC}"
    SYNTAX_FAIL=1
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $SYNTAX_FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✓ 所有 JS 文件语法正确${NC}"
fi
echo ""

# ── 3. 单元测试 ────────────────────────────────────────────
echo -e "${YELLOW}[3/15] 🧪 单元测试${NC}"
if npm test > /tmp/test-output.txt 2>&1; then
  PASSED=$(grep -oE 'pass [0-9]+' /tmp/test-output.txt | grep -oE '[0-9]+' | head -1 || echo "0")
  FAILED=$(grep -oE 'fail [0-9]+' /tmp/test-output.txt | grep -oE '[0-9]+' | head -1 || echo "0")
  echo -e "  ${GREEN}✓ 测试通过：$PASSED passed, $FAILED failed${NC}"
else
  echo -e "  ${RED}✗ 测试失败${NC}"
  tail -20 /tmp/test-output.txt
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 4. CHANGELOG 检查 ──────────────────────────────────────
echo -e "${YELLOW}[4/15] 📋 CHANGELOG 包含本版本条目${NC}"
if grep -qE "^## \[${VERSION}\]" CHANGELOG.md; then
  echo -e "  ${GREEN}✓ CHANGELOG.md 已包含 [${VERSION}] 条目${NC}"
  CHANGELOG_HAS_VERSION=1
else
  echo -e "  ${RED}✗ CHANGELOG.md 中没有找到 [${VERSION}] 版本条目${NC}"
  echo -e "     请把 [Unreleased] 内容归档到 [${VERSION}]（附发版日期）"
  ERRORS=$((ERRORS + 1))
  CHANGELOG_HAS_VERSION=0
fi
# 提前探测 tag，供检查 5/6 区分「发版」与「已发布版本复查」两种模式
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  ALREADY_RELEASED=1
else
  ALREADY_RELEASED=0
fi
echo ""

# ── 5. Unreleased 段落检查 ─────────────────────────────────
echo -e "${YELLOW}[5/15] 📋 [Unreleased] 段落无遗留内容${NC}"
CONTENT=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md | grep -v '^[[:space:]]*$' | grep -v '^---' | grep -v '^###' || true)
if [ -n "$CONTENT" ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "  ${BLUE}ℹ [Unreleased] 中有下一版本的内容（已发布版本复查属正常）：${NC}"
    echo "$CONTENT" | grep -E '^-' | sed -E 's/^(- \*\*[^*]+\*\*).*/\1…/' | head -6
  else
    echo -e "  ${YELLOW}⚠ [Unreleased] 段落仍有内容未归档：${NC}"
    echo "$CONTENT" | head -5
    WARNINGS=$((WARNINGS + 1))
  fi
else
  echo -e "  ${GREEN}✓ [Unreleased] 段落为空${NC}"
fi
echo ""

# ── 6. Git tag 状态 ────────────────────────────────────────
echo -e "${YELLOW}[6/15] 🏷️ Tag 状态检查${NC}"
if [ "$ALREADY_RELEASED" = "1" ]; then
  SHORT=$(git rev-parse --short "v${VERSION}")
  if [ "$CHANGELOG_HAS_VERSION" = "1" ]; then
    # CHANGELOG 已归档 + tag 已存在 = 审查已发布版本，属正常复查
    echo -e "  ${BLUE}ℹ v${VERSION} 已发布 ($SHORT)，本次为已发布版本复查${NC}"
  else
    echo -e "  ${RED}✗ Tag v${VERSION} 已存在 ($SHORT)，但 CHANGELOG 未归档该版本${NC}"
    echo -e "     请先 bump 三处版本号再发版"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "  ${GREEN}✓ Tag v${VERSION} 尚未使用，可以发版${NC}"
fi
echo ""

# ── 7. 敏感文件检查 ────────────────────────────────────────
echo -e "${YELLOW}[7/15] 🔒 无敏感文件泄露${NC}"
SENSITIVE=$(git ls-files | grep -iE '(\.env$|\.env\.|\.pem$|\.key$|\.p12$|\.pfx$|secret|credential|\.sqlite$|\.db$)' | grep -v node_modules/ || true)
if [ -n "$SENSITIVE" ]; then
  echo -e "  ${RED}✗ 可能的敏感文件被 git 跟踪：${NC}"
  echo "$SENSITIVE"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓ 未发现敏感文件${NC}"
fi
echo ""

# ── 8. 源码中无遗留调试代码 ────────────────────────────────
echo -e "${YELLOW}[8/15] 🧹 无遗留调试代码${NC}"
DEBUG_HITS=$(grep -rnE '^\s*(debugger|console\.(log|debug|dir|trace))\b' src/ bin/ --include='*.js' \
  | grep -v 'logger\.js' \
  | grep -v '\.test\.js' \
  | grep -v '// keep' \
  | grep -v '// ok' \
  || true)
if [ -n "$DEBUG_HITS" ]; then
  # CLI 入口允许 console.log，但 src/ 不允许
  SRC_HITS=$(echo "$DEBUG_HITS" | grep '^src/' || true)
  if [ -n "$SRC_HITS" ]; then
    echo -e "  ${YELLOW}⚠ src/ 中发现 debugger/console.log（如有意保留请加 // keep 注释）：${NC}"
    echo "$SRC_HITS" | head -5
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "  ${GREEN}✓ src/ 无遗留调试代码（bin/ CLI 输出除外）${NC}"
  fi
else
  echo -e "  ${GREEN}✓ 未发现遗留调试代码${NC}"
fi
echo ""

# ── 9. npm 包内容检查 ──────────────────────────────────────
echo -e "${YELLOW}[9/15] 📦 npm pack 干跑检查${NC}"
PACK_OUTPUT=$(npm pack --dry-run 2>&1 || true)
# panel.html 是 Web 面板本体，必须打进包；其余二进制/大文件类型不该出现在 npm 包里
BIG_FILES=$(echo "$PACK_OUTPUT" | grep -E '\.(png|jpg|svg|ico|fpk|dmg|exe)' | grep -v 'README' || true)
if [ -n "$BIG_FILES" ]; then
  echo -e "  ${YELLOW}⚠ npm 包中包含了二进制/大文件，请检查 package.json 的 files 字段：${NC}"
  echo "$BIG_FILES" | head -5
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✓ npm 包内容干净（无多余二进制文件）${NC}"
fi
echo ""

# ── 10. Desktop 打包文件完整性 ────────────────────────────
echo -e "${YELLOW}[10/15] 🖥️ Desktop 打包文件清单检查${NC}"
DESKTOP_FAIL=0
for f in desktop/main.js desktop/preload.js desktop/preload-container.js desktop/passwordStore.js desktop/package.json desktop/icon.ico desktop/icon.png; do
  if [ ! -f "$f" ]; then
    echo -e "  ${RED}✗ 文件缺失: $f${NC}"
    DESKTOP_FAIL=1
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $DESKTOP_FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✓ Desktop 打包文件齐全${NC}"
fi
echo ""

# ── 11. fnOS manifest 完整性 ──────────────────────────────
echo -e "${YELLOW}[11/15] 📋 fnOS manifest 必填字段检查${NC}"
MANIFEST_FAIL=0
for key in appname version display_name desc platform source maintainer service_port install_dep_apps; do
  if ! grep -qE "^${key}[[:space:]]*=" fnos-packaging/manifest; then
    echo -e "  ${RED}✗ 缺少必填字段: $key${NC}"
    MANIFEST_FAIL=1
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $MANIFEST_FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✓ fnOS manifest 字段完整${NC}"
fi
echo ""

# ── 12. TODO/FIXME/HACK 统计 ──────────────────────────────
echo -e "${YELLOW}[12/15] 📝 TODO/FIXME/HACK 统计${NC}"
TODO_HITS=$( { grep -rnE '\b(TODO|FIXME|HACK|XXX)\b' src/ bin/ desktop/main.js --include='*.js' || true; } )
if [ -n "$TODO_HITS" ]; then
  TODO_COUNT=$(echo "$TODO_HITS" | wc -l)
  echo -e "  ${YELLOW}⚠ 源码中有 ${TODO_COUNT} 处 TODO/FIXME/HACK 标记${NC}"
  echo "$TODO_HITS" | head -5
  WARNINGS=$((WARNINGS + 1))
else
  echo -e "  ${GREEN}✓ 无 TODO/FIXME/HACK 标记${NC}"
fi
echo ""

# ── 13. 运行时关键文件存在性 ──────────────────────────────
echo -e "${YELLOW}[13/15] 🌐 运行时关键文件检查${NC}"
RUNTIME_FAIL=0
for f in src/panel.html src/daemon.js src/store.js bin/creditdaddy.js start-gw.mjs; do
  if [ ! -f "$f" ]; then
    echo -e "  ${RED}✗ 运行时关键文件缺失: $f${NC}"
    RUNTIME_FAIL=1
    ERRORS=$((ERRORS + 1))
  fi
done
if [ $RUNTIME_FAIL -eq 0 ]; then
  echo -e "  ${GREEN}✓ 运行时关键文件齐全（panel.html / daemon / store / CLI / start-gw）${NC}"
fi
echo ""

# ── 14. 产品线覆盖一致性 ──────────────────────────────────
echo -e "${YELLOW}[14/15] 📊 产品线覆盖检查（description 文案是否陈旧）${NC}"
# src/constants.js 的 PROVIDERS 是产品线的唯一事实来源，新增产品线后各文案应同步提及
PROVIDERS=$(node -e "
import('./src/constants.js').then(({ PROVIDERS, productOf }) => {
  console.log([...new Set(PROVIDERS.map(productOf))].join('\n'));
}).catch(() => {});
" 2>/dev/null || true)
if [ -n "$PROVIDERS" ]; then
  # catpaw 在文案里叫「妙手」，单独给别名
  alias_of() { case "$1" in catpaw) echo "妙手";; *) echo "$1";; esac; }
  ROOT_DESC=$(node -p "require('./package.json').description")
  STALE=0
  while IFS= read -r product; do
    [ -n "$product" ] || continue
    ALIAS=$(alias_of "$product")
    if ! echo "$ROOT_DESC" | grep -qiE "$product|$ALIAS"; then
      echo -e "  ${YELLOW}⚠ package.json description 未提及产品线「$product」${NC}"
      STALE=1
    fi
  done <<< "$PROVIDERS"
  if [ $STALE -eq 0 ]; then
    echo -e "  ${GREEN}✓ 所有产品线均已出现在 package.json description${NC}"
  else
    echo -e "     提示：description / manifest desc / README 首段通常一起更新"
    WARNINGS=$((WARNINGS + 1))
  fi
else
  echo -e "  ${BLUE}ℹ 无法解析 src/constants.js，跳过产品线覆盖检查${NC}"
fi
echo ""

# ── 15. i18n 词典覆盖（漏网中文文案） ──────────────────────
echo -e "${YELLOW}[15/15] 🌐 i18n 词典覆盖检查${NC}"
if node scripts/check-i18n.js > /tmp/i18n-check.txt 2>&1; then
  echo -e "  ${GREEN}✓ 面板与运行时中文文案全部被词典覆盖${NC}"
else
  echo -e "  ${RED}✗ 发现词典外的中文用户面字符串（词条缺失或词典 key 集不一致）：${NC}"
  head -10 /tmp/i18n-check.txt
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 附：最近提交统计 ──────────────────────────────────────
COMMIT_COUNT=$(git rev-list --count HEAD ^"v$(git tag -l 'v*' | sort -V | tail -1 | sed 's/^v//')" 2>/dev/null || echo "0")
if [ "$COMMIT_COUNT" -gt 0 ]; then
  echo -e "  ${BLUE}ℹ 自上个版本以来有 ${COMMIT_COUNT} 个提交（最近 5 条）：${NC}"
  git log --oneline -5 || true
  echo ""
fi

# ── 汇总 ──────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
if [ $ERRORS -eq 0 ]; then
  if [ "$ALREADY_RELEASED" = "1" ]; then
    echo -e "${GREEN}  ✅ v${VERSION} 复查通过（该版本已发布）${NC}"
  else
    echo -e "${GREEN}  ✅ 发版前审查通过${NC}"
  fi
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处（非阻塞）${NC}"
  fi
  echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
  echo ""
  if [ "$ALREADY_RELEASED" != "1" ]; then
    echo "下一步："
    echo "  1. 确认 CHANGELOG.md [${VERSION}] 内容准确（[Unreleased] 已归档）"
    echo "  2. git tag v${VERSION}"
    echo "  3. git push origin main --tags"
    echo "  4. 等待 build-fpk / build-desktop-win 自动构建"
    echo "  5. （可选）npm publish"
  fi
  echo ""
  exit 0
else
  echo -e "${RED}  ✗ 发版前审查失败：$ERRORS 个错误${NC}"
  if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}     警告：$WARNINGS 处${NC}"
  fi
  echo -e "${RED}═══════════════════════════════════════════════${NC}"
  echo ""
  echo "请修复上述错误后重新运行审查"
  echo ""
  exit 1
fi
