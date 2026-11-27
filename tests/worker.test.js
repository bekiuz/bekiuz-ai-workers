import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const secret = "test-manager-secret";

function request(path, options = {}) {
  return new Request(`https://developer-ai.test${path}`, options);
}

test("health endpoint is public and reports read-only mode", async () => {
  const response = await worker.fetch(request("/health"), {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "read-only-code-review");
});

test("CORS only allows explicitly configured origins", async () => {
  const env = { ALLOWED_ORIGINS: "https://manager.example, https://admin.example" };
  const allowed = await worker.fetch(
    request("/health", { headers: { Origin: "https://manager.example" } }),
    env,
  );
  const denied = await worker.fetch(
    request("/health", { headers: { Origin: "https://attacker.example" } }),
    env,
  );

  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://manager.example");
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("untrusted preflight does not receive an allow-origin grant", async () => {
  const response = await worker.fetch(
    request("/api/analyze", {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "POST" },
    }),
    { ALLOWED_ORIGINS: "https://manager.example" },
  );

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("analyze endpoint rejects missing manager authorization", async () => {
  const response = await worker.fetch(
    request("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository: "bekiuz/odiy-ai", task: "Review the app" }),
    }),
    {},
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Unauthorized");
});

test("analyze validates JSON, repository format and task before calling GitHub", async () => {
  const env = { MANAGER_SHARED_SECRET: secret };
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

  const invalidJson = await worker.fetch(
    request("/api/analyze", { method: "POST", headers, body: "{" }),
    env,
  );
  assert.equal(invalidJson.status, 400);

  const invalidRepo = await worker.fetch(
    request("/api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({ repository: "../repo", task: "Review the app" }),
    }),
    env,
  );
  assert.equal(invalidRepo.status, 400);

  const missingTask = await worker.fetch(
    request("/api/analyze", {
      method: "POST",
      headers,
      body: JSON.stringify({ repository: "bekiuz/odiy-ai", task: "   " }),
    }),
    env,
  );
  assert.equal(missingTask.status, 400);
});

test("valid repository analysis remains read-only and does not return the GitHub token", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, authorization: new Headers(init.headers).get("Authorization") });

    if (parsed.pathname === "/repos/bekiuz/odiy-ai") {
      return Response.json({
        description: "ODIY IELTS learning app",
        default_branch: "main",
        visibility: "public",
        language: "TypeScript",
        updated_at: "2026-11-27T00:00:00Z",
      });
    }

    if (parsed.pathname === "/repos/bekiuz/odiy-ai/contents") {
      return Response.json([]);
    }

    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const githubToken = "ghp_test_token_not_for_response";
  const response = await worker.fetch(
    request("/api/analyze", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "X-GitHub-Token": githubToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repository: "bekiuz/odiy-ai", task: "Inspect the project structure" }),
    }),
    { MANAGER_SHARED_SECRET: secret },
  );
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "read-only");
  assert.equal(body.repository, "bekiuz/odiy-ai");
  assert.equal(body.repository_info.default_branch, "main");
  assert.ok(Array.isArray(body.root_files));
  assert.ok(calls.every((call) => call.authorization === `Bearer ${githubToken}`));
  assert.ok(!text.includes(githubToken));
});
