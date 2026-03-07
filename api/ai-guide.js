"use strict";

const { getClientIp, handleOptions, readJsonBody, sendJson, takeRateLimit } = require("./_shared");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";
const MAX_MESSAGE_LENGTH = 2000;

const SYSTEM_PROMPT = [
  "You are Tokvista AI, a friendly design token expert inside a Figma plugin.",
  "",
  "Your job is to help designers who don't know how to create Figma variables.",
  "",
  "Always follow this token structure - Foundation first, then Semantic:",
  "- Foundation tokens = raw values (color.blue.500 = #3b82f6)",
  "- Semantic tokens = meaningful names (color.button.background = {color.blue.500})",
  "",
  "When you have enough information about their project, generate a complete tokens.json and wrap it in a code block like this:",
  "```json",
  "{",
  '  "tokens": { ... }',
  "}",
  "```",
  "",
  "Always include these token groups when generating:",
  "- color (brand, neutral, feedback: success/warning/error/info)",
  "- spacing (xs: 4px, sm: 8px, md: 16px, lg: 24px, xl: 32px, 2xl: 48px)",
  "- borderRadius (none: 0, sm: 4px, md: 8px, lg: 12px, full: 9999px)",
  "- fontSize (xs: 12px, sm: 14px, md: 16px, lg: 18px, xl: 24px, 2xl: 32px)",
  "- If dark mode needed: add a semantic layer with light/dark values",
  "",
  'Token format to use: { "type": "color", "value": "#3b82f6" }',
  "",
  "Keep conversation friendly and short.",
  "Ask questions if you need more info before generating.",
  "After generating explain what you created in 2-3 simple sentences."
].join("\n");

function isObjectLike(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonCandidate(input) {
  if (typeof input !== "string" || !input.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(input);
    return isObjectLike(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractBalancedJsonObject(input) {
  const text = String(input || "");
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return parseJsonCandidate(text.slice(start, index + 1));
      }
    }
  }
  return null;
}

function hasTokenLeafShape(value) {
  return isObjectLike(value) && ("value" in value || "$value" in value);
}

function normalizeExplicitTokenType(rawType) {
  const value = typeof rawType === "string" ? rawType.trim() : "";
  if (!value) {
    return "";
  }
  const normalized = value.toLowerCase();
  if (normalized === "color") return "color";
  if (normalized === "borderradius") return "borderRadius";
  if (normalized === "fontsize") return "fontSize";
  if (normalized === "lineheight") return "lineHeight";
  if (normalized === "letterspacing") return "letterSpacing";
  if (
    normalized === "number" ||
    normalized === "dimension" ||
    normalized === "spacing" ||
    normalized === "sizing" ||
    normalized === "borderwidth" ||
    normalized === "opacity" ||
    normalized === "fontfamily" ||
    normalized === "fontweight" ||
    normalized === "typography" ||
    normalized === "string"
  ) {
    return normalized;
  }
  return "string";
}

function looksLikeColor(value) {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  return /^#(?:[0-9a-f]{3,8})$/i.test(text) || /^(rgb|rgba|hsl|hsla)\(/i.test(text);
}

function looksLikeNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "string") {
    return false;
  }
  return /^-?\d+(?:\.\d+)?\s*(px|rem|em|%)?$/i.test(value.trim());
}

function isAliasString(value) {
  return typeof value === "string" && /^\{[^}]+\}$/.test(value.trim());
}

function extractAliasWithUnit(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = value.trim().match(/^(\{[^}]+\})\s*(px|rem|em|%)$/i);
  if (!match) {
    return null;
  }
  return { alias: match[1], unit: match[2].toLowerCase() };
}

function sanitizeTokenKey(key) {
  return String(key || "")
    .trim()
    .replace(/['"`]/g, "")
    .replace(/&/g, "and")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "") || "token";
}

function sanitizeAliasValue(value) {
  if (!isAliasString(value)) {
    return value;
  }
  const inner = value.trim().slice(1, -1);
  const cleaned = inner
    .split(".")
    .map((part) => sanitizeTokenKey(part))
    .filter(Boolean)
    .join(".");
  return cleaned ? `{${cleaned}}` : value.trim();
}

function inferTypeFromPath(path, value) {
  const joined = path.join(".").toLowerCase();
  if (looksLikeColor(value)) return "color";
  const aliasWithUnit = extractAliasWithUnit(value);
  if (typeof value === "number" || looksLikeNumber(value)) {
    if (joined.includes("radius")) return "borderRadius";
    if (joined.includes("font") && joined.includes("size")) return "fontSize";
    if (joined.includes("line") && joined.includes("height")) return "lineHeight";
    if (joined.includes("letter") && joined.includes("spacing")) return "letterSpacing";
    if (
      joined.includes("spacing") ||
      joined.includes("space") ||
      joined.includes("gap") ||
      joined.includes("padding") ||
      joined.includes("margin")
    ) {
      return "spacing";
    }
    if (joined.includes("opacity")) return "opacity";
    return "number";
  }
  if (aliasWithUnit) {
    if (joined.includes("radius")) return "borderRadius";
    if (joined.includes("font") && joined.includes("size")) return "fontSize";
    if (joined.includes("line") && joined.includes("height")) return "lineHeight";
    if (joined.includes("letter") && joined.includes("spacing")) return "letterSpacing";
    if (joined.includes("spacing") || joined.includes("space") || joined.includes("size")) return "number";
    if (joined.includes("opacity") && aliasWithUnit.unit === "%") return "opacity";
    return "number";
  }
  if (isAliasString(value)) {
    if (
      joined.includes("color") ||
      joined.includes("background") ||
      joined.includes("text") ||
      joined.includes("surface") ||
      joined.includes("border")
    ) {
      return "color";
    }
    if (joined.includes("radius")) return "borderRadius";
    if (joined.includes("spacing") || joined.includes("space") || joined.includes("size")) return "number";
    return "string";
  }
  if (typeof value === "string") return "string";
  if (typeof value === "boolean" || value === null || Array.isArray(value) || isObjectLike(value)) return "string";
  return "";
}

function normalizeLeafValue(type, value) {
  const aliasWithUnit = extractAliasWithUnit(value);
  if (
    aliasWithUnit &&
    (
      type === "number" ||
      type === "spacing" ||
      type === "sizing" ||
      type === "borderRadius" ||
      type === "borderWidth" ||
      type === "opacity" ||
      type === "fontSize" ||
      type === "lineHeight" ||
      type === "letterSpacing"
    )
  ) {
    return sanitizeAliasValue(aliasWithUnit.alias);
  }
  if (isAliasString(value)) {
    return sanitizeAliasValue(value);
  }
  if (type === "color" && typeof value === "string") {
    return value.trim();
  }
  if (
    type === "number" ||
    type === "spacing" ||
    type === "sizing" ||
    type === "borderRadius" ||
    type === "borderWidth" ||
    type === "opacity" ||
    type === "fontSize" ||
    type === "lineHeight" ||
    type === "letterSpacing"
  ) {
    if (typeof value === "number" || typeof value === "string") {
      return value;
    }
  }
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeTokenLeaf(rawType, rawValue, path) {
  const type = normalizeExplicitTokenType(rawType) || inferTypeFromPath(path, rawValue);
  if (!type) {
    return null;
  }
  return {
    type,
    value: normalizeLeafValue(type, rawValue)
  };
}

function normalizeTokenTree(node, path = []) {
  if (Array.isArray(node)) {
    return path.length ? normalizeTokenLeaf("", node, path) : null;
  }
  if (hasTokenLeafShape(node)) {
    const rawValue = Object.prototype.hasOwnProperty.call(node, "value") ? node.value : node.$value;
    const rawType = typeof node.type === "string" ? node.type : typeof node.$type === "string" ? node.$type : "";
    return normalizeTokenLeaf(rawType, rawValue, path);
  }
  if (!isObjectLike(node)) {
    return path.length ? normalizeTokenLeaf("", node, path) : null;
  }

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      !key ||
      key.startsWith("$") ||
      key === "type" ||
      key === "$type" ||
      key === "value" ||
      key === "$value" ||
      key === "description" ||
      key === "meta" ||
      key === "summary"
    ) {
      continue;
    }
    const cleanKey = sanitizeTokenKey(key);
    const normalizedChild = normalizeTokenTree(value, [...path, cleanKey]);
    if (normalizedChild) {
      out[cleanKey] = normalizedChild;
    }
  }
  return Object.keys(out).length ? out : null;
}

function countTokenLeaves(node) {
  if (!isObjectLike(node)) {
    return 0;
  }
  if ("type" in node && "value" in node) {
    return 1;
  }
  return Object.values(node).reduce((total, value) => total + countTokenLeaves(value), 0);
}

function forEachTokenLeaf(node, path, visit) {
  if (!isObjectLike(node)) {
    return;
  }
  if ("type" in node && "value" in node) {
    visit(node, path);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    forEachTokenLeaf(value, [...path, key], visit);
  }
}

function comparableValue(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function setLeafAtPath(root, path, leaf) {
  if (!isObjectLike(root) || !path.length || !isObjectLike(leaf)) {
    return;
  }
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!isObjectLike(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = { ...leaf };
}

function pathAfterMarker(path, marker) {
  const index = path.indexOf(marker);
  if (index < 0) {
    return null;
  }
  return path.slice(index + 1);
}

function isComponentPath(path) {
  return path.includes("component") || path.includes("components");
}

function unwrapCollectionWrapper(path) {
  if (!Array.isArray(path) || path.length < 2) {
    return path;
  }
  const [first, second] = path;
  const head = String(first || "").toLowerCase();
  const next = String(second || "").toLowerCase();
  if (head !== "foundation") {
    return path;
  }
  if (next === "foundation" || next === "semantic" || next === "components" || next === "component" || next === "base") {
    return path.slice(1);
  }
  return path;
}

function foundationPathForLeaf(path) {
  const afterFoundation = pathAfterMarker(path, "foundation");
  if (afterFoundation && afterFoundation.length) {
    return afterFoundation;
  }
  const afterBase = pathAfterMarker(path, "base");
  if (afterBase && afterBase.length) {
    return afterBase;
  }
  return null;
}

function semanticPathForLeaf(path) {
  const afterSemantic = pathAfterMarker(path, "semantic");
  if (afterSemantic && afterSemantic.length) {
    return afterSemantic;
  }
  return null;
}

function componentPathForLeaf(path) {
  const afterComponents = pathAfterMarker(path, "components");
  if (afterComponents && afterComponents.length) {
    return afterComponents;
  }
  const afterComponent = pathAfterMarker(path, "component");
  if (afterComponent && afterComponent.length) {
    return afterComponent;
  }
  return null;
}

function buildCollectionBundle(tokensRoot) {
  const foundationTokens = {};
  const semanticTokens = {};
  const componentTokens = {};
  const foundationMap = new Map();
  const semanticRawMap = new Map();

  forEachTokenLeaf(tokensRoot, [], (leaf, path) => {
    const normalizedPath = unwrapCollectionWrapper(path);
    const foundationPath = foundationPathForLeaf(normalizedPath);
    const semanticPath = semanticPathForLeaf(normalizedPath);
    const componentPath = componentPathForLeaf(normalizedPath);

    if (foundationPath && foundationPath.length) {
      setLeafAtPath(foundationTokens, foundationPath, leaf);
      foundationMap.set(`${leaf.type}|${comparableValue(leaf.value)}`, foundationPath);
      return;
    }
    if (semanticPath && semanticPath.length) {
      setLeafAtPath(semanticTokens, semanticPath, leaf);
      return;
    }
    if ((componentPath && componentPath.length) || isComponentPath(normalizedPath)) {
      setLeafAtPath(componentTokens, componentPath && componentPath.length ? componentPath : normalizedPath, leaf);
      return;
    }
    setLeafAtPath(foundationTokens, normalizedPath, leaf);
    foundationMap.set(`${leaf.type}|${comparableValue(leaf.value)}`, normalizedPath);
  });

  forEachTokenLeaf(semanticTokens, [], (leaf, path) => {
    const comparableKey = `${leaf.type}|${comparableValue(leaf.value)}`;
    if (!semanticRawMap.has(comparableKey)) {
      semanticRawMap.set(comparableKey, path);
    }
    if (isAliasString(leaf.value)) {
      return;
    }
    const foundationPath = foundationMap.get(comparableKey);
    if (!foundationPath) {
      return;
    }
    leaf.value = `{Foundation.${foundationPath.join(".")}}`;
  });

  forEachTokenLeaf(componentTokens, [], (leaf) => {
    if (isAliasString(leaf.value)) {
      return;
    }
    const comparableKey = `${leaf.type}|${comparableValue(leaf.value)}`;
    const semanticPath = semanticRawMap.get(comparableKey);
    if (semanticPath) {
      leaf.value = `{Semantic.${semanticPath.join(".")}}`;
      return;
    }
    const foundationPath = foundationMap.get(comparableKey);
    if (foundationPath) {
      leaf.value = `{Foundation.${foundationPath.join(".")}}`;
    }
  });

  const collections = [];
  if (countTokenLeaves(foundationTokens) > 0) {
    collections.push({ collection: "Foundation", tokens: foundationTokens });
  }
  if (countTokenLeaves(semanticTokens) > 0) {
    collections.push({ collection: "Semantic", tokens: semanticTokens });
  }
  if (countTokenLeaves(componentTokens) > 0) {
    collections.push({ collection: "Components", tokens: componentTokens });
  }
  return collections;
}

function normalizeGeneratedTokens(payload) {
  if (!isObjectLike(payload)) {
    return null;
  }
  const root = isObjectLike(payload.tokens) ? payload.tokens : payload;
  const normalizedTokens = normalizeTokenTree(root, []);
  if (!isObjectLike(normalizedTokens) || countTokenLeaves(normalizedTokens) === 0) {
    return null;
  }
  const collections = buildCollectionBundle(normalizedTokens);
  if (!collections.length) {
    return null;
  }
  if (collections.length === 1) {
    return collections[0];
  }
  return { collections };
}

function extractTokensFromAnswer(answer) {
  const text = String(answer || "");
  if (!text.trim()) {
    return null;
  }

  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    const parsed = parseJsonCandidate(jsonBlockMatch[1].trim());
    if (parsed) {
      return normalizeGeneratedTokens(parsed);
    }
  }

  const genericBlockMatch = text.match(/```\s*([\s\S]*?)```/i);
  if (genericBlockMatch && genericBlockMatch[1]) {
    const parsed = parseJsonCandidate(genericBlockMatch[1].trim());
    if (parsed) {
      return normalizeGeneratedTokens(parsed);
    }
  }

  return normalizeGeneratedTokens(extractBalancedJsonObject(text));
}

function normalizeHistory(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      if (!isObjectLike(item)) {
        return null;
      }
      const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : "";
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!role || !content) {
        return null;
      }
      return { role, content };
    })
    .filter(Boolean)
    .slice(-6);
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  const model = String(process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL;
  if (!apiKey) {
    sendJson(res, 500, { error: "GROQ_API_KEY is not configured." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const history = normalizeHistory(body?.history);
  if (!message) {
    sendJson(res, 400, { error: "message is required." });
    return;
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    sendJson(res, 400, { error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.` });
    return;
  }

  const clientIp = getClientIp(req);
  const rateLimit = takeRateLimit(`ai-guide:${clientIp}`, { limit: 20, windowMs: 60_000 });
  if (!rateLimit.allowed) {
    sendJson(res, 429, {
      error: "Rate limit exceeded for this IP. Try again shortly.",
      retryAfterSeconds: rateLimit.retryAfterSeconds
    });
    return;
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: message }
  ];

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages
      })
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const detail = typeof payload?.error?.message === "string"
        ? payload.error.message
        : `Groq request failed (${response.status}).`;
      sendJson(res, response.status, { error: detail });
      return;
    }

    const answer = typeof payload?.choices?.[0]?.message?.content === "string"
      ? payload.choices[0].message.content.trim()
      : "";
    if (!answer) {
      sendJson(res, 502, { error: "Groq returned an empty response." });
      return;
    }

    const tokens = extractTokensFromAnswer(answer);
    sendJson(res, 200, { answer, tokens: tokens || null });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    sendJson(res, 502, { error: messageText });
  }
};
