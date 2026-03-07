import { describe, expect, it } from "vitest";

const previewPage = require("../api/preview-page.js");

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
});
