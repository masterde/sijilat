# Sijilat CLI

**The first free, scriptable, agent-native CLI for Bahrain's commercial registry — with a local store, ownership-graph traversal, and change-diffing no other tool has.**

Query all 180,000+ Bahraini commercial registrations by English or Arabic name, CR number, status, sector, activity, partner, nationality, municipality, and more — then sync a local SQLite corpus to do things the portal and paid scrapers cannot: diff a company over time (`diff`), map ownership networks (`graph`), reverse-lookup a person's companies (`controls`), and track renewals (`expiring`). No account or API key required.

## Install

The recommended path installs both the `sijilat-pp-cli` binary and the `pp-sijilat` agent skill (Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, and other agents supported by the upstream [`skills`](https://github.com/vercel-labs/skills) CLI) in one shot:

```bash
npx -y @mvanhorn/printing-press-library install sijilat
```

For CLI only (no skill):

```bash
npx -y @mvanhorn/printing-press-library install sijilat --cli-only
```

For skill only — installs the skill into the same agents as the default command above, but skips the CLI binary (use this to update or reinstall just the skill):

```bash
npx -y @mvanhorn/printing-press-library install sijilat --skill-only
```

To constrain the skill install to one or more specific agents (repeatable — agent names match the [`skills`](https://github.com/vercel-labs/skills) CLI):

```bash
npx -y @mvanhorn/printing-press-library install sijilat --agent claude-code
npx -y @mvanhorn/printing-press-library install sijilat --agent claude-code --agent codex
```

### Without Node (Go fallback)

If `npx` isn't available (no Node, offline), install the CLI directly via Go (requires Go 1.26.4 or newer):

```bash
go install github.com/mvanhorn/printing-press-library/library/sales-and-crm/sijilat/cmd/sijilat-pp-cli@latest
```

This installs the CLI only — no skill.

### Pre-built binary

Download a pre-built binary for your platform from the [latest release](https://github.com/mvanhorn/printing-press-library/releases/tag/sijilat-current). On macOS, clear the Gatekeeper quarantine: `xattr -d com.apple.quarantine <binary>`. On Unix, mark it executable: `chmod +x <binary>`.

<!-- pp-hermes-install-anchor -->
## Install for Hermes

Install the CLI binary first. The installer writes binaries to a per-user managed bin directory by default: `$HOME/.local/bin` on macOS/Linux and `%LOCALAPPDATA%\Programs\PrintingPress\bin` on Windows.

```bash
npx -y @mvanhorn/printing-press-library install sijilat --cli-only
```

Then install the focused Hermes skill.

From the Hermes CLI:

```bash
hermes skills install mvanhorn/printing-press-library/cli-skills/pp-sijilat --force
```

Inside a Hermes chat session:

```bash
/skills install mvanhorn/printing-press-library/cli-skills/pp-sijilat --force
```

Restart the Hermes session or gateway if the newly installed skill is not visible immediately.

## Install for OpenClaw
Install both the CLI binary and the focused OpenClaw skill. The installer defaults binaries to a per-user bin directory (`$HOME/.local/bin` on macOS/Linux, `%LOCALAPPDATA%\Programs\PrintingPress\bin` on Windows):

```bash
npx -y @mvanhorn/printing-press-library install sijilat --agent openclaw
```

Restart the OpenClaw session or gateway if the newly installed skill is not visible immediately.

## Use with Claude Desktop

This CLI ships an [MCPB](https://github.com/modelcontextprotocol/mcpb) bundle — Claude Desktop's standard format for one-click MCP extension installs (no JSON config required).

To install:

1. Download the `.mcpb` for your platform from the [latest release](https://github.com/mvanhorn/printing-press-library/releases/tag/sijilat-current).
2. Double-click the `.mcpb` file. Claude Desktop opens and walks you through the install.

Requires Claude Desktop 1.0.0 or later. Pre-built bundles ship for macOS Apple Silicon (`darwin-arm64`) and Windows (`amd64`, `arm64`); for other platforms, use the manual config below.

<details>
<summary>Manual JSON config (advanced)</summary>

If you can't use the MCPB bundle (older Claude Desktop, unsupported platform), install the MCP binary and configure it manually.


```bash
go install github.com/mvanhorn/printing-press-library/library/sales-and-crm/sijilat/cmd/sijilat-pp-mcp@latest
```

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sijilat": {
      "command": "sijilat-pp-mcp"
    }
  }
}
```

</details>

## Authentication

Sijilat needs no credentials: the CLI mints its own short-lived public token automatically (the same public token the portal's own JavaScript uses), refreshed transparently. Just run commands.

## Quick Start

```bash
# Confirm the CLI builds its request and can reach the registry — no key needed.
sijilat doctor --dry-run

# Find companies by English name; the core lookup.
sijilat search --name-en trading --limit 10

# Pull a full profile: capital, shareholders, board, address, activities.
sijilat company 21 --branch 10

# Build a local corpus to unlock graph/stats/diff.
sijilat sync --status ACTIVE --sector IT

```

## Unique Features

These capabilities aren't available in any other tool for this API.

### Local state that compounds
- **`diff`** — Detect exactly what changed on a company (shareholders, signatories, capital, status, address) since you last checked.

  _Reach for this for KYC re-screening or monitoring — it answers 'what changed?', which no single registry call can._

  ```bash
  sijilat diff 21 --json
  ```
- **`feed`** — One agent-pollable stream of every change across all watched companies since the last sync.

  _Poll this on a schedule to drive alerts; exit code signals whether anything changed._

  ```bash
  sijilat feed --since last-sync --json
  ```
- **`expiring`** — List watched companies whose CR expires within a window, flagging any that quietly went EXPIRED or CANCELLED.

  _Use for renewal compliance across a portfolio of registrations._

  ```bash
  sijilat expiring --within 60d --json
  ```

### Ownership intelligence
- **`graph`** — Traverse the partner -> company -> partner network around a CR to surface direct and indirect links.

  _Use for due-diligence and beneficial-ownership mapping where indirect connections matter._

  ```bash
  sijilat graph 21 --depth 2 --json
  ```
- **`controls`** — List every company a person is a partner, signatory, or director of, with their role and share count.

  _Use to profile an individual's full corporate footprint across the registry._

  ```bash
  sijilat controls "AHMED ALI" --json
  ```

### Registry analytics
- **`stats`** — Aggregate the synced corpus by status, company type, nationality, sector, or registration year.

  _Use for market sizing and territory analysis the portal cannot produce._

  ```bash
  sijilat stats --by status,type --json
  ```

## Recipes

### Verify a counterparty

```bash
sijilat search --name-en "acme" --status ACTIVE --json --select cr_number,name_en,status,expires_on
```

Narrow a deeply nested registry response to just the fields KYC needs.

### Full ownership profile

```bash
sijilat company 21 --branch 10 --json
```

Capital structure, shareholders, board, signatories, and address in one call.

### Map an ownership network

```bash
sijilat graph 21 --depth 2 --json
```

After syncing, traverse shared shareholders to find linked entities.

### Track renewals

```bash
sijilat expiring --within 90d --json
```

Flag watched companies approaching expiry or already lapsed.

## Usage

Run `sijilat-pp-cli --help` for the full command reference and flag list.

## Paths & environment variables

This CLI separates local files into four path kinds:

| Kind | Contents |
|------|----------|
| `config` | User-editable settings such as `config.toml` and saved profiles |
| `data` | Durable local data such as `data.db` |
| `state` | Runtime state such as persisted queries, jobs, and `teach.log` |
| `cache` | Regenerable HTTP/cache files |

Each kind resolves independently. The ladder is:

1. Per-kind env var: `SIJILAT_CONFIG_DIR`, `SIJILAT_DATA_DIR`, `SIJILAT_STATE_DIR`, or `SIJILAT_CACHE_DIR`
2. `--home <dir>` for this invocation
3. `SIJILAT_HOME` for a flat relocated root
4. XDG env vars: `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`
5. Platform defaults matching existing installs

For containers and agent sandboxes, prefer a single relocated root:

```bash
export SIJILAT_HOME=/srv/sijilat
sijilat-pp-cli doctor
```

Under `SIJILAT_HOME=/srv/sijilat`, the four dirs resolve to `/srv/sijilat/config`, `/srv/sijilat/data`, `/srv/sijilat/state`, and `/srv/sijilat/cache`.

MCP servers do not receive CLI flags from the host. Put relocation in the host `env` block:

```json
{
  "mcpServers": {
    "sijilat": {
      "command": "sijilat-pp-mcp",
      "env": {
        "SIJILAT_HOME": "/srv/sijilat"
      }
    }
  }
}
```

Precedence matters in fleets: an ambient per-kind variable such as `SIJILAT_DATA_DIR` overrides an explicit `--home` for that kind. Use `SIJILAT_HOME` or the per-kind variables for durable fleet relocation; treat `--home` as the weaker per-invocation lever.

Relocation is one-way. Unsetting `SIJILAT_HOME` does not move files back to platform defaults, and `doctor` cannot find files left under a former root. Move the files manually before unsetting relocation variables.

Existing installs keep working because the platform-default rung matches the legacy layout. Run `sijilat-pp-cli doctor --fail-on warn` to check path warnings in automation.

## Commands

### cr

Commercial registrations (companies) in Bahrain's Sijilat registry

- **`sijilat-pp-cli cr detail`** - Full company profile: capital, shareholders, board, signatories, address, activities, amendment history, branches
- **`sijilat-pp-cli cr search`** - Search commercial registrations by name (EN/AR), CR number, status, type, sector, activity, partner, nationality, municipality, address, or registration date


## Output Formats

```bash
# Human-readable table (default in terminal, JSON when piped)
sijilat-pp-cli cr search

# JSON for scripting and agents
sijilat-pp-cli cr search --json

# Filter to specific fields
sijilat-pp-cli cr search --json --select id,name,status

# Dry run — show the request without sending
sijilat-pp-cli cr search --dry-run

# Agent mode — JSON + compact + no prompts in one flag
sijilat-pp-cli cr search --agent
```

## Agent Usage

This CLI is designed for AI agent consumption:

- **Non-interactive** - never prompts, every input is a flag
- **Pipeable** - `--json` output to stdout, errors to stderr
- **Filterable** - `--select id,name` returns only fields you need
- **Previewable** - `--dry-run` shows the request without sending
- **Explicit retries** - add `--idempotent` to create retries when a no-op success is acceptable
- **Confirmable** - `--yes` for explicit confirmation of destructive actions
- **Piped input** - write commands can accept structured input when their help lists `--stdin`
- **Agent-safe by default** - no colors or formatting unless `--human-friendly` is set

Exit codes: `0` success, `2` usage error, `3` not found, `5` API error, `7` rate limited, `10` config error.

## Health Check

```bash
sijilat-pp-cli doctor
```

Verifies configuration and connectivity to the API.

## Configuration

Run `sijilat-pp-cli doctor` to see the resolved config, data, state, and cache directories. The platform-default config path is `~/.config/sijilat/config.toml`; `--home`, `SIJILAT_HOME`, and per-kind env vars can relocate it.

Static request headers can be configured under `headers`; per-command header overrides take precedence.

## Troubleshooting
**Not found errors (exit code 3)**
- Check the resource ID is correct
- Run the `list` command to see available items

### API-specific
- **Empty results for an Arabic name** — Pass the Arabic string to --name-ar (not --name-en); partial matches need >=2 characters.
- **diff/graph/controls return nothing** — Run 'sijilat sync ...' first — those commands read the local store, not the live API.
- **Detail call returns an error** — Use both the CR number and its branch number (head office is branch 1); run 'sijilat company <cr>' to list branches.
