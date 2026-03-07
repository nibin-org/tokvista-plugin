"use strict";

const fs = require("fs");
const path = require("path");
const { getTargetPath, handleOptions, parseProjectsConfig } = require("./_shared");

const TOKVISTA_MARK_DARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" fill="none" aria-label="Tokvista mark dark"><rect x="30" y="30" width="52" height="52" rx="13" stroke="#FFFFFF" stroke-width="5" opacity="0.26"/><rect x="6" y="6" width="52" height="52" rx="13" fill="#FFFFFF"/></svg>`;
const TOKVISTA_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88 88" fill="none" aria-label="Tokvista icon"><rect width="88" height="88" rx="18" fill="#0A0A0A"/><rect x="30" y="30" width="52" height="52" rx="13" stroke="#FFFFFF" stroke-width="5" opacity="0.26"/><rect x="6" y="6" width="52" height="52" rx="13" fill="#FFFFFF"/></svg>`;
const PREVIEW_CSS_OVERRIDES = `
html,
body {
  color-scheme: dark;
}

.ftd-header-actions > :not(.ftd-format-selector):not(.ftd-header-action-btn):not(.ftd-header-search-btn) {
  display: none !important;
}
`;

function decodeBase64ToUtf8(input) {
  const sanitized = String(input || "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (!sanitized) return "";
  try {
    return Buffer.from(sanitized, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function svgToDataUrl(svg) {
  return `data:image/svg+xml,${encodeURIComponent(String(svg || "").trim())}`;
}

function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSemverRangePrefix(value) {
  return String(value || "").trim().replace(/^[^\d]*/, "");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findPackageRootFromEntry(entryPath) {
  let cursor = path.dirname(entryPath);
  while (cursor && cursor !== path.dirname(cursor)) {
    const candidate = path.join(cursor, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    cursor = path.dirname(cursor);
  }
  return "";
}

function readTokvistaVersion() {
  try {
    const entryPath = require.resolve("tokvista");
    const pkgPath = findPackageRootFromEntry(entryPath);
    if (!pkgPath) {
      return "";
    }
    const pkg = readJsonFile(pkgPath);
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "";
  } catch {
    try {
      const pluginPkg = readJsonFile(path.join(__dirname, "..", "package.json"));
      return stripSemverRangePrefix(pluginPkg.dependencies?.tokvista);
    } catch {
      return "";
    }
  }
}

function getAllowedSourceOrigins() {
  const configuredOriginsRaw = typeof process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS === "string"
    ? process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS
    : "";
  const configuredOrigins = configuredOriginsRaw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const out = new Set(["https://raw.githubusercontent.com"]);
  for (const origin of configuredOrigins) {
    out.add(origin);
  }
  return out;
}

function normalizeSourceUrl(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid source URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("source must be an https URL");
  }
  const allowedOrigins = getAllowedSourceOrigins();
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `source origin is not allowed. Allowed origins: ${[...allowedOrigins].sort().join(", ")}`
    );
  }
  return parsed.toString();
}

function normalizeRelayApiUrl(input) {
  const value = String(input || "").trim().replace(/\/+$/, "");
  if (!value) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid relay URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("relay must be an https URL");
  }
  const allowedOrigins = getAllowedSourceOrigins();
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `relay origin is not allowed. Allowed origins: ${[...allowedOrigins].sort().join(", ")}`
    );
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function readGitHubTargetFromQuery(query) {
  const owner = (query.get("owner") || "").trim();
  const repo = (query.get("repo") || "").trim();
  const ref = (query.get("ref") || "").trim();
  const filePath = (query.get("path") || "").trim();
  if (!owner && !repo && !ref && !filePath) {
    return null;
  }
  if (!owner || !repo || !ref || !filePath) {
    throw new Error("owner, repo, ref, and path are required together");
  }
  return {
    owner,
    repo,
    ref,
    filePath
  };
}

function parseRawGitHubSource(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (parsed.origin !== "https://raw.githubusercontent.com") {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4) {
    return null;
  }
  const owner = decodeURIComponent(segments[0]);
  const repo = decodeURIComponent(segments[1]);
  const ref = decodeURIComponent(segments[2]);
  const filePath = segments.slice(3).map((segment) => decodeURIComponent(segment)).join("/");
  if (!owner || !repo || !ref || !filePath) {
    return null;
  }
  return {
    owner,
    repo,
    ref,
    filePath
  };
}

function buildRawGitHubSource({ owner, repo, ref, filePath }) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/${encodeURIComponent(ref)}/${filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

async function parseJsonResponse(response, emptyMessage) {
  if (!response.ok) {
    throw new Error(`Source read failed (${response.status})`);
  }
  const content = await response.text();
  if (!content.trim()) {
    throw new Error(emptyMessage);
  }
  const parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid token data format");
  }
  return parsed;
}

async function fetchTokensFromGitHubTarget(target) {
  const encodedPath = target.filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const contentsApiUrl = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
    target.repo
  )}/contents/${encodedPath}?ref=${encodeURIComponent(target.ref)}`;
  const githubToken = process.env.TOKVISTA_GITHUB_TOKEN;
  const response = await githubRequest(contentsApiUrl, githubToken);
  if (!response.ok) {
    throw new Error(`Source read failed (${response.status})`);
  }
  const payload = await response.json();
  const content =
    typeof payload.content === "string" && payload.encoding === "base64"
      ? decodeBase64ToUtf8(payload.content.replace(/\n/g, ""))
      : "";
  if (!content.trim()) {
    throw new Error("Source response did not include token content");
  }
  const parsed = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid token data format");
  }
  return parsed;
}

async function fetchTokensFromSource(sourceUrl) {
  const parsedRawSource = parseRawGitHubSource(sourceUrl);
  if (parsedRawSource) {
    return fetchTokensFromGitHubTarget(parsedRawSource);
  }
  const response = await fetch(sourceUrl, { method: "GET", headers: { Accept: "application/json" } });
  return parseJsonResponse(response, "Source response did not include token content");
}

async function fetchTokensFromRelay(relayApiUrl, projectId, environment, versionId) {
  const endpoint = versionId
    ? `${relayApiUrl}/version-tokens?projectId=${encodeURIComponent(projectId)}&versionId=${encodeURIComponent(versionId)}`
    : `${relayApiUrl}/live-tokens?projectId=${encodeURIComponent(projectId)}&environment=${encodeURIComponent(
        environment || "dev"
      )}`;
  const response = await fetch(endpoint, { method: "GET", headers: { Accept: "application/json" } });
  return parseJsonResponse(response, "Relay response did not include token content");
}

async function githubRequest(url, token) {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { method: "GET", headers });
}

function getQuery(req) {
  const rawUrl = typeof req.url === "string" ? req.url : "/preview";
  const parsed = new URL(rawUrl, "http://localhost");
  return parsed.searchParams;
}

function buildPreviewSubtitle({ sourceUrl, projectId, environment, version }) {
  const versionSuffix = version ? `Version ${version}` : "Hosted preview";
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.hostname === "raw.githubusercontent.com") {
        return `GitHub source preview · ${versionSuffix}`;
      }
      return `${parsed.hostname} preview · ${versionSuffix}`;
    } catch {
      return `Shared preview · ${versionSuffix}`;
    }
  }
  if (projectId) {
    const environmentLabel = environment ? ` · ${environment}` : "";
    return `${projectId}${environmentLabel} · ${versionSuffix}`;
  }
  return `Shared preview · ${versionSuffix}`;
}

function buildRuntimeConfig({ projectId, environment, sourceUrl, historyApiUrl, version }) {
  return {
    title: "Tokvista",
    subtitle: buildPreviewSubtitle({ sourceUrl, projectId, environment, version }),
    logo: svgToDataUrl(TOKVISTA_MARK_DARK_SVG),
    theme: "dark",
    enableModeToggle: false,
    themeColors: {
      primary: "#d4a84b",
      background: "#141210",
      surface: "#1c1a17",
      border: "#2e2b23",
      text: "#f0ebe3",
      textSecondary: "#9c9487",
    },
    showSearch: true,
    snapshotHistory: {
      enabled: Boolean(historyApiUrl),
      accessMode: "full",
      title: "Snapshot History",
      historyEndpoint: historyApiUrl,
      sourceUrl: sourceUrl || "",
    },
  };
}

function escapeJsonForScript(json) {
  return json.replace(/<\/script/gi, "<\\/script").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function buildHtml(tokensJson, configJson, css, appBundle) {
  const faviconUrl = svgToDataUrl(TOKVISTA_ICON_SVG);
  const safeTokensJson = escapeJsonForScript(tokensJson);
  const safeConfigJson = escapeJsonForScript(configJson);
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tokvista Preview</title>
    <link rel="icon" type="image/svg+xml" href="${faviconUrl}">
    <link rel="shortcut icon" href="${faviconUrl}">
    <link rel="apple-touch-icon" href="${faviconUrl}">
    <style>${css}
${PREVIEW_CSS_OVERRIDES}</style>
  </head>
  <body>
    <div id="tokvista-root"></div>
    <script>window.__TOKVISTA_TOKENS__ = ${safeTokensJson};</script>
    <script>window.__TOKVISTA_CONFIG__ = ${safeConfigJson};</script>
    <script type="module">${appBundle}</script>
  </body>
</html>`;
}

async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    res.status(405).send("Method not allowed");
    return;
  }

  const query = getQuery(req);
  const projectId = (query.get("projectId") || "").trim();
  const environment = (query.get("environment") || "dev").trim() || "dev";
  const versionId = (query.get("versionId") || "").trim();
  const relayRaw = (query.get("relay") || "").trim();
  const sourceRaw = (query.get("source") || "").trim();
  let githubTarget = null;
  try {
    githubTarget = readGitHubTargetFromQuery(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).send(message);
    return;
  }
  let historyApiUrl = "";
  let snapshotSourceUrl = "";

  let tokens;
  if (relayRaw) {
    if (!projectId) {
      res.status(400).send("Missing projectId parameter");
      return;
    }
    let relayApiUrl;
    try {
      relayApiUrl = normalizeRelayApiUrl(relayRaw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).send(message);
      return;
    }
    historyApiUrl = `${relayApiUrl}/version-history?projectId=${encodeURIComponent(projectId)}&environment=${encodeURIComponent(
      environment
    )}`;
    try {
      tokens = await fetchTokensFromRelay(relayApiUrl, projectId, environment, versionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMatch = typeof message === "string" ? message.match(/\((\d{3})\)/) : null;
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;
      res.status(statusCode).send(`Failed to fetch relay tokens: ${message}`);
      return;
    }
  } else if (githubTarget) {
    historyApiUrl =
      `/api/version-history?owner=${encodeURIComponent(githubTarget.owner)}&repo=${encodeURIComponent(
        githubTarget.repo
      )}&ref=${encodeURIComponent(githubTarget.ref)}&path=${encodeURIComponent(githubTarget.filePath)}`;
    try {
      tokens = await fetchTokensFromGitHubTarget(githubTarget);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMatch = typeof message === "string" ? message.match(/\((\d{3})\)/) : null;
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;
      res.status(statusCode).send(`Failed to fetch GitHub tokens: ${message}`);
      return;
    }
  } else if (sourceRaw) {
    let sourceUrl;
    try {
      sourceUrl = normalizeSourceUrl(sourceRaw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).send(message);
      return;
    }
    snapshotSourceUrl = sourceUrl;
    historyApiUrl = `/api/version-history?source=${encodeURIComponent(sourceUrl)}`;
    try {
      tokens = await fetchTokensFromSource(sourceUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusMatch = typeof message === "string" ? message.match(/\((\d{3})\)/) : null;
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;
      res.status(statusCode).send(`Failed to fetch source tokens: ${message}`);
      return;
    }
  } else {
    if (!projectId) {
      res.status(400).send("Missing projectId parameter");
      return;
    }
    historyApiUrl = `/api/version-history?projectId=${encodeURIComponent(projectId)}&environment=${encodeURIComponent(environment)}`;

    const projects = parseProjectsConfig();
    const projectConfig = projects[projectId];
    if (!projectConfig || typeof projectConfig !== "object") {
      res.status(404).send("Unknown projectId");
      return;
    }

    if (typeof projectConfig.localPath === "string" && projectConfig.localPath.trim()) {
      res.status(400).send("localPath mode is not supported on Vercel");
      return;
    }

    const owner = projectConfig.owner;
    const repo = projectConfig.repo;
    const branch = projectConfig.branch || "main";
    const targetPath = getTargetPath(projectConfig, environment);
    const githubToken = process.env.TOKVISTA_GITHUB_TOKEN || projectConfig.githubToken;

    if (!owner || !repo || !targetPath) {
      res.status(500).send("Project target is incomplete");
      return;
    }

    const encodedPath = targetPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

    try {
      const response = await githubRequest(url, githubToken);
      if (!response.ok) {
        res.status(response.status).send(`GitHub read failed (${response.status})`);
        return;
      }
      const payload = await response.json();
      const content =
        typeof payload.content === "string" && payload.encoding === "base64"
          ? decodeBase64ToUtf8(payload.content.replace(/\n/g, ""))
          : "";
      if (!content) {
        res.status(502).send("GitHub response did not include token content");
        return;
      }
      const parsed = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null) {
        res.status(502).send("Invalid token data format");
        return;
      }
      tokens = parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).send(`Failed to fetch tokens: ${message}`);
      return;
    }
  }

  try {
    const cssPath = path.join(process.cwd(), "node_modules", "tokvista", "dist", "styles.css");
    const jsPath = path.join(process.cwd(), "node_modules", "tokvista", "dist", "cli", "browser.js");

    const css = fs.readFileSync(cssPath, "utf8");
    const appBundle = fs.readFileSync(jsPath, "utf8");
    const tokensJson = JSON.stringify(tokens);
    const version = readTokvistaVersion();
    const runtimeConfig = buildRuntimeConfig({
      projectId,
      environment,
      sourceUrl: snapshotSourceUrl,
      historyApiUrl,
      version,
    });
    const configJson = JSON.stringify(runtimeConfig);

    const html = buildHtml(tokensJson, configJson, css, appBundle);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.status(200).send(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).send(`Failed to build preview page: ${message}`);
  }
}

module.exports = handler;
module.exports.__test = {
  buildHtml,
  buildRuntimeConfig,
  escapeJsonForScript,
  getAllowedSourceOrigins,
  normalizeRelayApiUrl,
  normalizeSourceUrl,
  readGitHubTargetFromQuery
};
