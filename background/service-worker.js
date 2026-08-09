/**
 * Reading Copilot — Service Worker
 *
 * Responsibilities:
 *  - All Anthropic API calls (with prompt caching)
 *  - chrome.storage management (articles, knowledge graph)
 *  - Cross-article graph generation (after 5 sessions)
 *  - Streaming responses via port messaging to sidebar
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const CROSS_GRAPH_THRESHOLD = 5; // sessions before cross-article graph kicks in

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getSetting(key) {
  const data = await chrome.storage.local.get(key);
  return data[key];
}

async function getArticleData(url) {
  const key = `article:${url}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveArticleData(url, payload) {
  await chrome.storage.local.set({ [`article:${url}`]: payload });
}

async function getKnowledgeGraph() {
  const data = await chrome.storage.local.get("knowledgeGraph");
  return data.knowledgeGraph || { concepts: {}, articles: [], sessionCount: 0 };
}

async function saveKnowledgeGraph(graph) {
  await chrome.storage.local.set({ knowledgeGraph: graph });
}

// ── Anthropic API core ────────────────────────────────────────────────────────

/**
 * systemParts: array of { type: "text", text: string, cache_control?: {...} }
 * Prompt caching: the article text block is marked ephemeral so all readers of
 * the same article pay full price only on the FIRST call; subsequent calls
 * within 5 minutes hit the cache at ~10% cost.
 */
async function callClaude({ apiKey, systemParts, messages, stream = false, maxTokens = 1024 }) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemParts,
      messages,
      stream,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${res.status}`);
  }

  return res;
}

// ── System prompt builder (with cache marker on article) ──────────────────────

function buildSystemParts(articleText, articleTitle) {
  return [
    {
      // This block is cached: all users reading the same article share the cache
      type: "text",
      text: `You are Reading Copilot, an AI assistant that helps readers understand articles deeply and precisely.

Article: "${articleTitle}"

Full article:
${articleText}`,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: `Instructions:
- Answer in the same language as the reader's question (Chinese or English)
- Answer the question directly and helpfully, drawing on both the article AND your general domain knowledge as needed. Do not limit yourself to what the article explicitly says.
- If the article addresses the question directly, cite the relevant part. If the question goes beyond the article's scope, say so in one short phrase (e.g. "The article doesn't cover this, but…") and then give your best substantive answer using domain knowledge, grounded in the article's context.
- Be concise: lead with the core point, add 1-2 supporting details, then the implication if relevant. 3-5 sentences total — not an essay.
- Maintain full conversation context across follow-up questions
- When the reader has selected a specific passage, treat that passage as the PRIMARY anchor for your answer. Interpret the question through the lens of that specific excerpt. Use the rest of the article only as supporting context.
- After your answer, on a new line write exactly: CONCEPTS: concept1, concept2, concept3
  (2–4 key concepts from your answer, in English, comma-separated)`,
    },
  ];
}

// ── Generate pre-reading questions ────────────────────────────────────────────

const PURPOSE_PROMPTS = {
  interview:
    `Generate exactly 3 interview-style questions about this article, each with a concise sample answer.
Questions must test how someone would defend, challenge, or apply the ideas — not just recall. Start each with a verb: "How would you…", "What would you do if…", "Why does… matter for…".
Sample answers: 2-3 sentences, structured as: core claim → supporting detail from article → real-world implication. Natural prose, no bullet points.
Return ONLY a JSON array: [{"question":"…","answer":"…"},{"question":"…","answer":"…"},{"question":"…","answer":"…"}]`,

  learning:
    `Generate exactly 3 comprehension questions about this article, each with a sample answer.
Questions should test genuine understanding — fill-the-gap or explain-in-your-own-words style. Keep language simple.
Sample answers: 1-2 sentences, drawn directly from the article, written as natural explanation (not quoted text, not bullets).
Return ONLY a JSON array: [{"question":"…","answer":"…"},{"question":"…","answer":"…"},{"question":"…","answer":"…"}]`,

  research:
    `Generate exactly 3 critical analysis questions about this article, each with a sample answer.
Questions should probe methodology, assumptions, evidence quality, and broader implications.
Sample answers: 2-3 sentences modeling analytical thinking. Structure: observation → reasoning → implication. Natural prose.
Return ONLY a JSON array: [{"question":"…","answer":"…"},{"question":"…","answer":"…"},{"question":"…","answer":"…"}]`,

  general:
    `Generate exactly 3 "did you really understand it?" questions about this article, each with a sample answer.
One tests the main argument, one a surprising detail, one the real-world "so what".
Sample answers: 1-2 sentences, concise and specific to the article. Natural prose, no bullets.
Return ONLY a JSON array: [{"question":"…","answer":"…"},{"question":"…","answer":"…"},{"question":"…","answer":"…"}]`,
};

// ── Generate article connections ───────────────────────────────────────────
async function generateArticleConnections({ apiKey, currentArticle, knowledgeGraph }) {
  const pastArticles = (knowledgeGraph.articles || []).filter(a => a.url !== currentArticle.url);
  if (pastArticles.length < 2) return [];

  // Build context with past articles: title, summary, concepts, and up to 3 sample Q&A if available
  const pastContext = await Promise.all(pastArticles.map(async (article) => {
    const data = await getArticleData(article.url);
    const qa = (data?.qa || []).slice(0, 3).map(pair => `Q: ${pair.q}\nA: ${pair.a}`).join("\n\n");
    return `Title: "${article.title}"
Summary: ${article.summary}
Concepts: ${article.concepts.join(", ")}
${qa ? `\nSample Q&A:\n${qa}` : ""}`;
  }));

  const prompt = `You are Reading Copilot. A reader just finished this article:

Title: "${currentArticle.title}"
Text (first 3000 chars): ${currentArticle.text}

They have previously read these articles:

${pastContext.join("\n\n---\n\n")}

Find the top 3 most similar or intellectually connected past articles. For each, explain HOW they connect — not just topic overlap, but the specific intellectual bridge between ideas.

For each connection, specify the connectionType: "same-problem" (both tackle the same underlying challenge), "contrasting-view" (present opposing perspectives), "builds-on" (one extends or builds on ideas from the other), or "applies-to" (ideas from one apply to the other).

Return ONLY a valid JSON array with up to 3 items:
[
  {"articleTitle":"...", "articleUrl":"...", "connectionType":"same-problem|contrasting-view|builds-on|applies-to", "connectionInsight":"1-2 sentences explaining the specific intellectual bridge"},
  ...
]`;

  const res = await callClaude({
    apiKey,
    systemParts: [{ type: "text", text: "You are Reading Copilot. Help readers discover connections between articles they've read." }],
    messages: [{ role: "user", content: prompt }],
    maxTokens: 1024,
  });

  const data = await res.json();
  try {
    const raw = data.content[0].text.trim();
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, ""));
    if (Array.isArray(parsed)) {
      return parsed.filter(c => c.articleTitle && c.articleUrl && c.connectionType && c.connectionInsight).slice(0, 3);
    }
  } catch (_) {}
  return [];
}

// ── HTML/PDF text fetching helpers ───────────────────────────────────────────

/** Strip HTML tags → plain text, decode common entities. */
function htmlToText(html, maxChars = 20000) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/** Fetch a web page and return its visible text (stripped of HTML tags). */
async function fetchPageText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "";
    const html = await res.text();
    return htmlToText(html, 60000);
  } catch (_) {
    return "";
  }
}

/**
 * Detect whether a URL points to a PDF file (by extension or known PDF CDN patterns).
 */
function isPDFUrl(url) {
  try {
    const { pathname, hostname } = new URL(url);
    if (pathname.toLowerCase().endsWith(".pdf")) return true;
    // arxiv PDF viewer
    if (hostname.includes("arxiv.org") && pathname.startsWith("/pdf/")) return true;
    // PubMed / PMC PDF
    if (hostname.includes("ncbi.nlm.nih.gov") && pathname.includes("/pdf/")) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Try to extract readable text from a PDF ArrayBuffer using a minimal plain-text scan.
 * Works only for PDFs whose content streams are NOT compressed (rare in practice).
 * Returns "" if extraction yields nothing useful.
 */
function extractTextFromPDFBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  // Quick check: must start with %PDF
  if (bytes[0] !== 0x25 || bytes[1] !== 0x50) return "";

  let raw = "";
  for (let i = 0; i < Math.min(bytes.length, 2_000_000); i++) {
    const b = bytes[i];
    if (b >= 32 && b < 127) raw += String.fromCharCode(b);
    else if (b === 10 || b === 13) raw += "\n";
  }

  // Extract text from BT...ET blocks (uncompressed streams only)
  const blocks = raw.match(/BT[\s\S]*?ET/g) || [];
  const parts = [];
  for (const block of blocks) {
    const items = block.match(/\(([^)]{1,200})\)\s*(?:Tj|'|")/g) || [];
    for (const item of items) {
      const s = item.match(/\(([^)]*)\)/)?.[1];
      if (s) parts.push(s.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"));
    }
    // TJ arrays
    const arrays = block.match(/\[([^\]]+)\]\s*TJ/g) || [];
    for (const arr of arrays) {
      const strings = arr.match(/\(([^)]{1,200})\)/g) || [];
      for (const s of strings) parts.push(s.slice(1, -1));
    }
  }

  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? text.slice(0, 60000) : "";
}

/**
 * Try every available strategy to get readable text for a PDF URL.
 * Returns { text, title } where text may be "" if nothing worked.
 */
async function fetchPDFText(url) {
  const parsedUrl = new URL(url);
  const { hostname, pathname } = parsedUrl;

  // ── arxiv: try HTML version → abstract page ────────────────────────────────
  if (hostname.includes("arxiv.org")) {
    const idMatch = pathname.match(/\/(?:pdf|abs|html)\/([^/?#v]+)/);
    const paperId  = idMatch?.[1];
    if (paperId) {
      // Try semantic HTML version first (papers from ~2023+)
      try {
        const htmlRes = await fetch(`https://arxiv.org/html/${paperId}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (htmlRes.ok) {
          const html  = await htmlRes.text();
          const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|.*$/, "").trim() || "";
          const text  = htmlToText(html);
          if (text.length > 500) return { text, title };
        }
      } catch (_) {}

      // Fall back to abstract page (always available; has abstract + intro text)
      try {
        const absRes = await fetch(`https://arxiv.org/abs/${paperId}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (absRes.ok) {
          const html  = await absRes.text();
          const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s*\|.*$/, "").trim() || "";
          const text  = htmlToText(html);
          if (text.length > 200) return { text, title: title || `arXiv:${paperId}` };
        }
      } catch (_) {}
    }
  }

  // ── Generic: fetch PDF bytes and try plain-text extraction ─────────────────
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        // Server returned HTML (e.g. login wall) — extract that
        const html = await res.text();
        return { text: htmlToText(html), title: "" };
      }
      const buffer = await res.arrayBuffer();
      const text   = extractTextFromPDFBytes(buffer);
      if (text.length > 200) return { text, title: "" };
    }
  } catch (_) {}

  return { text: "", title: "" };
}

async function generatePreReadingQuestions({ apiKey, articleText, articleTitle, purpose, jobContext = "" }) {
  const systemParts = [
    {
      type: "text",
      text: `You are Reading Copilot. Article: "${articleTitle}"\n\n${articleText}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  let prompt = PURPOSE_PROMPTS[purpose] || PURPOSE_PROMPTS.general;
  // If job postings were provided, override with a targeted interview prompt
  if (purpose === "interview" && jobContext) {
    prompt = `You are helping a candidate prepare for a specific job interview.

JOB POSTING(S):
${jobContext}

The candidate just read the article above. Generate exactly 3 interview questions that:
1. Explicitly reference a specific requirement, responsibility, or skill mentioned in the job posting
2. Ask the candidate to apply or connect the article's insights to that specific job requirement
3. Start with a verb: "How would you…", "Describe a time when…", "What would you do if…"

Each question MUST mention or directly relate to something specific from the job posting (not just the article).

Sample answers: 2-3 sentences connecting the article's key insight to the specific job requirement mentioned. Be concrete — name the requirement and the insight.

Return ONLY a JSON array: [{"question":"…","answer":"…"},{"question":"…","answer":"…"},{"question":"…","answer":"…"}]`;
  }
  const res = await callClaude({
    apiKey,
    systemParts,
    messages: [{ role: "user", content: prompt }],
  });

  const data = await res.json();
  const raw = data.content[0].text.trim();

  // Try parsing new {question, answer} format first, then fallback to string array
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, ""));
    if (Array.isArray(parsed)) {
      if (parsed[0]?.question) {
        // New format: [{question, answer}]
        return {
          questions: parsed.map(p => String(p.question || "").trim()).filter(Boolean),
          answers:   parsed.map(p => String(p.answer   || "").trim()),
        };
      }
      // Old fallback: ["Q1","Q2","Q3"]
      return { questions: parsed.filter(Boolean), answers: [] };
    }
  } catch (_) {}

  // Last resort: extract lines that look like questions
  const questions = raw
    .split("\n")
    .map((l) => l.replace(/^[\d\.\-\*"]+\s*/, "").trim())
    .filter((l) => l.length > 10 && !l.startsWith("{"))
    .slice(0, 3);
  return { questions, answers: [] };
}

// ── Streaming chat ────────────────────────────────────────────────────────────

/**
 * Streams the assistant reply and pushes chunks to the sidebar via a port.
 * Returns { answer, concepts } when complete.
 */
async function streamChat({ apiKey, articleText, articleTitle, messages, port }) {
  const systemParts = buildSystemParts(articleText, articleTitle);

  const res = await callClaude({ apiKey, systemParts, messages, stream: true, maxTokens: 2048 });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const lines = decoder
      .decode(value)
      .split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes('"type":"message_stop"'));

    for (const line of lines) {
      try {
        const event = JSON.parse(line.slice(6));
        const delta = event.delta?.text || "";
        if (delta) {
          fullText += delta;
          // Strip CONCEPTS line from the live display
          const display = fullText.replace(/\nCONCEPTS:.*$/ms, "").trim();
          port?.postMessage({ type: "STREAM_CHUNK", text: display });
        }
      } catch (_) {}
    }
  }

  // Parse CONCEPTS
  const match = fullText.match(/\nCONCEPTS:\s*(.+)$/m);
  const concepts = match
    ? match[1].split(",").map((c) => c.trim()).filter(Boolean)
    : [];
  const answer = fullText.replace(/\nCONCEPTS:.*$/ms, "").trim();

  return { answer, concepts };
}

// ── Robust JSON extraction for summary responses ─────────────────────────────
// The AI sometimes wraps JSON in markdown fences, adds CONCEPTS lines, or returns
// malformed JSON. This function tries multiple strategies to extract summary + concepts.
function extractSummaryData(raw) {
  let text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();

  // Try to find and parse a JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary:        (parsed.summary || "").replace(/\\n/g, "\n").trim(),
        concepts:       Array.isArray(parsed.concepts) ? parsed.concepts.map(c => String(c).trim()).filter(Boolean) : [],
        readerAnalysis: parsed.readerAnalysis || null,
      };
    } catch (_) {}
  }

  // Regex field extraction fallback
  const summaryMatch  = text.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const conceptsMatch = text.match(/"concepts"\s*:\s*\[([^\]]*)\]/);
  if (summaryMatch) {
    const summary = summaryMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
    let concepts = [];
    if (conceptsMatch) {
      try { concepts = JSON.parse(`[${conceptsMatch[1]}]`).map(c => String(c).trim()).filter(Boolean); } catch (_) {}
    }
    return { summary, concepts, readerAnalysis: null };
  }

  // Last resort: strip JSON syntax, display as plain text
  const cleaned = text
    .replace(/"concepts"\s*:\s*\[[^\]]*\]/g, "")
    .replace(/"readerAnalysis"\s*:\s*\{[^}]*\}/g, "")
    .replace(/"summary"\s*:\s*/g, "")
    .replace(/^\{/, "").replace(/\}$/, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\nCONCEPTS:.*$/m, "")
    .trim();
  return { summary: cleaned, concepts: [], readerAnalysis: null };
}

// ── Article complete: summary + knowledge graph update ────────────────────────

async function handleArticleComplete({ apiKey, url, articleText, articleTitle, qaHistory: passedQA }) {
  const articleData = (await getArticleData(url)) || {};
  // Prefer Q&A passed directly from sidebar (sidebar saves to conv:url:purpose, not article:url.qa)
  const qaHistory = (passedQA && passedQA.length > 0) ? passedQA : (articleData.qa || []);

  // Build summary prompt
  const systemParts = buildSystemParts(articleText, articleTitle);
  // Check if we already have a cached article summary — skip regenerating it
  // (shared across readers of the same article)
  const cachedSummary = articleData.summary;
  const cachedConcepts = articleData.concepts;
  const hasCachedSummary = cachedSummary && cachedSummary.length > 20;

  let summary = cachedSummary || "";
  let concepts = cachedConcepts || [];
  let readerAnalysis = null;

  // Only call AI if: no cached summary OR there are Q&A to analyze
  const hasQA = qaHistory.length > 0;
  if (!hasCachedSummary || hasQA) {
    const qaContext = hasQA
      ? `\n\nHere is the reader's Q&A during this session:\n${qaHistory
          .map((qa, i) => `Q${i + 1}: ${qa.q}\nA${i + 1}: ${(qa.a || "").slice(0, 600)}`)
          .join("\n\n")}`
      : "";

    const readerAnalysisSpec = `"readerAnalysis": {
  "overview": "1 tight sentence to the reader (use you/your): the sharpest observation about their thinking pattern this session — specific, not generic. Max 25 words.",
  "focusAreas": ["2-3 short theme labels (5-8 words each) the reader genuinely cared about"],
  "gaps": ["2 items max. Infer from question patterns what real-world habit the reader may be missing. Give a concrete offline action they can take this week — NOT advice on how to ask better questions. Format: 'Pattern: [≤10 words]. Action: [≤15 words, starts with a verb].' Example: 'Pattern: Always asks for implications, never connects to own work. Action: Pick one current project and find three parallels today.'"]
}`;

    const promptParts = hasCachedSummary
      // Article already summarized — only generate reader analysis
      ? `The article has already been summarized. Act as a reading coach analyzing the Q&A session below.${qaContext}

Look for PATTERNS in HOW the reader asks. Suggestions must be real-world actions (what to do this week in work/life), NOT advice on how to ask better questions. Infer the missing habit from their patterns and give one specific, verb-led action. Keep each gap entry under 25 words total.

Return ONLY valid JSON:
{${readerAnalysisSpec}}`
      // Full summary + reader analysis
      : `Summarize this article and analyze the reader's engagement as a reading coach.${qaContext}

Return ONLY valid JSON:
{"summary": "A structured analysis in this exact format — each on its own line:\nBackground: [1 sentence: what field/context this work lives in]\nProblem: [1 sentence: the specific gap or challenge it addresses]\nApproach: [2 sentences: how it tackles the problem, key methods or ideas]\nConclusion: [1 sentence: what was found or achieved]\nImplications: [1 sentence: what this opens up or means for the reader]", "concepts": ["concept1", "concept2"], ${hasQA ? readerAnalysisSpec : '"readerAnalysis": null'}}`;

    const res = await callClaude({
      apiKey,
      systemParts,
      messages: [{ role: "user", content: promptParts }],
      maxTokens: hasQA ? 900 : 512,
    });

    const data = await res.json();
    const rawText = data.content[0].text.trim();
    const parsed = extractSummaryData(rawText);
    if (!hasCachedSummary) {
      summary = parsed.summary || summary;
      concepts = parsed.concepts?.length ? parsed.concepts : concepts;
    }
    readerAnalysis = parsed.readerAnalysis || null;
  }

  // Persist article record
  const updatedArticle = {
    ...articleData,
    url,
    title: articleTitle,
    summary,
    concepts,
    completedAt: Date.now(),
  };
  await saveArticleData(url, updatedArticle);

  // Update knowledge graph
  const graph = await getKnowledgeGraph();
  graph.sessionCount = (graph.sessionCount || 0) + 1;

  const articleEntry = { url, title: articleTitle, summary, concepts };
  const idx = graph.articles.findIndex((a) => a.url === url);
  if (idx >= 0) graph.articles[idx] = articleEntry;
  else graph.articles.push(articleEntry);

  // Update concept nodes
  concepts.forEach((concept) => {
    if (!graph.concepts[concept]) graph.concepts[concept] = { articles: [], relatedConcepts: [] };
    if (!graph.concepts[concept].articles.includes(url)) {
      graph.concepts[concept].articles.push(url);
    }
  });

  // Cross-article graph after threshold
  let crossGraph = null;
  if (graph.sessionCount >= CROSS_GRAPH_THRESHOLD && graph.articles.length >= 3) {
    crossGraph = await generateCrossArticleGraph({ apiKey, articles: graph.articles });
    graph.crossArticleInsights = crossGraph;
  }

  await saveKnowledgeGraph(graph);

  return { summary, concepts, crossGraph, readerAnalysis };
}

// ── Cross-article knowledge graph ─────────────────────────────────────────────

async function generateCrossArticleGraph({ apiKey, articles }) {
  const summaries = articles
    .map((a, i) => `Article ${i + 1}: "${a.title}"\nSummary: ${a.summary}\nConcepts: ${a.concepts.join(", ")}`)
    .join("\n\n---\n\n");

  const res = await callClaude({
    apiKey,
    systemParts: [
      {
        type: "text",
        text: "You are Reading Copilot. Build a cross-article knowledge graph for a reader based on their reading history.",
      },
    ],
    messages: [
      {
        role: "user",
        content: `The reader has finished ${articles.length} articles:\n\n${summaries}\n\nIdentify:\n1. Concepts that appear across multiple articles\n2. Thematic connections between articles\n3. 3 suggested next reading topics\n\nReturn ONLY valid JSON:\n{"connectedConcepts":[{"concept":"...","articleIndices":[0,1],"insight":"..."}],"thematicLinks":["..."],"suggestedTopics":["..."]}`,
      },
    ],
    maxTokens: 1024,
  });

  const data = await res.json();
  try {
    return JSON.parse(data.content[0].text.trim());
  } catch (_) {
    return { connectedConcepts: [], thematicLinks: [], suggestedTopics: [] };
  }
}

// ── Port-based messaging (for streaming) ─────────────────────────────────────

const ports = new Map(); // tabId → port

chrome.runtime.onConnect.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  if (port.name === "sidebar") {
    if (tabId) ports.set(tabId, port);
    port.onDisconnect.addListener(() => {
      if (tabId) ports.delete(tabId);
    });
  }
  if (port.name === "sidebar-lifecycle") {
    port.onDisconnect.addListener(async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "SHOW_RESUME_CARD" }).catch(() => {});
        }
      } catch (e) {}
    });
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // OPEN_SIDEBAR must be handled synchronously (before any await) to preserve
  // the user gesture context required by chrome.sidePanel.open() in MV3.
  if (msg.type === "OPEN_SIDEBAR") {
    if (sender.tab?.id) {
      const tabId = sender.tab.id;
      // Both calls are fire-and-forget (no await) so they run synchronously
      // inside the user-gesture context. setOptions ensures the panel is
      // enabled for this tab; open() must be in the same sync call stack.
      chrome.sidePanel.setOptions({ tabId, enabled: true, path: "sidebar/sidebar.html" }).catch(() => {});
      chrome.sidePanel.open({ tabId }).catch((e) => console.warn("sidePanel.open failed:", e.message));
    }
    sendResponse({ ok: true });
    return;
  }

  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep async channel open
});

async function handleMessage(msg, sender) {
  const { apiKey, aiMode } = await chrome.storage.local.get(["apiKey", "aiMode"]);

  switch (msg.type) {

    case "REGISTER_ARTICLE": {
      let articleText  = msg.text  || "";
      let articleTitle = msg.title || "";

      // ── PDF fallback: content scripts can't read Chrome's PDF viewer DOM ──────
      // If the URL looks like a PDF and we got no (or very little) text,
      // attempt to fetch readable text from an HTML equivalent page.
      if (articleText.trim().length < 200 && isPDFUrl(msg.url)) {
        try {
          const fetched = await fetchPDFText(msg.url);
          if (fetched.text.length > articleText.length) {
            articleText  = fetched.text;
          }
          if (fetched.title && !articleTitle) {
            articleTitle = fetched.title;
          }
        } catch (_) {}
      }

      const article = {
        url:   msg.url,
        title: articleTitle || msg.title,
        text:  articleText,
        tabId: sender.tab?.id,
      };
      // Save as current article and also index by tabId for tab-switching lookup
      const { allArticles = {}, currentArticle: prevArticle } =
        await chrome.storage.local.get(["allArticles", "currentArticle"]);
      allArticles[sender.tab?.id] = article;

      const updates = { currentArticle: article, allArticles };

      // If this tab was already showing a DIFFERENT article, signal the sidebar
      // to re-initialize. This covers in-tab navigation (onActivated only fires
      // when the user switches tabs, not when they navigate within a tab).
      if (
        prevArticle &&
        prevArticle.tabId === sender.tab?.id &&
        prevArticle.url !== msg.url
      ) {
        updates.tabSwitchedSignal = { tabId: sender.tab?.id, url: msg.url, ts: Date.now() };
      }

      await chrome.storage.local.set(updates);
      return { ok: true };
    }

    case "GET_CURRENT_ARTICLE": {
      const data = await chrome.storage.local.get("currentArticle");
      return data.currentArticle || null;
    }

    case "GENERATE_QUESTIONS": {
      if (!apiKey) throw new Error("no_api_key");
      // For interview mode: optionally fetch job posting pages
      let jobContext = "";
      if (msg.purpose === "interview" && msg.jobUrls?.length) {
        const fetched = await Promise.all(
          msg.jobUrls.filter(Boolean).map(url => fetchPageText(url))
        );
        jobContext = fetched.filter(Boolean).join("\n\n---\n\n");
      }
      const result = await generatePreReadingQuestions({
        apiKey,
        articleText: msg.articleText,
        articleTitle: msg.articleTitle,
        purpose: msg.purpose,
        jobContext,
      });
      // result is { questions: [...], answers: [...] }
      return result;
    }

    case "CHAT": {
      // WebLLM & Ollama handle chat in sidebar — only apikey routes here
      if (!apiKey) throw new Error("no_api_key");
      const port = ports.get(msg.tabId) || null;
      const { answer, concepts, insight } = await streamChat({
        apiKey,
        articleText: msg.articleText,
        articleTitle: msg.articleTitle,
        messages: msg.messages,
        port,
      });
      return { answer, concepts, insight };
    }

    case "ARTICLE_COMPLETE": {
      // Guard: article text must be present to generate a meaningful summary
      let text = (msg.articleText || "").trim();
      // If text is too short and URL is a PDF, try fetching now (sidebar may have
      // registered the article before the service worker could fetch PDF text)
      if (text.length < 100 && msg.url && isPDFUrl(msg.url)) {
        try {
          const fetched = await fetchPDFText(msg.url);
          if (fetched.text.length > text.length) text = fetched.text;
        } catch (_) {}
      }
      if (text.length < 100) {
        throw new Error(
          isPDFUrl(msg.url)
            ? "Couldn't extract text from this PDF. For arXiv papers, try opening the Abstract page (arxiv.org/abs/…) instead."
            : "Article text is too short or missing. Make sure you're on an article page and try again."
        );
      }
      // Summary generation: use apikey if available, else skip AI summary
      if (!apiKey) {
        const graph = await getKnowledgeGraph();
        graph.sessionCount = (graph.sessionCount || 0) + 1;
        const entry = { url: msg.url, title: msg.articleTitle, summary: "", concepts: [] };
        const idx = graph.articles.findIndex((a) => a.url === msg.url);
        if (idx >= 0) graph.articles[idx] = entry; else graph.articles.push(entry);
        await saveKnowledgeGraph(graph);
        return { summary: "", concepts: [], crossGraph: null };
      }
      const result = await handleArticleComplete({
        apiKey,
        url: msg.url,
        articleText: msg.articleText,
        articleTitle: msg.articleTitle,
        qaHistory: msg.qaHistory || [],
      });
      return result;
    }

    case "SAVE_QA": {
      const existing = (await getArticleData(msg.url)) || {};
      const qa = existing.qa || [];
      qa.push({ q: msg.question, a: msg.answer, concepts: msg.concepts, ts: Date.now() });
      await saveArticleData(msg.url, { ...existing, qa });
      return { ok: true };
    }

    case "GET_KNOWLEDGE_GRAPH": {
      return await getKnowledgeGraph();
    }

    case "FIND_CONNECTIONS": {
      if (!apiKey) return { connections: [] };
      const graph = await getKnowledgeGraph();
      if (!graph.articles || graph.articles.length < 2) return { connections: [] };
      const connections = await generateArticleConnections({
        apiKey,
        currentArticle: { url: msg.url, title: msg.title, text: (msg.text || "").slice(0, 3000) },
        knowledgeGraph: graph,
      });
      return { connections };
    }

    default:
      throw new Error(`Unknown message type: ${msg.type}`);
  }
}

// ── Toolbar click: open side panel ───────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Tab switch: notify sidebar that the active article may have changed ───────
// When the user switches tabs, update currentArticle to the new tab's registered
// article (if any), then set a storage signal so the sidebar re-evaluates.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const { allArticles } = await chrome.storage.local.get("allArticles");
  if (!allArticles) return;

  // Find the article registered for this tab
  const tabArticle = Object.values(allArticles).find(a => a.tabId === tabId);
  if (tabArticle) {
    await chrome.storage.local.set({
      currentArticle: tabArticle,
      tabSwitchedSignal: { tabId, url: tabArticle.url, ts: Date.now() },
    });
  } else {
    // Tab has no registered article — signal sidebar to re-check
    await chrome.storage.local.set({
      tabSwitchedSignal: { tabId, url: null, ts: Date.now() },
    });
  }
});

// ── URL change within the same tab (full navigation or SPA) ──────────────────
// Catches cases where the user navigates within the same tab.
// We clear the old article registration immediately so the sidebar shows
// "no article" until the content script registers the new page.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || !changeInfo.url) return;

  const { allArticles = {}, currentArticle } = await chrome.storage.local.get(["allArticles", "currentArticle"]);

  // Only act if this is the tab the sidebar was showing
  if (currentArticle?.tabId !== tabId) return;
  // Only act if the URL actually changed
  if (currentArticle?.url === changeInfo.url) return;

  // Remove stale article entry for this tab so init() sees a fresh state
  delete allArticles[tabId];
  await chrome.storage.local.set({
    allArticles,
    tabSwitchedSignal: { tabId, url: changeInfo.url, ts: Date.now() },
  });
});
