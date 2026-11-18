# BEKIUZ AI Workers

Independent AI worker services for the BEKIUZ AI Manager.

## First service: Developer AI

Cloudflare Worker name: `bekiuz-developer-ai`

Current version: **0.1.0 — read-only foundation**

### What it does now

- Exposes a public health endpoint at `GET /health`.
- Accepts authenticated repository-analysis requests at `POST /api/analyze`.
- Reads GitHub repository metadata and the repository root file list.
- Optionally asks the configured Workers AI model for a limited review of the supplied metadata.
- Never edits code, creates commits, opens pull requests, or deploys.

### Required Worker secrets

Set these in Cloudflare Worker Settings → Variables and Secrets:

- `GITHUB_TOKEN`: GitHub token with read-only access to the repositories the agent is allowed to inspect.
- `MANAGER_SHARED_SECRET`: long random secret shared with the BEKIUZ AI Manager.

Do not put real tokens in this repository, source files, issues, or chat messages.

### Deploy

Install Wrangler, authenticate with Cloudflare, then run:

```bash
npx wrangler deploy
```

The Worker uses the Workers AI binding declared in `wrangler.toml`. If AI is unavailable, the read-only repository inspection still works.

### Health check

```http
GET /health
```

### Analyze a repository

```http
POST /api/analyze
Authorization: Bearer YOUR_MANAGER_SHARED_SECRET
Content-Type: application/json

{
  "repository": "bekiuz/odiy-ai",
  "task": "Review the project structure and identify the next files to inspect."
}
```

### Safety model

This service is read-only by design. Any future code modification, commit, pull request, or deployment capability must be added as a separate operation with explicit owner approval, audit logging, and scoped permissions.
