#!/usr/bin/env bash
# Installs the Sijilat MCP server and its `sijilat` skill for Claude Code.
#
#   curl -fsSL https://raw.githubusercontent.com/masterde/sijilat/mcp-v0.1.0/server/mcp/install.sh | bash
#     -> registers the hosted server (https://sijilat-api.vercel.app/mcp) + installs the skill.
#        The hosted server needs an API key: set SIJILAT_API_KEY in the environment
#        first, or you'll be prompted for it (input hidden). Don't pass it to this
#        script as an argument. Note: `claude mcp add --header` has no stdin form, so
#        the key is in that one command's argv while it runs (visible to local `ps`)
#        and is then stored in plaintext in ~/.claude.json, as with any MCP header.
#
#   ... | bash -s -- --local       run it locally instead: download the self-contained
#                                  stdio bundle (needs Node 20+) and register that
#   ... | bash -s -- --local --desktop   also add the local server to Claude Desktop's config
#   ... | bash -s -- --no-skill    skip the skill      --no-claude   skip `claude mcp add`
#
# Re-run to update. The --local server talks to the registry directly and needs no key.
#
# Integrity: downloads come from a release TAG, not the branch tip, and are checked
# against the SHA-256 hashes embedded below. Tags can be moved by anyone with push
# access, so the embedded hashes are the real protection. Release step: run
# scripts/bundle-mcp.mjs, tag the commit, and paste the printed hashes here.
set -euo pipefail

PINNED_REF=mcp-v0.1.0
PINNED_BUNDLE_SHA256=e3d836a8baad2cf1882eb5b6a5af6aa483d93461464ab9563dd20e91303407cd
PINNED_SKILL_SHA256=8fb89bf563c81773931b8339d57b11b51ed048e14a00cd723356eea1568bf842

REF=${SIJILAT_MCP_REF:-$PINNED_REF}
if [ "$REF" = "$PINNED_REF" ]; then
  BUNDLE_SHA256=${SIJILAT_MCP_SHA256:-$PINNED_BUNDLE_SHA256}
  SKILL_SHA256=${SIJILAT_SKILL_SHA256:-$PINNED_SKILL_SHA256}
else
  # Any other ref (or a custom URL) must come with its own hashes.
  BUNDLE_SHA256=${SIJILAT_MCP_SHA256:-}
  SKILL_SHA256=${SIJILAT_SKILL_SHA256:-}
fi
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

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
verify() { # verify <file> <expected-sha256> <what> <env var that supplies the hash>
  [ -n "$2" ] || die "no SHA-256 for $3 (ref $REF is not the pinned $PINNED_REF): set ${4}"
  got=$(sha256 "$1")
  [ "$got" = "$2" ] || { rm -f "$1"; die "$3 failed its SHA-256 check (expected $2, got $got); not installed"; }
}

if [ $local_mode = 1 ]; then
  NODE=$(command -v node) || die "Node.js 20+ is required for --local (https://nodejs.org)"
  major=$("$NODE" -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || die "Node $major found; 20+ is required"
  mkdir -p "$DIR"
  curl -fsSL "$URL" -o "$FILE.tmp" || die "download failed: $URL"
  head -1 "$FILE.tmp" | grep -q '^#!/usr/bin/env node' || die "unexpected download (not the bundle): $URL"
  verify "$FILE.tmp" "$BUNDLE_SHA256" "the bundle" SIJILAT_MCP_SHA256
  mv "$FILE.tmp" "$FILE" && chmod +x "$FILE"
  echo "installed $(sed -n 2p "$FILE" | sed 's#^// ##; s# —.*##') -> $FILE"
fi

if [ $claude_code = 1 ] && command -v claude >/dev/null; then
  claude mcp remove --scope user sijilat >/dev/null 2>&1 || true
  if [ $local_mode = 1 ]; then
    claude mcp add --scope user sijilat -- "$NODE" "$FILE" >/dev/null
    echo "registered the local server with Claude Code (user scope)"
  else
    if [ -z "${SIJILAT_API_KEY:-}" ]; then
      [ -r /dev/tty ] || die "the hosted server needs an API key: set SIJILAT_API_KEY and re-run"
      printf 'Sijilat API key (input hidden): ' >/dev/tty
      IFS= read -rs SIJILAT_API_KEY </dev/tty; echo >/dev/tty
      [ -n "$SIJILAT_API_KEY" ] || die "no API key given"
    fi
    claude mcp add --scope user --transport http sijilat "$HOSTED" \
      --header "x-api-key: $SIJILAT_API_KEY" >/dev/null
    echo "registered the hosted server with Claude Code (user scope): $HOSTED"
  fi
elif [ $claude_code = 1 ]; then
  echo "Claude Code not found; register it yourself:"
  [ $local_mode = 1 ] && echo "  stdio server: command \"$NODE\", args [\"$FILE\"]" \
                      || echo "  claude mcp add --transport http sijilat $HOSTED --header \"x-api-key: <your key>\""
fi

if [ $skill = 1 ]; then
  mkdir -p "$SKILL_DIR"
  curl -fsSL "$SKILL_URL" -o "$SKILL_DIR/SKILL.md.tmp" || die "skill download failed: $SKILL_URL"
  head -1 "$SKILL_DIR/SKILL.md.tmp" | grep -q '^---$' || die "unexpected download (not the skill): $SKILL_URL"
  verify "$SKILL_DIR/SKILL.md.tmp" "$SKILL_SHA256" "the skill" SIJILAT_SKILL_SHA256
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
