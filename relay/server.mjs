import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), "relay", "data");
const PREVIEW_BASE_URL = (process.env.TOKVISTA_PREVIEW_BASE_URL || "https://tokvista-demo.vercel.app/").trim();

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

const PROJECTS = parseProjectsConfig();

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function getProjectConfig(projectId) {
  const config = PROJECTS[projectId];
  if (!config || typeof config !== "object") {
    return null;
  }
  return config;
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

function resolveLocalPath(localPath) {
  if (!localPath || typeof localPath !== "string") {
    throw new Error("Invalid localPath.");
  }
  const trimmed = localPath.trim();
  if (!trimmed) {
    throw new Error("Invalid localPath.");
  }
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
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
  if (response.status === 404) return null;
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

async function persistVersion(projectId, versionId, payload) {
  const outputPath = join(DATA_DIR, projectId, `${versionId}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
}

async function writeLocalOutput(localPath, content) {
  const absolutePath = resolveLocalPath(localPath);
  let existing = null;
  try {
    existing = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (typeof existing === "string") {
    const existingComparable = normalizeContentForComparison(existing);
    const nextComparable = normalizeContentForComparison(content);
    if (existingComparable === nextComparable) {
      return {
        absolutePath,
        changed: false
      };
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return {
    absolutePath,
    changed: true
  };
}

function createVersionId() {
  const now = new Date();
  const iso = now.toISOString().replace(/[-:.TZ]/g, "");
  return `v${iso}`;
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

function buildBranchRawUrl(owner, repo, branch, path) {
  if (!owner || !repo || !branch || !path) {
    return undefined;
  }
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/${encodeURIComponent(branch)}/${encodePathForRaw(path)}`;
}

function buildPreviewUrl(rawUrl) {
  if (!rawUrl || !PREVIEW_BASE_URL) {
    return undefined;
  }
  const normalizedBase = PREVIEW_BASE_URL.endsWith("/") ? PREVIEW_BASE_URL : `${PREVIEW_BASE_URL}/`;
  return `${normalizedBase}?source=${encodeURIComponent(rawUrl)}`;
}

async function handlePublish(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const publishKey = typeof body.publishKey === "string" ? body.publishKey.trim() : "";
  const environment = typeof body.environment === "string" && body.environment.trim()
    ? body.environment.trim()
    : "dev";
  const source = typeof body.source === "string" ? body.source : "unknown";
  const fileKey = typeof body.fileKey === "string" ? body.fileKey : null;
  const payload = body.payload;

  if (!projectId || !publishKey) {
    sendJson(res, 400, { error: "projectId and publishKey are required." });
    return;
  }
  if (!payload || typeof payload !== "object") {
    sendJson(res, 400, { error: "payload is required." });
    return;
  }

  const projectConfig = getProjectConfig(projectId);
  if (!projectConfig) {
    sendJson(res, 404, { error: "Unknown projectId." });
    return;
  }
  if (projectConfig.publishKey !== publishKey) {
    sendJson(res, 401, { error: "Unauthorized publish key." });
    return;
  }

  const versionId = createVersionId();
  const content = JSON.stringify(payload, null, 2);
  const localPath = projectConfig.localPath;
  const githubToken = process.env.TOKVISTA_GITHUB_TOKEN || projectConfig.githubToken;
  const owner = projectConfig.owner;
  const repo = projectConfig.repo;
  const branch = projectConfig.branch || "main";
  const path = getTargetPath(projectConfig, environment);

  try {
    let referenceUrl;

    if (typeof localPath === "string" && localPath.trim()) {
      const localResult = await writeLocalOutput(localPath, content);
      referenceUrl = `file:${localResult.absolutePath}`;
      if (!localResult.changed) {
        sendJson(res, 200, {
          message: "No changes to publish.",
          referenceUrl,
          changed: false
        });
        return;
      }
    } else {
      if (!githubToken || !owner || !repo) {
        sendJson(res, 500, {
          error: "Project target is incomplete. Configure either localPath or GitHub owner/repo/token."
        });
        return;
      }
      const commitMessage = `chore(tokens): ${projectId} ${environment} ${versionId}`;
      const githubResult = await putContent({
        owner,
        repo,
        branch,
        path,
        token: githubToken,
        message: commitMessage,
        content
      });
      if (!githubResult.changed) {
        const rawUrl = buildBranchRawUrl(owner, repo, branch, path);
        const previewUrl = buildPreviewUrl(rawUrl);
        sendJson(res, 200, {
          message: "No changes to publish.",
          rawUrl,
          previewUrl,
          changed: false
        });
        return;
      }
      const githubPayload = githubResult.payload;
      const commitSha =
        githubPayload && githubPayload.commit && typeof githubPayload.commit.sha === "string"
          ? githubPayload.commit.sha
          : undefined;
      referenceUrl =
        githubPayload && githubPayload.commit && typeof githubPayload.commit.html_url === "string"
          ? githubPayload.commit.html_url
          : undefined;
      const rawUrl = buildRawUrl(owner, repo, commitSha, path);
      const previewUrl = buildPreviewUrl(rawUrl || buildBranchRawUrl(owner, repo, branch, path));
      await persistVersion(projectId, versionId, {
        versionId,
        projectId,
        environment,
        source,
        fileKey,
        createdAt: new Date().toISOString(),
        payload,
        referenceUrl,
        rawUrl,
        previewUrl
      });

      sendJson(res, 200, {
        versionId,
        message: "Published successfully.",
        referenceUrl,
        rawUrl,
        previewUrl,
        changed: true
      });
      return;
    }

    await persistVersion(projectId, versionId, {
      versionId,
      projectId,
      environment,
      source,
      fileKey,
      createdAt: new Date().toISOString(),
      payload
    });

    sendJson(res, 200, {
      versionId,
      message: "Published successfully.",
      referenceUrl,
      changed: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: message });
  }
}

async function handlePreviewLink(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const publishKey = typeof body.publishKey === "string" ? body.publishKey.trim() : "";
  const environment = typeof body.environment === "string" && body.environment.trim()
    ? body.environment.trim()
    : "dev";

  if (!projectId || !publishKey) {
    sendJson(res, 400, { error: "projectId and publishKey are required." });
    return;
  }

  const projectConfig = getProjectConfig(projectId);
  if (!projectConfig) {
    sendJson(res, 404, { error: "Unknown projectId." });
    return;
  }
  if (projectConfig.publishKey !== publishKey) {
    sendJson(res, 401, { error: "Unauthorized publish key." });
    return;
  }
  if (typeof projectConfig.localPath === "string" && projectConfig.localPath.trim()) {
    sendJson(res, 400, { error: "preview-link is not supported in localPath mode." });
    return;
  }

  const owner = projectConfig.owner;
  const repo = projectConfig.repo;
  const branch = projectConfig.branch || "main";
  const path = getTargetPath(projectConfig, environment);
  if (!owner || !repo || !path) {
    sendJson(res, 500, { error: "Project target is incomplete. Configure owner/repo/path." });
    return;
  }

  const rawUrl = buildBranchRawUrl(owner, repo, branch, path);
  const previewUrl = buildPreviewUrl(rawUrl);
  sendJson(res, 200, {
    projectId,
    environment,
    branch,
    path,
    rawUrl,
    previewUrl
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    sendJson(res, 200, {
      ok: true,
      service: "tokvista-relay",
      status: "running",
      endpoints: ["/health", "/config-example", "/publish-tokens"],
      projectsLoaded: Object.keys(PROJECTS).length
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "tokvista-relay",
      projectsLoaded: Object.keys(PROJECTS).length
    });
    return;
  }

  if (req.method === "GET" && req.url === "/config-example") {
    const example = {
      "project-alpha": {
        publishKey: "replace-with-secret",
        owner: "nibin-org",
        repo: "tokvista",
        branch: "main",
        path: "tokens/tokens.json",
        paths: {
          dev: "tokens/dev.tokens.json",
          prod: "tokens/prod.tokens.json"
        }
      }
    };
    sendJson(res, 200, example);
    return;
  }

  if (req.method === "POST" && req.url === "/publish-tokens") {
    await handlePublish(req, res);
    return;
  }

  if (req.method === "POST" && req.url === "/preview-link") {
    await handlePreviewLink(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[tokvista-relay] listening on http://localhost:${PORT}`);
});
