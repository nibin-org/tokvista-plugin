# Changelog

## Unreleased

- Documented all relay and AI environment variables in `.env.example`.
- Fixed the local relay preview base URL default to the hosted Tokvista preview page.
- Added request rate limiting for publish and AI endpoints plus AI message length validation.
- Hardened preview page version resolution and documented self-hosting/privacy details.
- Added Vitest coverage for token alias parsing, publish change logs, alias resolution, and import logic.
- Hardened Tokvista AI generation with stricter Foundation/Semantic validation, repair gating, and larger Groq output budgets.
- Added AI import history, confirmation-gated reverse import, and safer revert behavior for net-new variables only.
- Improved AI token normalization, semantic collection detection, rate-limit fallback display, and reduced AI tab empty-state clutter.
