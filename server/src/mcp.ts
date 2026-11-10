// MCP server (stdio) exposing Sijilat business search + contact lookup to
// agents. Talks to the registry directly through SijilatClient — no dependency
// on the hosted HTTP API. Run: `npm run mcp` (dev) or `node dist/mcp.js`.
// The same tools are served over HTTP at /mcp by the API (src/app.ts).
//
// stdout is the MCP transport: never console.log here; use console.error.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SijilatClient } from "./sijilat.js";
import { createMcpServer } from "./mcp-server.js";

// Single local user: waiting up to a minute for budget beats failing the call.
const server = createMcpServer(new SijilatClient(undefined, { maxWaitMs: 60_000 }));
await server.connect(new StdioServerTransport());
console.error("sijilat MCP server running on stdio");
