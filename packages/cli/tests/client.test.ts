import { describe, it, expect } from "vitest";
import { ApiClient, ApiError } from "../src/client.js";

describe("ApiClient", () => {
  it("constructs with default base URL", () => {
    const client = new ApiClient();
    expect(client.baseUrl).toBe("http://localhost:3400");
  });

  it("constructs with custom base URL", () => {
    const client = new ApiClient("http://example.com:8080");
    expect(client.baseUrl).toBe("http://example.com:8080");
  });

  it("strips trailing slashes from base URL", () => {
    const client = new ApiClient("http://localhost:3400///");
    expect(client.baseUrl).toBe("http://localhost:3400");
  });
});

describe("ApiError", () => {
  it("includes status and body in message", () => {
    const err = new ApiError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.body).toBe("Not found");
    expect(err.message).toContain("404");
    expect(err.message).toContain("Not found");
    expect(err.name).toBe("ApiError");
  });
});
