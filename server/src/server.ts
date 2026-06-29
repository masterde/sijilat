// Node server entrypoint. Runs the Hono app on a long-lived HTTP server —
// works locally (`npm run dev` / `npm start`) and on any container/VM host
// (Fly, Render, Railway, Docker). For Vercel, see api/index.ts instead.

import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`sijilat-api listening on http://localhost:${info.port}`);
  if (process.env.SIJILAT_API_KEY) {
    console.log("auth: x-api-key required");
  } else {
    console.log("auth: open (set SIJILAT_API_KEY to require a key)");
  }
});
