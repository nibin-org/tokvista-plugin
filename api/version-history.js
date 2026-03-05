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
  const base = (process.env.TOKVISTA_PREVIEW_BASE_URL || "").trim();
  if (base) {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}source=${encodeURIComponent(rawUrl)}`;
  }
  return undefined;
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

function buildApiBaseUrl(req) {
  const protoHeader = req.headers["x-forwarded-proto"];
  const hostHeader = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = typeof protoHeader === "string" && protoHeader.trim() ? protoHeader.split(",")[0].trim() : "https";
  const host = typeof hostHeader === "string" && hostHeader.trim() ? hostHeader.trim() : "";
  if (!host) {
    return undefined;
  }
  return `${proto}://${host}`;
}

function buildPreviewUrlForRequest(rawUrl, req) {
  if (!rawUrl) {
    return undefined;
  }
  const configured = buildPreviewUrl(rawUrl);
  if (configured) {
    return configured;
  }
  const baseUrl = buildApiBaseUrl(req);
  if (!baseUrl) {
    return undefined;
  }
  return `${baseUrl}/preview?source=${encodeURIComponent(rawUrl)}`;
}

function parseRawGitHubSource(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.origin !== "https://raw.githubusercontent.com") {
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

function normalizeSourceUrl(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") {
    return "";
  }
  return parsed.toString();
}

function resolveTargetFromQuery(query) {
  const sourceRaw = normalizeSourceUrl(query.get("source"));
  if (sourceRaw) {
    const parsedSource = parseRawGitHubSource(sourceRaw);
    if (!parsedSource) {
      return { error: "source must be a raw.githubusercontent.com token file URL." };
    }
    return {
      source: sourceRaw,
      projectId: "",
      environment: "source",
      owner: parsedSource.owner,
      repo: parsedSource.repo,
      branch: parsedSource.ref,
      path: parsedSource.filePath,
      githubToken: process.env.TOKVISTA_GITHUB_TOKEN || "",
      mode: "source"
    };
  }

  const projectId = (query.get("projectId") || "").trim();
  const environment = (query.get("environment") || "dev").trim() || "dev";
  if (!projectId) {
    return { error: "projectId or source is required." };
  }

  const projects = parseProjectsConfig();
  const projectConfig = projects[projectId];
  if (!projectConfig || typeof projectConfig !== "object") {
    return { error: "Unknown projectId.", status: 404 };
  }
  if (typeof projectConfig.localPath === "string" && projectConfig.localPath.trim()) {
    return { error: "version-history is not supported in localPath mode.", status: 400 };
  }

  const owner = projectConfig.owner;
  const repo = projectConfig.repo;
  const branch = projectConfig.branch || "main";
  const path = getTargetPath(projectConfig, environment);
  const githubToken = process.env.TOKVISTA_GITHUB_TOKEN || projectConfig.githubToken;
  if (!owner || !repo || !path) {
    return { error: "Project target is incomplete. Configure owner/repo/path.", status: 500 };
  }

  return {
    source: "",
    projectId,
    environment,
    owner,
    repo,
    branch,
    path,
    githubToken,
    mode: "project"
  };
}

function buildResponseMeta(target) {
  if (target.mode === "source") {
    return {
      source: target.source,
      branch: target.branch,
      path: target.path
    };
  }
  return {
    projectId: target.projectId,
    environment: target.environment,
    branch: target.branch,
    path: target.path
  };
}

function toStatusCode(input, fallback) {
  if (typeof input === "number" && Number.isFinite(input) && input >= 100 && input <= 599) {
    return Math.floor(input);
  }
  return fallback;
}

function handleTargetError(res, target) {
  if (!target || !target.error) {
    return false;
  }
  sendJson(res, toStatusCode(target.status, 400), { error: target.error });
  return true;
}

function getLimit(query) {
  const limitRaw = Number(query.get("limit") || "12");
  if (!Number.isFinite(limitRaw)) {
    return 12;
  }
  return Math.max(1, Math.min(50, Math.floor(limitRaw)));
}

function mapCommitItems(commits, target, req) {
  return commits.map((commitItem, index) => {
    const sha = typeof commitItem?.sha === "string" ? commitItem.sha : "";
    const message = firstLine(commitItem?.commit?.message);
    const publishedAt =
      typeof commitItem?.commit?.committer?.date === "string"
        ? commitItem.commit.committer.date
        : typeof commitItem?.commit?.author?.date === "string"
          ? commitItem.commit.author.date
          : "";
    const rawUrl = buildRawUrl(target.owner, target.repo, sha, target.path);
    const previewUrl = buildPreviewUrlForRequest(rawUrl, req);
    const referenceUrl = typeof commitItem?.html_url === "string" ? commitItem.html_url : "";
    const versionId = extractVersionId(message, sha);
    return {
      id: `${sha || versionId || index}`,
      versionId,
      commitSha: sha,
      commitMessage: message,
      publishedAt,
      environment: target.environment,
      path: target.path,
      rawUrl,
      previewUrl,
      referenceUrl
    };
  });
}

function getCommitsUrl(target, limit) {
  return `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(
    target.repo
  )}/commits?sha=${encodeURIComponent(target.branch)}&path=${encodeURIComponent(target.path)}&per_page=${limit}`;
}

function sendHistoryResponse(res, target, items) {
  setNoStoreHeaders(res);
  sendJson(res, 200, {
    ...buildResponseMeta(target),
    count: items.length,
    items
  });
}

function parseCommitsPayload(payload) {
  return Array.isArray(payload) ? payload : [];
}

function sendGitHubError(res, response, text) {
  sendJson(res, response.status, { error: `GitHub history failed (${response.status}): ${text}` });
}

async function fetchCommits(target, limit) {
  const commitsUrl = getCommitsUrl(target, limit);
  return githubRequest(commitsUrl, target.githubToken);
}

function getTarget(query) {
  return resolveTargetFromQuery(query);
}

function getItemsFromPayload(payload, target, req) {
  const commits = parseCommitsPayload(payload);
  return mapCommitItems(commits, target, req);
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
  const limit = getLimit(query);
  const target = getTarget(query);
  if (handleTargetError(res, target)) {
    return;
  }

  try {
    const response = await fetchCommits(target, limit);
    if (!response.ok) {
      const text = await response.text();
      sendGitHubError(res, response, text);
      return;
    }

    const payload = await response.json();
    const items = getItemsFromPayload(payload, target, req);
    sendHistoryResponse(res, target, items);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: message });
  }
};
