import { afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = global.fetch;
const aiGuide = require("../api/ai-guide.js");

const {
  normalizeGeneratedTokens,
  isProductionReadyTokenBundle,
  hasEnoughDesignContext,
  looksLikeClarifyingAnswer,
  shouldAttemptTokenRepair,
  requestGroqChat,
  sanitizeTokenKey
} = aiGuide.__test;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

describe("ai-guide helpers", () => {
  it("does not treat greetings as enough design context", () => {
    expect(hasEnoughDesignContext("hi", [])).toBe(false);
    expect(hasEnoughDesignContext("hello there", [])).toBe(false);
  });

  it("detects enough design context for a real token request", () => {
    expect(
      hasEnoughDesignContext(
        "Create a fintech mobile app token system with emerald brand colors, slate neutrals, dark theme, typography, spacing, and semantic tokens.",
        []
      )
    ).toBe(true);
  });

  it("avoids repair for clarifying answers and low-context messages", () => {
    expect(
      shouldAttemptTokenRepair({
        message: "hi",
        history: [],
        answer: "To get started, can you tell me a bit about your product?",
        extractedTokens: null
      })
    ).toBe(false);

    expect(looksLikeClarifyingAnswer("To get started, can you tell me a bit about your product?")).toBe(true);
  });

  it("normalizes semantic root groups into the Semantic collection", () => {
    const tokens = normalizeGeneratedTokens({
      tokens: {
        colors: {
          brand: {
            emerald500: { type: "color", value: "#00875A" }
          },
          neutral: {
            slate100: { type: "color", value: "#F7F7F7" },
            slate900: { type: "color", value: "#1A1D23" }
          }
        },
        typography: {
          fontSize: {
            md: { type: "number", value: 16 }
          }
        },
        spacing: {
          md: { type: "number", value: 16 }
        },
        radius: {
          md: { type: "number", value: 8 }
        },
        shadow: {
          md: { type: "string", value: "0 4px 8px rgba(0,0,0,0.1)" }
        },
        background: {
          light: { type: "color", value: "#F7F7F7" },
          dark: { type: "color", value: "#1A1D23" }
        }
      }
    });

    const semantic = tokens.collections.find((entry) => entry.collection === "Semantic");
    expect(semantic).toBeTruthy();
    expect(semantic.tokens.background.light.value).toBe("{Foundation.colors.neutral.slate100}");
    expect(semantic.tokens.background.dark.value).toBe("{Foundation.colors.neutral.slate900}");
  });

  it("recognizes a production-ready Foundation and Semantic bundle", () => {
    const tokens = {
      collections: [
        {
          collection: "Foundation",
          tokens: {
            colors: {
              brand: {
                emerald500: { type: "color", value: "#00875A" },
                teal500: { type: "color", value: "#0097A7" }
              },
              neutral: {
                slate100: { type: "color", value: "#F7F7F7" },
                slate900: { type: "color", value: "#1A1D23" }
              }
            },
            typography: {
              fontSize: {
                sm: { type: "number", value: 14 },
                md: { type: "number", value: 16 }
              }
            },
            spacing: {
              sm: { type: "number", value: 8 },
              md: { type: "number", value: 16 }
            },
            radius: {
              sm: { type: "number", value: 4 },
              md: { type: "number", value: 8 }
            },
            shadow: {
              md: { type: "string", value: "0 4px 8px rgba(0,0,0,0.1)" }
            }
          }
        },
        {
          collection: "Semantic",
          tokens: {
            background: {
              light: { type: "color", value: "{Foundation.colors.neutral.slate100}" },
              dark: { type: "color", value: "{Foundation.colors.neutral.slate900}" }
            },
            surface: {
              light: { type: "color", value: "{Foundation.colors.neutral.slate100}" },
              dark: { type: "color", value: "{Foundation.colors.neutral.slate900}" }
            },
            text: {
              light: { type: "color", value: "{Foundation.colors.neutral.slate900}" },
              dark: { type: "color", value: "{Foundation.colors.neutral.slate100}" }
            },
            border: {
              light: { type: "color", value: "{Foundation.colors.neutral.slate100}" },
              dark: { type: "color", value: "{Foundation.colors.neutral.slate900}" }
            },
            primary: {
              base: { type: "color", value: "{Foundation.colors.brand.emerald500}" }
            },
            success: {
              base: { type: "color", value: "{Foundation.colors.brand.emerald500}" }
            },
            warning: {
              base: { type: "color", value: "{Foundation.colors.brand.teal500}" }
            },
            danger: {
              base: { type: "color", value: "{Foundation.colors.brand.teal500}" }
            },
            focusRing: {
              base: { type: "color", value: "{Foundation.colors.brand.teal500}" }
            }
          }
        }
      ]
    };

    expect(isProductionReadyTokenBundle(tokens)).toBe(true);
  });

  it("sends max_tokens to Groq requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }]
      })
    });
    global.fetch = fetchMock;

    await requestGroqChat({
      apiKey: "test-key",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestOptions = fetchMock.mock.calls[0][1];
    const payload = JSON.parse(requestOptions.body);
    expect(payload.max_tokens).toBe(4096);
  });

  it("sanitizes token keys consistently", () => {
    expect(sanitizeTokenKey("focus.ring")).toBe("focus.ring");
    expect(sanitizeTokenKey("  cool slate / 500 ")).toBe("cool-slate-500");
  });
});
