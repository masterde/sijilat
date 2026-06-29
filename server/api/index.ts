// Vercel serverless entrypoint. With server/ set as the Vercel project root,
// the vercel.json rewrite routes every request to this function and Hono does
// the internal routing. Deploy with: `vercel` (from the server/ directory).

import { handle } from "hono/vercel";
import { app } from "../src/app.js";

export const config = { runtime: "nodejs" };

export default handle(app);
