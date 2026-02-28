# Tokvista Plugin Privacy Policy

Last updated: 2026-02-28

Tokvista is a Figma plugin that exports/imports design tokens and can publish token payloads to a configured Tokvista relay URL.

## What data is processed

- Local Figma variable/token data selected for export/import.
- Plugin settings entered by the user:
  - Relay URL
  - Project ID
  - Environment
  - Publish key

## What is stored

Tokvista stores plugin settings in Figma `clientStorage` on the user's device/workspace context, including the publish key for convenience.

## What is sent over network

When you click publish, Tokvista sends the exported token payload and publish settings metadata to the configured relay endpoint (for example, `https://tokvista-plugin.vercel.app/api/publish-tokens`).

## Third parties

Tokvista does not directly send data to GitHub from the plugin UI. Git provider operations are handled by your relay/backend, which may use third-party services depending on your setup.

## Data retention

The plugin itself does not maintain a separate remote database. Data retention and logs depend on your relay/backend infrastructure.

## Contact

For privacy questions, contact: `nibin.lab.99@gmail.com`

Support website: `https://nibin-portfolio.vercel.app/`
