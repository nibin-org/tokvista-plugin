"use strict";

const fs = require("fs");
const path = require("path");
const { getTargetPath, handleOptions, parseProjectsConfig } = require("./_shared");

function decodeBase64ToUtf8(input) {
  return Buffer.from(String(input || ""), "base64").toString("utf8");
}

function getApiBaseUrl(req) {
  const protoHeader = req.headers["x-forwarded-proto"];
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = typeof protoHeader === "string" && protoHeader.trim() ? protoHeader.split(",")[0].trim() : "https";
  const host = typeof hostHeader === "string" && hostHeader.trim() ? hostHeader.trim() : "";
  if (!host) {
    return undefined;
  }
  return `${proto}://${host}`;
}

function getAllowedSourceOrigins(req) {
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
  const apiBaseUrl = getApiBaseUrl(req);
  if (apiBaseUrl) {
    out.add(apiBaseUrl);
  }
  return out;
}

function normalizeSourceUrl(input, req) {
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
  const allowedOrigins = getAllowedSourceOrigins(req);
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `source origin is not allowed. Allowed origins: ${[...allowedOrigins].sort().join(", ")}`
    );
  }
  return parsed.toString();
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

function buildHtml(tokensJson, css, appBundle) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tokvista Preview</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="tokvista-root"></div>
    <script>window.__TOKVISTA_TOKENS__ = ${tokensJson};</script>
    <script type="module">${appBundle}</script>
  </body>
</html>`;
}

module.exports = async function handler(req, res) {
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
  const sourceRaw = (query.get("source") || "").trim();

  let tokens;
  if (sourceRaw) {
    let sourceUrl;
    try {
      sourceUrl = normalizeSourceUrl(sourceRaw, req);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).send(message);
      return;
    }
    try {
      const response = await fetch(sourceUrl, { method: "GET", headers: { Accept: "application/json" } });
      if (!response.ok) {
        res.status(response.status).send(`Source read failed (${response.status})`);
        return;
      }
      const content = await response.text();
      if (!content.trim()) {
        res.status(502).send("Source response did not include token content");
        return;
      }
      tokens = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).send(`Failed to fetch source tokens: ${message}`);
      return;
    }
  } else {
    if (!projectId) {
      res.status(400).send("Missing projectId parameter");
      return;
    }

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

    // Fetch tokens from GitHub
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
      tokens = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(502).send(`Failed to fetch tokens: ${message}`);
      return;
    }
  }

  // Read CSS and JS from tokvista package
  try {
    const cssPath = path.join(process.cwd(), "node_modules", "tokvista", "dist", "styles.css");
    const jsPath = path.join(process.cwd(), "node_modules", "tokvista", "dist", "cli", "browser.js");

    const css = fs.readFileSync(cssPath, "utf8");
    const appBundle = fs.readFileSync(jsPath, "utf8");
    const tokensJson = JSON.stringify(tokens);

    const html = buildHtml(tokensJson, css, appBundle);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.status(200).send(html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).send(`Failed to build preview page: ${message}`);
  }
};
