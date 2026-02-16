import { createApp } from "../src/app.js";
import { Database } from "../src/db/database.js";
import type { Hono } from "hono";
import type { AppEnv } from "../src/app.js";
import type { Account, AccountConfig } from "@ossgard/shared";

const TEST_API_KEY = "test-api-key-123";
const TEST_CONFIG: AccountConfig = {
  github: { token: "ghp_test" },
  llm: { provider: "ollama", url: "http://localhost:11434", model: "llama3", api_key: "" },
  embedding: { provider: "ollama", url: "http://localhost:11434", model: "nomic-embed-text", api_key: "" },
  vector_store: { url: "http://localhost:6333", api_key: "" },
};
const AUTH_HEADER = { Authorization: `Bearer ${TEST_API_KEY}` };

describe("repos routes", () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let account: Account;

  beforeEach(() => {
    db = new Database(":memory:");
    ({ app } = createApp(db));
    account = db.createAccount(TEST_API_KEY, "test", TEST_CONFIG);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /repos", () => {
    it("returns empty array when no repos", async () => {
      const res = await app.request("/repos", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns all tracked repos", async () => {
      db.insertRepo("facebook", "react");
      db.insertRepo("vercel", "next.js");

      const res = await app.request("/repos", { headers: AUTH_HEADER });
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
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
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
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ owner: "facebook", name: "react" }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error).toContain("already tracked");
    });

    it("returns 400 on invalid body", async () => {
      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ owner: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 when name is missing", async () => {
      const res = await app.request("/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
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
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");

      // Verify it's gone
      const repos = db.listRepos();
      expect(repos).toHaveLength(0);
    });

    it("returns 404 when repo not found", async () => {
      const res = await app.request("/repos/nope/nada", {
        method: "DELETE",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.error).toContain("not found");
    });
  });
});
