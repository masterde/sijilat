#!/usr/bin/env bash
# Installs the Sijilat MCP server (one self-contained file) and registers it.
#
#   curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/HEAD/server/mcp/install.sh | bash
#   ... | bash -s -- --desktop     also add it to Claude Desktop's config
#   ... | bash -s -- --no-claude   only download; register it yourself
#
# Re-run to update. Needs Node 20+. No API keys: the registry uses public auth.
set -euo pipefail

REF=${SIJILAT_MCP_REF:-HEAD}
URL=${SIJILAT_MCP_URL:-"https://raw.githubusercontent.com/masterde/sijilat/$REF/server/mcp/sijilat-mcp.mjs"}
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/sijilat-mcp"
FILE="$DIR/sijilat-mcp.mjs"
desktop=0 claude_code=1
for a in "$@"; do case "$a" in
  --desktop) desktop=1;; --no-claude) claude_code=0;;
  *) echo "unknown option $a (use --desktop, --no-claude)" >&2; exit 2;;
esac; done

die() { echo "sijilat-mcp: $*" >&2; exit 1; }
NODE=$(command -v node) || die "Node.js 20+ is required (https://nodejs.org)"
major=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || die "Node $major found; 20+ is required"

mkdir -p "$DIR"
curl -fsSL "$URL" -o "$FILE.tmp" || die "download failed: $URL"
head -1 "$FILE.tmp" | grep -q '^#!/usr/bin/env node' || die "unexpected download (not the bundle): $URL"
mv "$FILE.tmp" "$FILE" && chmod +x "$FILE"
echo "installed $(sed -n 2p "$FILE" | sed 's#^// ##; s# —.*##') -> $FILE"

if [ $claude_code = 1 ] && command -v claude >/dev/null; then
  claude mcp remove --scope user sijilat >/dev/null 2>&1 || true
  claude mcp add --scope user sijilat -- "$NODE" "$FILE" >/dev/null
  echo "registered with Claude Code (user scope): claude mcp list"
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

cat <<EOF

Other MCP clients: stdio server, command "$NODE", args ["$FILE"]
EOF
