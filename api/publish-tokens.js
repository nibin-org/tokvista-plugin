"use strict";

const {
  createVersionId,
  getTargetPath,
  handleOptions,
  parseProjectsConfig,
  putContent,
  readJsonBody,
  sendJson
} = require("./_shared");

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
  const payload = body.payload;

  if (!projectId || !publishKey) {
    sendJson(res, 400, { error: "projectId and publishKey are required." });
    return;
  }
  if (!payload || typeof payload !== "object") {
    sendJson(res, 400, { error: "payload is required." });
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
    sendJson(res, 400, {
      error:
        "localPath mode is not supported on Vercel. Configure owner/repo/branch/path for GitHub writes."
    });
    return;
  }

  const githubToken = process.env.TOKVISTA_GITHUB_TOKEN || projectConfig.githubToken;
  const owner = projectConfig.owner;
  const repo = projectConfig.repo;
  const branch = projectConfig.branch || "main";
  const path = getTargetPath(projectConfig, environment);

  if (!githubToken || !owner || !repo) {
    sendJson(res, 500, {
      error: "Project target is incomplete. Configure TOKVISTA_GITHUB_TOKEN and owner/repo."
    });
    return;
  }

  const versionId = createVersionId();
  const content = JSON.stringify(payload, null, 2);
  const commitMessage = `chore(tokens): ${projectId} ${environment} ${versionId}`;

  try {
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
      sendJson(res, 200, {
        message: "No changes to publish.",
        changed: false
      });
      return;
    }
    const githubPayload = githubResult.payload;

    const referenceUrl =
      githubPayload && githubPayload.commit && typeof githubPayload.commit.html_url === "string"
        ? githubPayload.commit.html_url
        : undefined;

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
};
