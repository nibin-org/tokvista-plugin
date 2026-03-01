"use strict";

const {
  getTargetPath,
  handleOptions,
  parseProjectsConfig,
  readJsonBody,
  sendJson
} = require("./_shared");

function encodePathForRaw(path) {
  return String(path)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

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

  const projects = parseProjectsConfig();
  const projectConfig = projects[projectId];
  if (!projectConfig || typeof projectConfig !== "object") {
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
};
