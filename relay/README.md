# Tokvista Relay

Secure publish relay for Tokvista plugin.

## Why this exists
- Plugin sends tokens to this relay.
- Relay validates project/publish key.
- Relay writes to GitHub with server-side credentials.
- Plugin never stores GitHub PAT.
- Can run locally (`relay/server.mjs`) or as Vercel API routes (`/api/*`).

## Run
```bash
npm run relay:start
```

Default port: `8787`

Health:
`GET http://localhost:8787/health`

AI:
`POST http://localhost:8787/ai-guide`

## Vercel mode
This repo includes Vercel functions:
- `api/health`
- `api/publish-tokens`
- `api/index`
- `api/ai-guide`

In plugin settings use:
- Relay URL: `https://<your-app>.vercel.app/api`

## Environment
Relay loads environment from `.env` automatically.

### Quick setup
1. Copy `.env.example` to `.env`
2. Fill your real values
3. Start relay:
   `npm run relay:start`

Required fields in `.env`:

- `TOKVISTA_GITHUB_TOKEN` (optional if per-project `githubToken` provided)
- `TOKVISTA_PROJECTS` (required JSON map)
- `PORT` (optional, default `8787`)
- `DATA_DIR` (optional, default `relay/data`)
- `TOKVISTA_PREVIEW_BASE_URL` (optional, default `https://tokvista-plugin.vercel.app/preview`)
- `TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS` (optional comma-separated allowlist for preview `source=` URLs)
- `GROQ_API_KEY` (required for `/api/ai-guide`)
- `GROQ_MODEL` (optional, default `llama-3.1-8b-instant`)

### `TOKVISTA_PROJECTS` example
```json
{
  "project-alpha": {
    "publishKey": "replace-with-secret",
    "owner": "nibin-org",
    "repo": "tokvista",
    "branch": "main",
    "path": "tokens/tokens.json",
    "paths": {
      "dev": "tokens/dev.tokens.json",
      "prod": "tokens/prod.tokens.json"
    }
  }
}
```

### Local File Mode (No GitHub Required)
```json
{
  "project-alpha": {
    "publishKey": "replace-with-secret",
    "localPath": "../tokvista/tokens.json"
  }
}
```

If `localPath` is set, relay writes exported payload directly to that file.
Note: `localPath` is for local relay only, not Vercel serverless.

## Self-hosting note
The plugin manifest only allows network access to pinned hosts from this build. If you deploy your relay on a different domain, you must update:

- `manifest.json` -> `networkAccess.allowedDomains`
- `src/code.ts` -> `ALLOWED_RELAY_URL_ORIGINS` and `ALLOWED_IMPORT_URL_ORIGINS`

Then rebuild the plugin and re-import it into Figma.

## Publish API
`POST /publish-tokens`

Body:
```json
{
  "projectId": "project-alpha",
  "publishKey": "replace-with-secret",
  "environment": "dev",
  "source": "figma",
  "fileKey": "optional-figma-file-key",
  "payload": {}
}
```

Success:
```json
{
  "versionId": "v20260227123000000",
  "message": "Published successfully.",
  "referenceUrl": "https://github.com/...",
  "rawUrl": "https://raw.githubusercontent.com/owner/repo/commitSha/tokens.json",
  "previewUrl": "https://tokvista-plugin.vercel.app/preview?source=https%3A%2F%2Fraw.githubusercontent.com%2F..."
}
```
