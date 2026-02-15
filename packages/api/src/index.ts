import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { health } from "./routes/health.js";

const app = new Hono();
app.route("/", health);

const port = Number(process.env.PORT) || 3400;

serve({ fetch: app.fetch, port }, () => {
  console.log(`ossgard-api listening on http://localhost:${port}`);
});
