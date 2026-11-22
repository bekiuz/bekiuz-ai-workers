const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: JSON_HEADERS });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin",
  };
}

function withCors(response, request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function authorized(request, env) {
  const expected = env.MANAGER_SHARED_SECRET;
  const supplied = request.headers.get("Authorization") || "";
  return Boolean(expected && supplied === `Bearer ${expected}`);
}

function validRepo(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function github(path, token) {
  if (!token) throw new Error("Manager GitHub access token was not provided.");
  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "BEKIUZ-Developer-AI",
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `GitHub API returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function isReviewable(path) {
  return /\.(js|jsx|ts|tsx|json|html|css|scss|md|py|go|rs|java|kt|sql|yml|yaml|toml)$/i.test(path)
    && !/(^|\/)(node_modules|dist|build|\.git|\.next|coverage)(\/|$)/i.test(path)
    && !/(^|\/)(\.env|.*secret.*|.*credential.*)$/i.test(path);
}

async function collectFiles(repository, token) {
  const root = await github(`repos/${repository}/contents`, token);
  const entries = Array.isArray(root) ? root : [];
  const candidates = [];
  const priority = ["README.md", "package.json", "src/index.js", "src/main.ts", "src/App.tsx", "app/page.tsx", "vite.config.ts", "wrangler.toml"];
  for (const p of priority) {
    const found = entries.find((e) => e.path === p && e.type === "file");
    if (found && isReviewable(found.path)) candidates.push(found);
  }
  for (const item of entries) {
    if (item.type === "file" && isReviewable(item.path) && !candidates.some((c) => c.path === item.path)) candidates.push(item);
  }
  for (const folder of entries.filter((e) => e.type === "dir" && ["src", "app", "pages", "api", "server"].includes(e.name))) {
    const sub = await github(`repos/${repository}/contents/${folder.path}`, token).catch(() => []);
    if (Array.isArray(sub)) {
      for (const item of sub) {
        if (item.type === "file" && isReviewable(item.path) && !candidates.some((c) => c.path === item.path)) candidates.push(item);
      }
    }
  }
  const selected = candidates.slice(0, 8);
  const reviewed = [];
  for (const item of selected) {
    if (item.size > 24000) continue;
    try {
      const data = await github(`repos/${repository}/contents/${item.path}`, token);
      if (data.content && data.encoding === "base64") {
        const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes).slice(0, 9000);
        reviewed.push({ path: item.path, content: text });
      }
    } catch {}
  }
  return { root: entries.slice(0, 80).map((item) => ({ name: item.name, path: item.path, type: item.type, size: item.size })), reviewed };
}

async function analyze(request, env) {
  if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: "Request body must be valid JSON." }, 400); }
  const repository = validRepo(input.repository);
  if (!repository) return json({ ok: false, error: "repository must use owner/repo format." }, 400);
  const task = typeof input.task === "string" ? input.task.trim().slice(0, 2000) : "";
  if (!task) return json({ ok: false, error: "A task description is required." }, 400);

  const githubToken = request.headers.get("X-GitHub-Token") || env.GITHUB_TOKEN;
  try {
    const [repo, collected] = await Promise.all([
      github(`repos/${repository}`, githubToken),
      collectFiles(repository, githubToken),
    ]);
    const result = {
      ok: true,
      agent: "Developer AI",
      mode: "read-only",
      repository,
      task,
      repository_info: {
        description: repo.description,
        default_branch: repo.default_branch,
        visibility: repo.visibility,
        language: repo.language,
        updated_at: repo.updated_at,
      },
      root_files: collected.root,
      source_files_reviewed: collected.reviewed.map((f) => f.path),
      requires_owner_approval_for_changes: true,
    };

    if (env.AI && env.AI_MODEL) {
      try {
        const prompt = [
          "You are BEKIUZ Developer AI, a practical senior software engineer.",
          "Respond in Uzbek. Analyze the task and the actual supplied source snippets.",
          "Clearly separate verified findings from hypotheses. Cite file paths for each finding.",
          "Prioritize actionable bugs, security concerns, architecture, and a short implementation plan.",
          "Never claim to inspect files that are not supplied. Do not output secrets or repeat credential-like values.",
          "Do not modify code, commit, or deploy. This endpoint is read-only.",
          "Task:", task,
          "Repository metadata:", JSON.stringify(result.repository_info),
          "File list:", JSON.stringify(collected.root),
          "Source snippets:", JSON.stringify(collected.reviewed),
        ].join("\n\n");
        const ai = await env.AI.run(env.AI_MODEL, {
          messages: [{ role: "user", content: prompt }],
          chat_template_kwargs: { enable_thinking: false },
        });
        const candidates = [ai?.response, ai?.output_text, ai?.choices?.[0]?.message?.content, ai?.result?.response, ai?.result?.choices?.[0]?.message?.content];
        const review = candidates.find((value) => typeof value === "string" && value.trim());
        result.ai_review = review || "AI modeli javob berdi, ammo matn maydoni topilmadi.";
      } catch {
        result.ai_review = "AI tahlili bajarilmadi; repository ma'lumotlari olindi.";
      }
    }
    result.findings = [
      `Repository rootdan ${collected.root.length} element va ${collected.reviewed.length} ta kod/config fayl o'qildi.`,
      "Tahlil faqat tanlangan fayllar bilan cheklangan; to'liq loyiha auditiga barcha fayllar hali kiritilmagan.",
      "Read-only rejim: fayllar o'zgartirilmadi, commit yoki deploy qilinmadi.",
    ];
    return json(result);
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    return json({ ok: false, error: error.message || "Repository analysis failed." }, status);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request);
    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(json({ ok: true, service: "BEKIUZ Developer AI", version: "0.2.0", mode: "read-only-code-review" }), request);
    }
    if (request.method === "POST" && url.pathname === "/api/analyze") return withCors(await analyze(request, env), request);
    return withCors(json({ ok: false, error: "Not found" }, 404), request);
  },
};
