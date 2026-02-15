import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";
import type { Hono } from "hono";
import type { AppEnv } from "../src/app.js";

describe("repos routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;

  beforeEach(() => {
    db = new Database(":memory:");
    app = createApp(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /repos", () => {
    it("returns empty array when no repos", async () => {
      const res = await app.request("/repos");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns all tracked repos", async () => {
      db.insertRepo("facebook", "react");
      db.insertRepo("vercel", "next.js");

      const res = await app.request("/repos");
      expect(res.status).toBe(200);
      const body = (await res.json()) as any[];
      expect(body).toHaveLength(2);
      expect(body[0].owner).toBe("facebook");
      expect(body[1].owner).toBe("vercel");
    });
  });

  describe("POST /repos", () => {
    it("tracks a new repo", async () => {
      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "facebook", name: "react" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.owner).toBe("facebook");
      expect(body.name).toBe("react");
      expect(body.id).toBe(1);
    });

    it("returns 409 on duplicate repo", async () => {
      db.insertRepo("facebook", "react");

      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "facebook", name: "react" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error).toContain("already tracked");
    });

    it("returns 400 on invalid body", async () => {
      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when name is missing", async () => {
      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "facebook" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /repos/:owner/:name", () => {
    it("untracks a repo", async () => {
      db.insertRepo("facebook", "react");

      const res = await app.request("/repos/facebook/react", {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);

      // Verify it's gone
      const repos = db.listRepos();
      expect(repos).toHaveLength(0);
    });

    it("returns 404 when repo not found", async () => {
      const res = await app.request("/repos/nope/nada", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });
  });
});
