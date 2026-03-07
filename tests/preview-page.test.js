import { afterEach, describe, expect, it } from "vitest";

const previewPage = require("../api/preview-page.js");
const originalAllowedOrigins = process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS;

afterEach(() => {
  if (typeof originalAllowedOrigins === "string") {
    process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS = originalAllowedOrigins;
  } else {
    delete process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS;
  }
});

describe("preview-page security", () => {
  it("escapes embedded JSON before injecting it into script tags", () => {
    const payload = {
      value: "</script><script>window.__TOKVISTA_PWNED__=1</script>\u2028\u2029"
    };
    const html = previewPage.__test.buildHtml(
      JSON.stringify(payload),
      JSON.stringify(payload),
      "body{}",
      "console.log('ok');"
    );

    const closingScriptTagCount = (html.match(/<\/script>/gi) || []).length;

    expect(closingScriptTagCount).toBe(3);
    expect(html).not.toContain("</script><script>window.__TOKVISTA_PWNED__=1</script>");
    expect(html).toContain("<\\/script><script>window.__TOKVISTA_PWNED__=1<\\/script>\\u2028\\u2029");
  });

  it("forces dark preview mode and removes the theme toggle from hosted preview chrome", () => {
    const runtimeConfig = previewPage.__test.buildRuntimeConfig({
      projectId: "demo",
      environment: "prod",
      sourceUrl: "",
      historyApiUrl: "",
      version: "1.2.3"
    });
    const html = previewPage.__test.buildHtml("{}", JSON.stringify(runtimeConfig), "body{}", "console.log('ok');");

    expect(runtimeConfig.theme).toBe("dark");
    expect(runtimeConfig.enableModeToggle).toBe(false);
    expect(html).toContain("color-scheme: dark");
    expect(html).toContain(
      ".ftd-header-actions > :not(.ftd-format-selector):not(.ftd-header-action-btn):not(.ftd-header-search-btn)"
    );
    expect(html).toContain(".ftd-snapshot-actions .ftd-search-button");
    expect(html).toContain(".ftd-snapshot-header p");
    expect(html).toContain(".ftd-snapshot-lock-note");
  });

  it("parses structured GitHub preview targets from query params", () => {
    const params = new URLSearchParams({
      owner: "nibin-build-01",
      repo: "tok-new",
      ref: "main",
      path: "tokens.json"
    });

    expect(previewPage.__test.readGitHubTargetFromQuery(params)).toEqual({
      owner: "nibin-build-01",
      repo: "tok-new",
      ref: "main",
      filePath: "tokens.json"
    });
  });

  it("does not mark structured GitHub preview mode as raw source history mode", () => {
    const runtimeConfig = previewPage.__test.buildRuntimeConfig({
      projectId: "",
      environment: "",
      sourceUrl: "",
      historyApiUrl: "/api/version-history?owner=nibin-build-01&repo=tok-new&ref=main&path=tokens.json",
      version: "1.2.3"
    });

    expect(runtimeConfig.snapshotHistory.sourceUrl).toBe("");
    expect(runtimeConfig.snapshotHistory.historyEndpoint).toContain("owner=nibin-build-01");
  });

  it("normalizes relay API URLs without trailing slashes", () => {
    process.env.TOKVISTA_ALLOWED_PREVIEW_SOURCE_ORIGINS = "https://tokvista-plugin.vercel.app";
    expect(previewPage.__test.normalizeRelayApiUrl("https://tokvista-plugin.vercel.app/api/")).toBe(
      "https://tokvista-plugin.vercel.app/api"
    );
  });
});
