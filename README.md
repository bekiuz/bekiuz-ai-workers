# BEKIUZ AI Workers

Independent AI worker services for the BEKIUZ AI Manager.

## First service: Developer AI

Cloudflare Worker: `bekiuz-developer-ai`

Endpoint: `https://bekiuz-developer-ai.bekiuz67.workers.dev`

Current version: **0.1.0 — read-only foundation**

### What it does

- Exposes `GET /health`.
- Accepts authenticated repository-analysis requests at `POST /api/analyze`.
- Reads GitHub repository metadata and the root file list.
- Uses the configured Workers AI model for a limited review.
- Does not edit files, create commits, open pull requests, or deploy.

### Cloudflare Worker secret

Set this secret in the Developer AI Worker:

- `MANAGER_SHARED_SECRET`: must match `DEVELOPER_AI_SHARED_SECRET` on the BEKIUZ AI Manager.

The Manager sends its existing GitHub token to Developer AI per request over HTTPS. The GitHub token is not stored in this Worker. Never commit real secrets or tokens to this repository.

### Deploy

The Worker is configured with `wrangler.toml`. Deploy with:

```bash
npx wrangler deploy
```

### Health check

```http
GET /health
```

### Analyze a repository

The Manager calls this endpoint after owner authentication:

```http
POST /api/analyze
Authorization: Bearer MANAGER_SHARED_SECRET
X-GitHub-Token: GITHUB_TOKEN_FROM_MANAGER
Content-Type: application/json

{
  "repository": "bekiuz/odiy-ai",
  "task": "Review the project structure and identify the next files to inspect."
}
```

### Safety model

This service is read-only. Any future code modification, commit, pull request, or deployment capability must be a separate operation with explicit owner approval, audit logging, and scoped permissions.
