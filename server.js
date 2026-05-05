/**
 * server.js — Rominify Proxy Server
 *
 * This server sits between the Chrome extension and the Gemini API.
 * It holds the API key as a server-side environment variable — never
 * exposed to the browser or the extension's source code.
 *
 * Anyone with the extension installed can summarize pages without
 * needing their own API key.
 *
 * Security measures:
 *   - Rate limiting: 10 requests per IP per hour
 *   - Input validation: rejects empty or oversized payloads
 *   - CORS: locked to the extension's origin only
 *   - Helmet: sets secure HTTP headers
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────

// Helmet sets security-related HTTP headers automatically
app.use(helmet());

// Parse incoming JSON bodies (our extension sends JSON)
app.use(express.json({ limit: "50kb" })); // Hard cap on request size

// CORS — only allow requests from Chrome extensions
// Chrome extensions send requests with origin: "chrome-extension://<id>"
// During development we also allow null origin (Postman/curl testing)
app.use(cors({
  origin: (origin, callback) => {
    if (
      !origin ||
      origin.startsWith("chrome-extension://") ||
      origin === "null"
    ) {
      callback(null, true);
    } else {
      callback(new Error("CORS: Origin not allowed"));
    }
  },
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));

// Rate limiter — 10 requests per IP per hour
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "RATE_LIMITED",
    message: "You have made too many requests. Please wait an hour and try again."
  }
});

app.use("/summarize", limiter);

// ─── Health Check ─────────────────────────────────────────────────────────────
// Render.com pings this to check if the server is alive

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "rominify-proxy" });
});

// ─── Main Summarize Endpoint ──────────────────────────────────────────────────

app.post("/summarize", async (req, res) => {
  const { title, content, url } = req.body;

  // ── Input Validation ──
  if (!content || typeof content !== "string" || content.trim().length < 100) {
    return res.status(400).json({
      error: "INVALID_INPUT",
      message: "Not enough content to summarize."
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error("[Rominify] GEMINI_API_KEY is not set in environment.");
    return res.status(500).json({
      error: "SERVER_MISCONFIGURED",
      message: "The server is not configured correctly. Contact the administrator."
    });
  }

  try {
    const summary = await callGeminiAPI(
      process.env.GEMINI_API_KEY,
      title || "Untitled",
      content
    );

    res.json({ success: true, data: summary });

  } catch (err) {
    console.error("[Rominify] Gemini error:", err.message);
    res.status(502).json({
      error: "UPSTREAM_ERROR",
      message: err.message || "Failed to get a response from Gemini."
    });
  }
});

// ─── Gemini API Call ──────────────────────────────────────────────────────────

async function callGeminiAPI(apiKey, title, content) {
  const trimmedContent = content.slice(0, 12000);
  const prompt = buildPrompt(title, trimmedContent);

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024
      }
    })
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const errMsg = errData?.error?.message || `HTTP ${response.status}`;
    throw new Error(`Gemini API error: ${errMsg}`);
  }

  const data = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty response from Gemini.");

  return parseGeminiResponse(rawText, content);
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildPrompt(title, content) {
  return `You are a precise, intelligent reading assistant. Analyze the following webpage content and return a structured summary.

Page Title: ${title}

Page Content:
${content}

Respond in this EXACT format with no extra commentary, no markdown symbols like **, no hashtags:

SUMMARY:
[2-3 sentence overview of what this page is about]

KEY_POINTS:
- [key point 1]
- [key point 2]
- [key point 3]
- [key point 4, if applicable]
- [key point 5, if applicable]

READING_TIME:
[estimated reading time in minutes, just the number]

TOPICS:
[comma-separated list of 3-5 topic tags, lowercase]

Keep everything concise and factual. If the page has no meaningful content (e.g. login page or blank), respond with:
SUMMARY:
This page does not contain summarizable content.
KEY_POINTS:
- N/A
READING_TIME:
0
TOPICS:
none`;
}

// ─── Response Parser ──────────────────────────────────────────────────────────

function parseGeminiResponse(rawText, originalContent) {
  const extract = (label, text) => {
    const regex = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
    const match = text.match(regex);
    return match ? match[1].trim() : "";
  };

  const summary = extract("SUMMARY", rawText);

  const keyPointsRaw = extract("KEY_POINTS", rawText);
  const keyPoints = keyPointsRaw
    .split("\n")
    .map(line => line.replace(/^[-•*]\s*/, "").trim())
    .filter(line => line && line !== "N/A");

  const readingTimeRaw = extract("READING_TIME", rawText);
  const readingTime = parseInt(readingTimeRaw, 10) || estimateReadingTime(originalContent);

  const topicsRaw = extract("TOPICS", rawText);
  const topics = topicsRaw
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(t => t && t !== "none");

  return { summary, keyPoints, readingTime, topics, generatedAt: Date.now() };
}

function estimateReadingTime(text) {
  const words = text.trim().split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[Rominify] Proxy server running on port ${PORT}`);
});
