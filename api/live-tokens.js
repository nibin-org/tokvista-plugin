"use strict";

const { getTargetPath, handleOptions, parseProjectsConfig, sendJson } = require("./_shared");

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function decodeBase64ToUtf8(input) {
  return Buffer.from(String(input || ""), "base64").toString("utf8");
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
  const rawUrl = typeof req.url === "string" ? req.url : "/api/live-tokens";
  const parsed = new URL(rawUrl, "http://localhost");
  return parsed.searchParams;
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const query = getQuery(req);
  const projectId = (query.get("projectId") || "").trim();
  const environment = (query.get("environment") || "dev").trim() || "dev";
  if (!projectId) {
    sendJson(res, 400, { error: "projectId is required." });
    return;
  }

  const projects = parseProjectsConfig();
  const projectConfig = projects[projectId];
  if (!projectConfig || typeof projectConfig !== "object") {
    sendJson(res, 404, { error: "Unknown projectId." });
    return;
  }
  if (typeof projectConfig.localPath === "string" && projectConfig.localPath.trim()) {
    sendJson(res, 400, {
      error: "localPath mode is not supported on Vercel. Configure owner/repo/branch/path for GitHub reads."
    });
    return;
  }

  const owner = projectConfig.owner;
  const repo = projectConfig.repo;
  const branch = projectConfig.branch || "main";
  const path = getTargetPath(projectConfig, environment);
  const githubToken = process.env.TOKVISTA_GITHUB_TOKEN || projectConfig.githubToken;
  if (!owner || !repo || !path) {
    sendJson(res, 500, { error: "Project target is incomplete. Configure owner/repo/path." });
    return;
  }

  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

  try {
    const response = await githubRequest(url, githubToken);
    if (!response.ok) {
      const text = await response.text();
      sendJson(res, response.status, { error: `GitHub read failed (${response.status}): ${text}` });
      return;
    }
    const payload = await response.json();
    const content =
      typeof payload.content === "string" && payload.encoding === "base64"
        ? decodeBase64ToUtf8(payload.content.replace(/\n/g, ""))
        : "";
    if (!content) {
      sendJson(res, 502, { error: "GitHub response did not include token content." });
      return;
    }
    const parsed = JSON.parse(content);
    setNoStoreHeaders(res);
    sendJson(res, 200, parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: message });
  }
};
