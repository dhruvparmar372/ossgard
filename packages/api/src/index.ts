import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT) || 3400;

serve({ fetch: app.fetch, port }, () => {
  console.log(`ossgard-api listening on http://localhost:${port}`);
});
