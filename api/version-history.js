"use strict";

const { getTargetPath, handleOptions, parseProjectsConfig, sendJson } = require("./_shared");

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

function encodePathForRaw(path) {
  return String(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildRawUrl(owner, repo, commitSha, path) {
  if (!owner || !repo || !commitSha || !path) {
    return undefined;
  }
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/${encodeURIComponent(commitSha)}/${encodePathForRaw(path)}`;
}

function buildPreviewUrl(rawUrl) {
  if (!rawUrl) {
    return undefined;
  }
  const base = (process.env.TOKVISTA_PREVIEW_BASE_URL || "https://tokvista-demo.vercel.app/").trim();
  if (!base) {
    return undefined;
  }
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  return `${normalizedBase}?source=${encodeURIComponent(rawUrl)}`;
}

function getQuery(req) {
  const rawUrl = typeof req.url === "string" ? req.url : "/api/version-history";
  const parsed = new URL(rawUrl, "http://localhost");
  return parsed.searchParams;
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

function extractVersionId(message, sha) {
  const normalized = typeof message === "string" ? message : "";
  const match = normalized.match(/\bv\d{14,}\b/);
  if (match && match[0]) {
    return match[0];
  }
  if (typeof sha === "string" && sha) {
    return `c${sha.slice(0, 7)}`;
  }
  return "unversioned";
}

function firstLine(input) {
  if (!input || typeof input !== "string") return "";
  return input.split(/\r?\n/, 1)[0].trim();
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
  const limitRaw = Number(query.get("limit") || "12");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;
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
    sendJson(res, 400, { error: "version-history is not supported in localPath mode." });
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

  const commitsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=${limit}`;

  try {
    const response = await githubRequest(commitsUrl, githubToken);
    if (!response.ok) {
      const text = await response.text();
      sendJson(res, response.status, { error: `GitHub history failed (${response.status}): ${text}` });
      return;
    }

    const payload = await response.json();
    const commits = Array.isArray(payload) ? payload : [];
    const items = commits.map((commitItem, index) => {
      const sha = typeof commitItem?.sha === "string" ? commitItem.sha : "";
      const message = firstLine(commitItem?.commit?.message);
      const publishedAt =
        typeof commitItem?.commit?.committer?.date === "string"
          ? commitItem.commit.committer.date
          : typeof commitItem?.commit?.author?.date === "string"
            ? commitItem.commit.author.date
            : "";
      const rawUrl = buildRawUrl(owner, repo, sha, path);
      const previewUrl = buildPreviewUrl(rawUrl);
      const referenceUrl = typeof commitItem?.html_url === "string" ? commitItem.html_url : "";
      const versionId = extractVersionId(message, sha);
      return {
        id: `${sha || versionId || index}`,
        versionId,
        commitSha: sha,
        commitMessage: message,
        publishedAt,
        environment,
        path,
        rawUrl,
        previewUrl,
        referenceUrl
      };
    });

    setNoStoreHeaders(res);
    sendJson(res, 200, {
      projectId,
      environment,
      branch,
      path,
      count: items.length,
      items
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: message });
  }
};
