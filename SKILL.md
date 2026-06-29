---
name: pp-sijilat
description: "The first free, scriptable, agent-native CLI for Bahrain's commercial registry — with a local store, ownership-graph traversal, and change-diffing no other tool has. Trigger phrases: `look up a bahrain company`, `search sijilat`, `check this CR number`, `bahrain commercial registration`, `who owns this bahraini company`, `use sijilat`, `run sijilat`."
author: "Baker"
license: "Apache-2.0"
argument-hint: "<command> [args] | install cli|mcp"
allowed-tools: "Read Bash"
metadata:
  openclaw:
    requires:
      bins:
        - sijilat-pp-cli
    install:
      - kind: go
        bins: [sijilat-pp-cli]
        module: github.com/mvanhorn/printing-press-library/library/sales-and-crm/sijilat/cmd/sijilat-pp-cli
---

# Sijilat — Printing Press CLI

## Prerequisites: Install the CLI

This skill drives the `sijilat-pp-cli` binary. **You must verify the CLI is installed before invoking any command from this skill.** If it is missing, install it first:

1. Install via the Printing Press installer. It defaults binaries to `$HOME/.local/bin` on macOS/Linux and `%LOCALAPPDATA%\Programs\PrintingPress\bin` on Windows:
   ```bash
   npx -y @mvanhorn/printing-press-library install sijilat --cli-only
   ```
2. Verify: `sijilat-pp-cli --version`
3. Ensure the reported install directory is on `$PATH` for the agent/runtime that will invoke this skill.

If the `npx` install fails (no Node, offline, etc.), fall back to a direct Go install (requires Go 1.26.4 or newer). This installs into `$GOPATH/bin` (default `$HOME/go/bin`), so add that directory to `$PATH` instead:

```bash
go install github.com/mvanhorn/printing-press-library/library/sales-and-crm/sijilat/cmd/sijilat-pp-cli@latest
```

If `--version` reports "command not found" after install, the runtime cannot see the binary directory on `$PATH`. Do not proceed with skill commands until verification succeeds.

Query all 180,000+ Bahraini commercial registrations by English or Arabic name, CR number, status, sector, activity, partner, nationality, municipality, and more — then sync a local SQLite corpus to do things the portal and paid scrapers cannot: diff a company over time (`diff`), map ownership networks (`graph`), reverse-lookup a person's companies (`controls`), and track renewals (`expiring`). No account or API key required.

## When to Use This CLI

Use Sijilat to verify a Bahraini company, pull its full registration profile, build filtered target lists across the whole registry, or — after syncing — map ownership networks, track changes over time, and run market analytics. It is the right tool for KYC/AML checks, M&A due diligence, compliance/renewal tracking, and B2B market intelligence in Bahrain.

## Anti-triggers

Do not use this CLI for:
- Do not use for company registries outside Bahrain.
- Do not use to register, amend, or file anything — it is read-only public-search.
- Do not treat capital/shareholder data as legal certification; it mirrors the public portal for informational use.

## Unique Capabilities

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

## Command Reference

**cr** — Commercial registrations (companies) in Bahrain's Sijilat registry

- `sijilat-pp-cli cr detail` — Full company profile: capital, shareholders, board, signatories, address, activities, amendment history, branches
- `sijilat-pp-cli cr search` — Search commercial registrations by name (EN/AR), CR number, status, type, sector, activity, partner, nationality


### Finding the right command

When you know what you want to do but not which command does it, ask the CLI directly:

```bash
sijilat-pp-cli which "<capability in your own words>"
```

`which` resolves a natural-language capability query to the best matching command from this CLI's curated feature index. Exit code `0` means at least one match; exit code `2` means no confident match — fall back to `--help` or use a narrower query.

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

## Auth Setup

Sijilat needs no credentials: the CLI mints its own short-lived public token automatically (the same public token the portal's own JavaScript uses), refreshed transparently. Just run commands.

Run `sijilat-pp-cli doctor` to verify setup.

## Agent Mode

Add `--agent` to any command. Expands to: `--json --compact --no-input --no-color --yes`.

- **Pipeable** — JSON on stdout, errors on stderr
- **Filterable** — `--select` keeps a subset of fields. Dotted paths descend into nested structures; arrays traverse element-wise. Critical for keeping context small on verbose APIs:

  ```bash
  sijilat-pp-cli cr search --agent --select id,name,status
  ```
- **Previewable** — `--dry-run` shows the request without sending
- **Non-interactive** — never prompts, every input is a flag
- **Explicit retries** — use `--idempotent` only when an already-existing create should count as success

## Paths and state

Agents should treat the CLI's path resolver as part of the runtime contract:

- Use `--home <dir>` for one invocation, or set `SIJILAT_HOME=<dir>` to relocate all four path kinds under one root.
- Use per-kind env vars only when a specific kind must diverge: `SIJILAT_CONFIG_DIR`, `SIJILAT_DATA_DIR`, `SIJILAT_STATE_DIR`, `SIJILAT_CACHE_DIR`.
- Resolution order is per-kind env var, `--home`, `SIJILAT_HOME`, XDG (`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`), then platform defaults.
- `config` contains settings like `config.toml` and profiles. `data` contains `credentials.toml`, `data.db`, cookies, and auth sidecars. `state` contains persisted queries, jobs, and `teach.log`. `cache` contains regenerable HTTP/cache files.
- Stored secrets live in `credentials.toml` under the data dir. Existing legacy `config.toml` secrets are read for compatibility and leave `config.toml` on the first auth write.
- Run `sijilat-pp-cli doctor --fail-on warn` to surface path and credential-location warnings. `agent-context` exposes a schema v4 `paths` block for agents that need the resolved dirs.
- For MCP, pass relocation through the MCP host config. The MCP binary does not inherit CLI flags:

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

Fleet precedence: an inherited per-kind env var overrides an explicit `--home` for that kind. Use `SIJILAT_HOME` or per-kind vars as durable fleet levers, and use `--home` only for a single invocation. Relocation is not reversible by unsetting env vars; move files manually before clearing `SIJILAT_HOME`, or `doctor` will not find credentials left under the former root.

## Agent Feedback

When you (or the agent) notice something off about this CLI, record it:

```
sijilat-pp-cli feedback "the --since flag is inclusive but docs say exclusive"
sijilat-pp-cli feedback --stdin < notes.txt
sijilat-pp-cli feedback list --json --limit 10
```

Entries are stored locally as `feedback.jsonl` under the resolved data dir. They are never POSTed unless `SIJILAT_FEEDBACK_ENDPOINT` is set AND either `--send` is passed or `SIJILAT_FEEDBACK_AUTO_SEND=true`. Default behavior is local-only.

Write what *surprised* you, not a bug report. Short, specific, one line: that is the part that compounds.

## Output Delivery

Every command accepts `--deliver <sink>`. The output goes to the named sink in addition to (or instead of) stdout, so agents can route command results without hand-piping. Three sinks are supported:

| Sink | Effect |
|------|--------|
| `stdout` | Default; write to stdout only |
| `file:<path>` | Atomically write output to `<path>` (tmp + rename) |
| `webhook:<url>` | POST the output body to the URL (`application/json` or `application/x-ndjson` when `--compact`) |

Unknown schemes are refused with a structured error naming the supported set. Webhook failures return non-zero and log the URL + HTTP status on stderr.

## Named Profiles

A profile is a saved set of flag values, reused across invocations. Use it when a scheduled agent calls the same command every run with the same configuration - HeyGen's "Beacon" pattern.

```
sijilat-pp-cli profile save briefing --json
sijilat-pp-cli --profile briefing cr search
sijilat-pp-cli profile list --json
sijilat-pp-cli profile show briefing
sijilat-pp-cli profile delete briefing --yes
```

Explicit flags always win over profile values; profile values win over defaults. `agent-context` lists all available profiles under `available_profiles` so introspecting agents discover them at runtime.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Usage error (wrong arguments) |
| 3 | Resource not found |
| 5 | API error (upstream issue) |
| 7 | Rate limited (wait and retry) |
| 10 | Config error |

## Argument Parsing

Parse `$ARGUMENTS`:

1. **Empty, `help`, or `--help`** → show `sijilat-pp-cli --help` output
2. **Starts with `install`** → ends with `mcp` → MCP installation; otherwise → see Prerequisites above
3. **Anything else** → Direct Use (execute as CLI command with `--agent`)

## MCP Server Installation

1. Install the MCP server:
   ```bash
   go install github.com/mvanhorn/printing-press-library/library/sales-and-crm/sijilat/cmd/sijilat-pp-mcp@latest
   ```
2. Register with Claude Code:
   ```bash
   claude mcp add sijilat-pp-mcp -- sijilat-pp-mcp
   ```
3. Verify: `claude mcp list`

## Direct Use

1. Check if installed: `which sijilat-pp-cli`
   If not found, offer to install (see Prerequisites at the top of this skill).
2. Match the user query to the best command from the Unique Capabilities and Command Reference above.
3. Execute with the `--agent` flag:
   ```bash
   sijilat-pp-cli <command> [subcommand] [args] --agent
   ```
4. If ambiguous, drill into subcommand help: `sijilat-pp-cli <command> --help`.
