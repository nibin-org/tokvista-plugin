"use strict";

const { handleOptions, parseProjectsConfig, sendJson } = require("./_shared");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const projects = parseProjectsConfig();
  sendJson(res, 200, {
    ok: true,
    service: "tokvista-relay-vercel",
    projectsLoaded: Object.keys(projects).length
  });
};

