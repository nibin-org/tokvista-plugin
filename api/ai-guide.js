"use strict";

const { handleOptions, readJsonBody, sendJson } = require("./_shared");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

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

function extractTokensFromAnswer(answer) {
  const text = String(answer || "");
  if (!text.trim()) {
    return null;
  }

  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (jsonBlockMatch && jsonBlockMatch[1]) {
    const parsed = parseJsonCandidate(jsonBlockMatch[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  const genericBlockMatch = text.match(/```\s*([\s\S]*?)```/i);
  if (genericBlockMatch && genericBlockMatch[1]) {
    const parsed = parseJsonCandidate(genericBlockMatch[1].trim());
    if (parsed) {
      return parsed;
    }
  }

  return extractBalancedJsonObject(text);
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
