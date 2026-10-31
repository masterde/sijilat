#!/usr/bin/env bash
# Installs the Sijilat MCP server and its `sijilat` skill for Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/HEAD/server/mcp/install.sh | bash
#     -> registers the hosted server (https://sijilat-api.vercel.app/mcp) + installs the skill
#
#   ... | bash -s -- --local       run it locally instead: download the self-contained
#                                  stdio bundle (needs Node 20+) and register that
#   ... | bash -s -- --local --desktop   also add the local server to Claude Desktop's config
#   ... | bash -s -- --no-skill    skip the skill      --no-claude   skip `claude mcp add`
#
# Re-run to update. No API keys: the registry uses public auth.
set -euo pipefail

REF=${SIJILAT_MCP_REF:-HEAD}
RAW="https://raw.githubusercontent.com/masterde/sijilat/$REF/server/mcp"
URL=${SIJILAT_MCP_URL:-"$RAW/sijilat-mcp.mjs"}
SKILL_URL=${SIJILAT_SKILL_URL:-"$RAW/skill/sijilat/SKILL.md"}
HOSTED=${SIJILAT_MCP_HOSTED:-https://sijilat-api.vercel.app/mcp}
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/sijilat-mcp"
FILE="$DIR/sijilat-mcp.mjs"
SKILL_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/sijilat"
local_mode=0 desktop=0 claude_code=1 skill=1
for a in "$@"; do case "$a" in
  --local) local_mode=1;; --desktop) desktop=1;; --no-claude) claude_code=0;; --no-skill) skill=0;;
  *) echo "unknown option $a (use --local, --desktop, --no-skill, --no-claude)" >&2; exit 2;;
esac; done
[ $desktop = 0 ] || [ $local_mode = 1 ] || {
  echo "--desktop needs --local. For the hosted server, add a custom connector in Claude Desktop with URL $HOSTED" >&2; exit 2; }

die() { echo "sijilat-mcp: $*" >&2; exit 1; }

if [ $local_mode = 1 ]; then
  NODE=$(command -v node) || die "Node.js 20+ is required for --local (https://nodejs.org)"
  major=$("$NODE" -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || die "Node $major found; 20+ is required"
  mkdir -p "$DIR"
  curl -fsSL "$URL" -o "$FILE.tmp" || die "download failed: $URL"
  head -1 "$FILE.tmp" | grep -q '^#!/usr/bin/env node' || die "unexpected download (not the bundle): $URL"
  mv "$FILE.tmp" "$FILE" && chmod +x "$FILE"
  echo "installed $(sed -n 2p "$FILE" | sed 's#^// ##; s# —.*##') -> $FILE"
fi

if [ $claude_code = 1 ] && command -v claude >/dev/null; then
  claude mcp remove --scope user sijilat >/dev/null 2>&1 || true
  if [ $local_mode = 1 ]; then
    claude mcp add --scope user sijilat -- "$NODE" "$FILE" >/dev/null
    echo "registered the local server with Claude Code (user scope)"
  else
    claude mcp add --scope user --transport http sijilat "$HOSTED" >/dev/null
    echo "registered the hosted server with Claude Code (user scope): $HOSTED"
  fi
elif [ $claude_code = 1 ]; then
  echo "Claude Code not found; register it yourself:"
  [ $local_mode = 1 ] && echo "  stdio server: command \"$NODE\", args [\"$FILE\"]" \
                      || echo "  claude mcp add --transport http sijilat $HOSTED"
fi

if [ $skill = 1 ]; then
  mkdir -p "$SKILL_DIR"
  curl -fsSL "$SKILL_URL" -o "$SKILL_DIR/SKILL.md.tmp" || die "skill download failed: $SKILL_URL"
  head -1 "$SKILL_DIR/SKILL.md.tmp" | grep -q '^---$' || die "unexpected download (not the skill): $SKILL_URL"
  mv "$SKILL_DIR/SKILL.md.tmp" "$SKILL_DIR/SKILL.md"
  echo "installed the sijilat skill -> $SKILL_DIR/SKILL.md"
fi

if [ $desktop = 1 ]; then
  case "$(uname -s)" in
    Darwin) CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json";;
    *) CFG="${XDG_CONFIG_HOME:-$HOME/.config}/Claude/claude_desktop_config.json";;
  esac
  mkdir -p "$(dirname "$CFG")"
  bak=""; if [ -f "$CFG" ]; then cp "$CFG" "$CFG.bak"; bak=" (backup: $CFG.bak)"; fi
  # Absolute node path: Desktop doesn't inherit your shell PATH.
  "$NODE" -e '
    const fs = require("fs"), [cfg, node, file] = process.argv.slice(1);
    const c = fs.existsSync(cfg) ? JSON.parse(fs.readFileSync(cfg, "utf8") || "{}") : {};
    c.mcpServers = { ...(c.mcpServers || {}), sijilat: { command: node, args: [file] } };
    fs.writeFileSync(cfg, JSON.stringify(c, null, 2) + "\n");
  ' "$CFG" "$NODE" "$FILE"
  echo "added to Claude Desktop config$bak — restart Claude Desktop"
fi
