"use strict";

function parseProjectsConfig() {
  const raw = process.env.TOKVISTA_PROJECTS;
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.status(statusCode).json(payload);
}

function handleOptions(req, res) {
  if (req.method !== "OPTIONS") {
    return false;
  }
  setCorsHeaders(res);
  res.status(204).end();
  return true;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function getTargetPath(projectConfig, environment) {
  if (projectConfig.paths && typeof projectConfig.paths === "object" && projectConfig.paths !== null) {
    const envPath = projectConfig.paths[environment];
    if (typeof envPath === "string" && envPath.trim()) {
      return envPath.trim();
    }
  }
  if (typeof projectConfig.path === "string" && projectConfig.path.trim()) {
    return projectConfig.path.trim();
  }
  return "tokens.json";
}

function createVersionId() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:.TZ]/g, "");
  return `v${iso}`;
}

async function githubRequest(url, token, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("Content-Type", "application/json");
  return fetch(url, { ...options, headers });
}

function utf8ToBase64(input) {
  return Buffer.from(input, "utf8").toString("base64");
}

function base64ToUtf8(input) {
  return Buffer.from(input, "base64").toString("utf8");
}

function normalizeValueForComparison(value, isRoot = false) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValueForComparison(item, false));
  }
  if (value && typeof value === "object") {
    const out = {};
    const keys = Object.keys(value).sort();
    for (const key of keys) {
      if (isRoot && key === "$exportedAt") {
        continue;
      }
      out[key] = normalizeValueForComparison(value[key], false);
    }
    return out;
  }
  return value;
}

function normalizeContentForComparison(content) {
  if (typeof content !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(normalizeValueForComparison(parsed, true));
  } catch {
    return content;
  }
}

async function getContentMeta({ owner, repo, branch, path, token }) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const response = await githubRequest(url, token, { method: "GET" });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub read failed (${response.status}): ${text}`);
  }
  const payload = await response.json();
  const sha = typeof payload.sha === "string" ? payload.sha : null;
  const content =
    typeof payload.content === "string" && payload.encoding === "base64"
      ? base64ToUtf8(payload.content.replace(/\n/g, ""))
      : null;
  return {
    sha,
    content
  };
}

async function putContent({ owner, repo, branch, path, token, message, content }) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${encodedPath}`;
  const existing = await getContentMeta({ owner, repo, branch, path, token });
  const nextComparable = normalizeContentForComparison(content);
  if (existing && typeof existing.content === "string") {
    const existingComparable = normalizeContentForComparison(existing.content);
    if (existingComparable === nextComparable) {
      return {
        changed: false
      };
    }
  }
  const body = {
    message,
    content: utf8ToBase64(content),
    branch
  };
  if (existing && existing.sha) {
    body.sha = existing.sha;
  }

  const response = await githubRequest(url, token, {
    method: "PUT",
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub write failed (${response.status}): ${text}`);
  }
  return {
    changed: true,
    payload: await response.json()
  };
}

module.exports = {
  createVersionId,
  getTargetPath,
  handleOptions,
  parseProjectsConfig,
  putContent,
  readJsonBody,
  sendJson
};
