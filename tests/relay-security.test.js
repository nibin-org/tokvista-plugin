import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isPathWithinRoot, resolveLocalPath } from "../relay/server.mjs";

describe("relay local path security", () => {
  it("resolves local paths inside the configured root", () => {
    const root = resolve(process.cwd(), "tests", "fixtures", "relay-root");
    const resolvedPath = resolveLocalPath("nested/tokens.json", root);

    expect(resolvedPath).toBe(join(root, "nested", "tokens.json"));
    expect(isPathWithinRoot(resolvedPath, root)).toBe(true);
  });

  it("rejects traversal outside the configured root", () => {
    const root = resolve(process.cwd(), "tests", "fixtures", "relay-root");

    expect(() => resolveLocalPath("../secrets.json", root)).toThrow("localPath must stay within TOKVISTA_LOCAL_ROOT.");
    expect(() => resolveLocalPath(resolve(root, "..", "secrets.json"), root)).toThrow(
      "localPath must stay within TOKVISTA_LOCAL_ROOT."
    );
  });
});
