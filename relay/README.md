# Tokvista Relay

Secure publish relay for Tokvista plugin.

## Why this exists
- Plugin sends tokens to this relay.
- Relay validates project/publish key.
- Relay writes to GitHub with server-side credentials.
- Plugin never stores GitHub PAT.

## Run
```bash
npm run relay:start
```

Default port: `8787`

Health:
`GET http://localhost:8787/health`

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
  "referenceUrl": "https://github.com/..."
}
```
