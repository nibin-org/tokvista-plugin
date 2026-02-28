# Tokvista Figma Plugin (Scaffold)

## Quick start
1. Install dependencies:
   `npm install`
2. Build once:
   `npm run build`
3. In Figma Desktop:
   - Open `Plugins` -> `Development` -> `Import plugin from manifest...`
   - Select `manifest.json` from this folder.
4. Run plugin:
   `Plugins` -> `Development` -> `Tokvista`

## Current status
- Import/export pipeline implemented for `color`, numeric, and string/composite token types.
- Creates/updates Figma Variables in collection `Tokvista` by default.
- Supports secure Tokvista relay publish (plugin pushes to your backend; backend handles Git provider writes).

## Supported token shape (v1.0.0)
```json
{
  "$schemaVersion": "1.0.0",
  "$format": "tokvista-plugin-v1",
  "meta": {
    "exportScope": "all-local-collections",
    "collections": ["Foundation", "Semantic"]
  },
  "summary": {
    "exportedCount": 123,
    "exportedAliasCount": 22,
    "skippedCount": 0
  },
  "tokens": {
    "color": {
      "brand": {
        "primary": { "type": "color", "value": "#3b82f6" }
      }
    },
    "spacing": {
      "sm": { "type": "number", "value": 8 }
    }
  }
}
```

Also accepted:
- `type`/`value` keys (Token Studio style) instead of `$type`/`$value`
- `$type`/`$value` keys (legacy/W3C style)
- nested token groups at root level (without wrapping under `tokens`)
- numeric string values for number-like tokens (for example `"8"`, `"8px"`, `"0.5rem"`, `"50%"`)
- alias references (for example `{Foundation.Value.base.blue.50}` or `{Foundation/Value/base/blue/50}`)
- automatic type-conflict replacement on import (existing mismatched variables are recreated)

Export notes:
- Exports local color/number/string variables from all local collections.
- Composite types (`typography`, `boxShadow`, `border`, `composition`) are preserved via JSON values.
- Exports aliases as token references in `{Collection.path.to.token}` format.

## Tokvista Publish (Recommended)
1. Open plugin and fill:
   - `Relay URL` (for example `http://localhost:8787`)
   - `Project ID`
   - `Environment` (`dev`, `stage`, `prod`, etc.)
   - `Publish key`
2. Click `Save Publish Settings`.
3. Click `Publish to Tokvista`.

Notes:
- Publish key is stored via Figma `clientStorage` on your machine.
- Plugin never needs GitHub token when using relay publish.
- Backend relay validates payload and writes to package/repository.
- Relay can run in local file mode (`localPath`) with no GitHub integration.

## Cloud Setup (Vercel)
Use this for multi-user team workflow.

1. Push this plugin repo to GitHub.
2. Import this repo in Vercel and deploy.
3. In Vercel Project Settings -> Environment Variables, set:
   - `TOKVISTA_GITHUB_TOKEN` = GitHub token with repo write access
   - `TOKVISTA_PROJECTS` = JSON string:
```json
{"project-alpha":{"publishKey":"replace-with-strong-secret","owner":"nibin-org","repo":"tokvista","branch":"main","path":"tokens.json"}}
```
4. Redeploy after saving env vars.
5. Check:
   - `https://<your-app>.vercel.app/api/health`
   - `https://<your-app>.vercel.app/api`
6. In Figma plugin publish settings:
   - Relay URL: `https://<your-app>.vercel.app/api`
   - Project ID: `project-alpha`
   - Environment: `dev`
   - Publish key: value from `TOKVISTA_PROJECTS`
7. Update `manifest.json`:
   - Add your Vercel domain in `networkAccess.allowedDomains`
   - Rebuild plugin: `npm run build`
   - Re-import plugin in Figma development plugins

Notes:
- Vercel relay uses GitHub write mode.
- `localPath` mode is not supported in Vercel serverless runtime.

## Run Relay + Tokvista Demo (One Command)
From `tokvista-plugin` folder:

```bash
npm run dev:stack
```

This starts:
- Tokvista relay at `http://localhost:8787`
- Tokvista demo app from `../tokvista/demo` (default Next.js dev port: `3000`)

Stop both with `Ctrl + C`.

Test file: [examples/tokens.sample.json](examples/tokens.sample.json)

## Community publish metadata

Before submitting to Figma Community, prepare:

- Privacy policy page: [docs/privacy-policy.md](docs/privacy-policy.md)
- Support page: [docs/support.md](docs/support.md)
- Listing copy pack: [COMMUNITY_PUBLISH.md](COMMUNITY_PUBLISH.md)

Note:
- Figma requires URL fields for privacy/support. Host these docs on a public URL (for example GitHub Pages or your website) and paste those URLs into the publish form.
