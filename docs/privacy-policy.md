# Tokvista Plugin Privacy Policy

Last updated: 2026-03-07

Tokvista is a Figma plugin that exports/imports design tokens and can publish token payloads to a configured Tokvista relay URL.

## What data is processed

- Local Figma variable/token data selected for export/import.
- Plugin settings entered by the user:
  - Relay URL
  - Project ID
  - Environment
  - Publish key
  - GitHub repository settings (`owner/repo`, branch, path)
  - GitHub Personal Access Token (only when GitHub provider is used)
  - Remember token preference

## What is stored

Tokvista stores plugin settings in Figma `clientStorage` on the user's device/workspace context.

- Relay provider:
  - Relay URL
  - Project ID
  - Environment
  - Publish key (stored for convenience)
- GitHub provider:
  - Repository settings
  - GitHub token only if "Remember token" is enabled
  - If "Remember token" is disabled, token is not persisted in `clientStorage`

## What is sent over network

When you click publish, Tokvista sends the exported token payload and publish settings metadata to the configured relay endpoint (for example, `https://tokvista-plugin.vercel.app/api/publish-tokens`).

That publish request also includes the current Figma `fileKey` when Figma exposes it. Tokvista uses this only as publish metadata for relay-side debugging/audit context.

The hosted Tokvista preview/read endpoints are intended to be reachable from browser-based preview pages, so they may be accessible cross-origin. Write/publish operations remain protected by project-specific relay configuration and publish credentials.

This build only performs network requests to approved hosts listed in plugin manifest:
- `https://tokvista-plugin.vercel.app`
- `https://api.github.com`
- `https://raw.githubusercontent.com`

## Third parties

When Relay provider is used, Git provider operations are handled by your relay/backend.

When GitHub provider is used directly in plugin settings, Tokvista calls GitHub API (`api.github.com`) to read and update the configured token file.

## Data retention

The plugin itself does not maintain a separate remote database. Data retention and logs depend on your relay/backend infrastructure.

## Contact

For privacy questions, contact: `nibin.lab.99@gmail.com`

Support page: `https://github.com/nibin-org/tokvista-plugin/blob/main/docs/support.md`
