const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
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
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

async function github(path, env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN secret is not configured.");
  }

  const response = await fetch(`https://api.github.com/${path}`, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
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

async function analyze(request, env) {
  if (!authorized(request, env)) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, error: "Request body must be valid JSON." }, 400);
  }

  const repository = validRepo(input.repository);
  if (!repository) {
    return json({ ok: false, error: "repository must use owner/repo format." }, 400);
  }

  const task = typeof input.task === "string" ? input.task.trim().slice(0, 2000) : "";
  if (!task) {
    return json({ ok: false, error: "A task description is required." }, 400);
  }

  try {
    const [repo, contents] = await Promise.all([
      github(`repos/${repository}`, env),
      github(`repos/${repository}/contents`, env),
    ]);

    const files = Array.isArray(contents)
      ? contents.slice(0, 80).map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type,
          size: item.size,
        }))
      : [];

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
      root_files: files,
      findings: [
        "Repository metadata and root file listing were retrieved successfully.",
        "This first version performs read-only inspection; it does not edit files, create commits, or deploy.",
        "A deeper code review and test runner will be added in the next iteration.",
      ],
      requires_owner_approval_for_changes: true,
    };

    if (env.AI && env.AI_MODEL) {
      try {
        const prompt = [
          "You are Developer AI for BEKIUZ. Analyze only the supplied repository metadata and root file listing.",
          "Do not claim to have read source files that are not included.",
          "Return concise Uzbek findings: likely project type, useful next inspection targets, and safe next steps.",
          "Do not suggest exposing secrets. Do not make or claim code changes.",
          JSON.stringify({ task, repository: result.repository_info, files }),
        ].join("\n\n");

        const ai = await env.AI.run(env.AI_MODEL, {
          messages: [{ role: "user", content: prompt }],
        });
        result.ai_review = ai?.response || ai?.output_text || null;
      } catch {
        result.ai_review = "AI tahlili hozircha bajarilmadi; repository ma'lumotlari olindi.";
      }
    }

    return json(result);
  } catch (error) {
    const status = error.status === 404 ? 404 : 502;
    return json({ ok: false, error: error.message || "Repository analysis failed." }, status);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), request);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return withCors(json({
        ok: true,
        service: "BEKIUZ Developer AI",
        version: "0.1.0",
        mode: "read-only",
      }), request);
    }

    if (request.method === "POST" && url.pathname === "/api/analyze") {
      return withCors(await analyze(request, env), request);
    }

    return withCors(json({ ok: false, error: "Not found" }, 404), request);
  },
};
