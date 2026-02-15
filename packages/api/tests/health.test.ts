import { describe, it, expect } from "vitest";
import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";

describe("GET /health", () => {
  const db = new Database(":memory:");
  const app = createApp(db);

  it("returns status ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});
