/**
 * Reading Copilot — Sidebar
 *
 * AI backend routing:
 *   "webllm"  → model runs in-browser via WebGPU (zero cost, first-run download ~2GB)
 *   "ollama"  → calls http://localhost:11434 (user runs Ollama separately)
 *   "apikey"  → calls Anthropic API via service worker (existing behaviour)
 *
 * State machine:
 *   loading → no-mode-set | downloading (webllm) | no-article | purpose
 *   purpose → generating-questions → questions → chat ↔ summary
 */

"use strict";

// Connect a lifecycle port immediately — service worker will detect disconnect when sidebar closes
chrome.runtime.connect({ name: "sidebar-lifecycle" });

// ── WebLLM (lazy-imported only when mode === "webllm") ────────────────────────
let webllmEngine = null;
const WEBLLM_MODEL = "Phi-3.5-mini-instruct-q4f16_1-MLC"; // ~2.2 GB, good instruction following

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s = "") =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function msg(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  mode: null,          // "webllm" | "ollama" | "apikey"
  article: null,
  purpose: null,
  questions: [],
  conversation: [],
  msgHistory: [],
  allConcepts: [],
  pendingSelection: null,
  pendingLaymen: false,     // auto-send "explain simply" after selection
  streaming: false,
  streamText: "",
  summaryData: null,
  jobUrls: [],         // interview mode: job posting URLs
  ivSessionId: null,     // active interview sub-session ID (null = no session yet)
  ivMeta: null,          // { sessions:[{id,label,ts,updatedAt}], activeId } for this article
  questionAnswers: [],   // sample answers parallel to state.questions (apikey mode only)
  connections: null,     // past article connections: null = not checked, [] = no connections, [{...}] = found
  questionHistory: [],   // interview mode: [{ts, questions, jobUrls}] archived past question sets
  view: "loading",
  historyReturnView: "purpose",  // which view to go back to from History
};

// ── Port for API-key streaming (service worker → sidebar) ─────────────────────
let swPort = null;

function ensureSwPort() {
  if (swPort) return;
  swPort = chrome.runtime.connect({ name: "sidebar" });
  swPort.onMessage.addListener((m) => {
    if (m.type === "STREAM_CHUNK" && state.streaming) {
      state.streamText = m.text;
      updateStreamBubble();
    }
  });
  swPort.onDisconnect.addListener(() => { swPort = null; });
}

// ── Init ──────────────────────────────────────────────────────────────────────
// Register storage listener once at startup (not inside init, which may run multiple times)
chrome.storage.onChanged.addListener(onStorageChange);

async function init() {
  _initComplete = false;
  render("loading");

  // Clear any stale articleCompleteSignal left from a previous session
  await chrome.storage.local.remove("articleCompleteSignal");

  const { aiMode, apiKey, ollamaUrl } = await chrome.storage.local.get([
    "aiMode", "apiKey", "ollamaUrl",
  ]);

  state.mode = aiMode || null;

  // Guard: no mode configured yet
  if (!state.mode) { render("no-mode-set"); return; }

  // Guard: apikey mode but no key
  if (state.mode === "apikey" && !apiKey) { render("no-key"); return; }

  // WebLLM: ensure engine is ready before anything else
  if (state.mode === "webllm") {
    if (!webllmEngine) {
      await initWebLLM();   // shows download progress internally
      if (!webllmEngine) return; // user may have switched away
    }
  }

  // Get current article
  const article = await msg("GET_CURRENT_ARTICLE");
  if (!article || !article.text) { render("no-article"); return; }
  state.article = article;

  // Pick up pending text selection and/or purpose chosen in the page card
  const stored = await chrome.storage.local.get(["pendingSelection", "pendingPurpose", "pendingLaymen"]);
  if (stored.pendingSelection) {
    state.pendingSelection = stored.pendingSelection;
    await chrome.storage.local.remove("pendingSelection");
  }
  if (stored.pendingLaymen) {
    state.pendingLaymen = true;
    await chrome.storage.local.remove("pendingLaymen");
  }
  if (stored.pendingPurpose) {
    state.purpose = stored.pendingPurpose;
    await chrome.storage.local.remove("pendingPurpose");
    await chrome.storage.local.set({ [`purpose:${article.url}`]: state.purpose });
  }

  // Restore saved purpose + questions + conversation + summary for this URL
  const pKey        = `purpose:${article.url}`;
  const sKey        = `summary:${article.url}`;
  const conceptsKey = `concepts:${article.url}`;

  const globalSaved = await chrome.storage.local.get([pKey, sKey, conceptsKey]);
  if (globalSaved[sKey])        state.summaryData = globalSaved[sKey];
  if (globalSaved[conceptsKey]) state.allConcepts = globalSaved[conceptsKey];

  // Determine active purpose (pendingPurpose was already applied above)
  const activePurpose = state.purpose || globalSaved[pKey];

  if (activePurpose) {
    state.purpose = activePurpose;

    // ── Interview mode: use iv_meta to load the active session ────────────────
    if (activePurpose === "interview") {
      let ivMeta = await loadIVMeta(article.url);
      ivMeta = await migrateOldIVSession(article.url, ivMeta);
      state.ivMeta = ivMeta;

      if (ivMeta && ivMeta.activeId) {
        state.ivSessionId = ivMeta.activeId;
        const activeSession = ivMeta.sessions.find(s => s.id === ivMeta.activeId);
        state.jobUrls = activeSession?.jobUrls || [];
        const { qKey, convKey, histKey } = getIVConvKeys(article.url, ivMeta.activeId);
        const aKey      = `answers:${article.url}:interview:${ivMeta.activeId}`;
        const qHistKey  = getQHistKey(article.url, ivMeta.activeId);
        const purposeSaved = await chrome.storage.local.get([qKey, convKey, histKey, aKey, qHistKey]);
        state.questionHistory = purposeSaved[qHistKey] || [];
        if (purposeSaved[qKey]) {
          state.questions       = purposeSaved[qKey];
          state.questionAnswers = purposeSaved[aKey] || [];
          if (purposeSaved[convKey]?.length > 1) {
            state.conversation = purposeSaved[convKey];
            state.msgHistory   = purposeSaved[histKey] || [];
          } else {
            state.conversation = [{ role: "ai", text: buildQuestionsMessage(state.purpose, state.questions), concepts: [] }];
            state.msgHistory   = [];
          }
          await loadAhaMoments();
          _initComplete = true;
          render("chat");
        } else {
          _initComplete = true;
          await doGenerateQuestions();
        }
      } else {
        // No iv_meta → go to purpose screen to start fresh
        _initComplete = true;
        render("purpose");
      }

    // ── All other purposes ─────────────────────────────────────────────────────
    } else {
      const qKey    = `questions:${article.url}:${activePurpose}`;
      const convKey = `conv:${article.url}:${activePurpose}`;
      const histKey = `hist:${article.url}:${activePurpose}`;
      const aKey    = `answers:${article.url}:${activePurpose}`;
      const purposeSaved = await chrome.storage.local.get([qKey, convKey, histKey, aKey]);

      if (purposeSaved[qKey]) {
        state.questions       = purposeSaved[qKey];
        state.questionAnswers = purposeSaved[aKey] || [];
        if (purposeSaved[convKey]?.length > 1) {
          state.conversation = purposeSaved[convKey];
          state.msgHistory   = purposeSaved[histKey] || [];
        } else {
          state.conversation = [{ role: "ai", text: buildQuestionsMessage(state.purpose, state.questions), concepts: [] }];
          state.msgHistory   = [];
        }
        await loadAhaMoments();
        _initComplete = true;
        render("chat");
        loadArticleConnections();
      } else {
        _initComplete = true;
        await doGenerateQuestions();
      }
    }
  } else {
    _initComplete = true;
    render("purpose");
  }

}

// ── Reading History ───────────────────────────────────────────────────────────
const HISTORY_KEY    = "readingHistory";
const HISTORY_MAX    = 200;

async function saveReadingHistory(article) {
  if (!article?.url || !article?.title) return;
  const { readingHistory: existing = [] } = await chrome.storage.local.get(HISTORY_KEY);
  // Remove any previous entry for same URL, then prepend updated entry
  const filtered = existing.filter(e => e.url !== article.url);
  const entry = { title: article.title, url: article.url, ts: Date.now() };
  const updated = [entry, ...filtered].slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: updated });
}

function fmtHistoryDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7)  return `${diffDays} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderHistory() {
  // Loaded asynchronously — placeholder first, then fill
  const wrap = document.createElement("div");
  wrap.className = "screen";
  wrap.innerHTML = `
    <div class="history-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Reading History</span></div>
        <button class="icon-btn" id="btn-history-back" style="font-size:11px;padding:3px 7px;border-radius:6px">← Back</button>
      </div>
      <div class="history-list" id="history-list">
        <div style="padding:32px 16px;text-align:center;color:#9ca3af;font-size:13px">Loading…</div>
      </div>
    </div>`;

  chrome.storage.local.get(HISTORY_KEY).then(({ readingHistory = [] }) => {
    const list = wrap.querySelector("#history-list");
    if (!list) return;
    if (readingHistory.length === 0) {
      list.innerHTML = `<div style="padding:48px 16px;text-align:center;color:#9ca3af;font-size:13px">No articles yet.<br>Start reading to build your history.</div>`;
      return;
    }
    list.innerHTML = readingHistory.map((entry, i) => `
      <div class="history-item" data-url="${esc(entry.url)}" data-i="${i}">
        <div class="history-item-title">${esc(entry.title)}</div>
        <div class="history-item-meta">${esc(fmtHistoryDate(entry.ts))}</div>
      </div>`).join("");

    list.querySelectorAll(".history-item").forEach(el => {
      el.addEventListener("click", () => {
        const url = el.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });
  });

  // Back button
  requestAnimationFrame(() => {
    wrap.querySelector("#btn-history-back")?.addEventListener("click", () => {
      render(state.historyReturnView || "purpose");
    });
  });

  return wrap;
}

function buildQuestionsMessage(purpose, questions) {
  const label = { interview: "interview prep", learning: "learning", research: "research", general: "general reading" }[purpose] || purpose;
  return `Here are 3 questions for your **${label}**:\n\n` +
    questions.map((q, i) => `**${i + 1}.** ${q}`).join("\n\n") +
    "\n\nAsk me anything — I have the full article as context.";
}

function onStorageChange(changes) {
  if (changes.pendingSelection?.newValue) {
    state.pendingSelection = changes.pendingSelection.newValue;
    chrome.storage.local.remove("pendingSelection");
    if (state.view !== "chat") render("chat");
    else prefillSelectionInput();
  }
  if (changes.pendingLaymen?.newValue) {
    state.pendingLaymen = true;
    chrome.storage.local.remove("pendingLaymen");
    if (state.view !== "chat") render("chat");
    // if already in chat, laymen auto-send fires via attachHandlers when re-rendered
    // but if already in chat: trigger directly
    else if (state.pendingSelection) autoSendLaymen();
  }
  if (changes.articleCompleteSignal?.newValue) {
    chrome.storage.local.remove("articleCompleteSignal");
    // Only react after init() has fully restored state (incl. summaryData).
    // If we process before init completes, summaryData is null and the guard fails.
    if (_initComplete && state.article && ["purpose","questions","chat"].includes(state.view)) {
      onArticleComplete(changes.articleCompleteSignal.newValue);
    }
  }
  // Re-init when user changes AI mode in Options (sidebar might be open already)
  if (changes.aiMode?.newValue && changes.aiMode.newValue !== state.mode) {
    webllmEngine = null; // reset any cached engine
    init();
  }
  // Re-init when user switches tabs — load the new tab's article
  if (changes.tabSwitchedSignal?.newValue) {
    chrome.storage.local.remove("tabSwitchedSignal");
    const newUrl = changes.tabSwitchedSignal.newValue.url;
    // Only re-init if the tab's article is different from what's currently shown
    if (newUrl !== state.article?.url) {
      // Save current conversation state before wiping
      state.article          = null;
      state.purpose          = null;
      state.questions        = [];
      state.conversation     = [];
      state.msgHistory       = [];
      state.allConcepts      = [];
      state.summaryData      = null;
      state.pendingSelection = null;
      state.pendingLaymen    = false;
      state.questionHistory  = [];
      state.ivSessionId      = null;
      state.ivMeta           = null;
      state.questionAnswers  = [];
      state.connections      = null;
      _summaryGenerating     = false;
      init();
    }
  }
}

// ── WebLLM initialisation (bundled locally, downloads model weights at runtime) ─
async function initWebLLM() {
  render("downloading");

  try {
    const { CreateMLCEngine } = await import("./webllm.bundle.js");
    const { webllmModel } = await chrome.storage.local.get("webllmModel");
    const model = webllmModel || "Phi-3.5-mini-instruct-q4f16_1-MLC";

    webllmEngine = await CreateMLCEngine(model, {
      initProgressCallback: ({ progress, text }) => {
        const pct   = Math.round((progress || 0) * 100);
        const bar   = $("#dl-bar");
        const info  = $("#dl-info");
        const pctEl = $("#dl-pct");
        if (bar)   bar.style.width    = `${pct}%`;
        if (info)  info.textContent   = text || "Loading model…";
        if (pctEl) pctEl.textContent  = `${pct}%`;
      },
    });
  } catch (e) {
    renderError(`WebLLM failed: ${e.message}. Try Ollama or API Key mode instead.`);
    webllmEngine = null;
  }
}

// ── WebLLM chat (streams via callback) ───────────────────────────────────────
async function chatWebLLM({ systemPrompt, messages, onChunk }) {
  const stream = await webllmEngine.chat.completions.create({
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: true,
    max_tokens: 1024,
  });

  let fullText = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || "";
    if (delta) {
      fullText += delta;
      onChunk(fullText.replace(/\nCONCEPTS:.*$/ms, "").trim());
    }
  }

  const match = fullText.match(/\nCONCEPTS:\s*(.+)$/m);
  const concepts = match ? match[1].split(",").map((c) => c.trim()).filter(Boolean) : [];
  const answer   = fullText.replace(/\nCONCEPTS:.*$/ms, "").trim();
  return { answer, concepts };
}

// ── Ollama chat (streams via fetch SSE) ───────────────────────────────────────
async function chatOllama({ systemPrompt, messages, onChunk, ollamaUrl, ollamaModel }) {
  const base  = (ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
  const model = ollamaModel || "llama3.2";

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: systemPrompt }, ...messages],
    }),
  });

  if (!res.ok) throw new Error(`Ollama error ${res.status}`);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText  = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    for (const line of lines) {
      try {
        const delta = JSON.parse(line.slice(6)).choices[0]?.delta?.content || "";
        if (delta) {
          fullText += delta;
          onChunk(fullText.replace(/\nCONCEPTS:.*$/ms, "").trim());
        }
      } catch (_) {}
    }
  }

  const match = fullText.match(/\nCONCEPTS:\s*(.+)$/m);
  const concepts = match ? match[1].split(",").map((c) => c.trim()).filter(Boolean) : [];
  const answer   = fullText.replace(/\nCONCEPTS:.*$/ms, "").trim();
  return { answer, concepts };
}

// ── Build system prompt (shared across all backends) ─────────────────────────
function buildSystemPrompt(articleText, articleTitle) {
  return `You are Reading Copilot, an AI assistant that helps readers understand articles deeply.

Article: "${articleTitle}"

Full article:
${articleText}

Instructions:
- Answer in the same language as the reader's question
- Answer the question directly and helpfully, drawing on both the article AND your general domain knowledge as needed. Do not limit yourself to what the article explicitly says.
- If the article addresses the question directly, cite the relevant part. If the question goes beyond the article's scope, say so in one short phrase (e.g. "The article doesn't cover this, but…") and then give your best substantive answer using domain knowledge, grounded in the article's context.
- Be concise: lead with the core point, 1-2 supporting details, implication if relevant. 3-5 sentences total.
- Maintain full conversation context across follow-ups
- When the reader has selected a specific passage, treat that passage as the PRIMARY anchor for your answer. Interpret the question through the lens of that specific excerpt. Use the rest of the article only as supporting context.
- After your answer, on a new line write exactly: CONCEPTS: concept1, concept2
  (2–4 key concepts in English, comma-separated)`;
}

// ── Route send message to correct backend ─────────────────────────────────────
async function sendMessage(text) {
  if (!text.trim() || state.streaming) return;

  // Capture and clear pending selection — attach to this message for blockquote display
  const selection = state.pendingSelection || null;
  state.pendingSelection = null;
  // Hide the preview panel
  const selPreview = $("#sel-preview");
  if (selPreview) selPreview.style.display = "none";

  // Save to reading history on first user message (marks this as an active conversation)
  const isFirstUserMsg = !state.conversation.some(m => m.role === "user");
  if (isFirstUserMsg) saveReadingHistory(state.article).catch(() => {});

  state.conversation.push({ role: "user", text, selection });

  // When user selected a passage, include it explicitly in the message sent to the AI
  // so the answer is contextually grounded in that specific excerpt.
  const aiContent = selection
    ? `The reader stopped at this specific passage:\n"${selection}"\n\nTheir question, grounded in this passage: ${text}`
    : text;
  state.msgHistory.push({ role: "user", content: aiContent });
  state.streaming  = true;
  state.streamText = "";
  renderChatMessages();

  const systemPrompt = buildSystemPrompt(state.article.text, state.article.title);
  const onChunk = (t) => { state.streamText = t; updateStreamBubble(); };

  try {
    let result;

    if (state.mode === "webllm") {
      result = await chatWebLLM({ systemPrompt, messages: state.msgHistory, onChunk });

    } else if (state.mode === "ollama") {
      const { ollamaUrl, ollamaModel } = await chrome.storage.local.get(["ollamaUrl", "ollamaModel"]);
      result = await chatOllama({ systemPrompt, messages: state.msgHistory, onChunk, ollamaUrl, ollamaModel });

    } else {
      // apikey → service worker handles streaming via port
      ensureSwPort();
      result = await msg("CHAT", {
        articleText:  state.article.text,
        articleTitle: state.article.title,
        messages:     state.msgHistory,
        tabId:        state.article.tabId,
      });
    }

    const { answer, concepts } = result;
    // Check if this convIdx was previously marked by the user
    const convIdx = state.conversation.length; // will be pushed at this index
    const ahaKey = `aha:${state.article?.url}`;
    const ahaStored = await chrome.storage.local.get([ahaKey]).catch(() => ({}));
    const ahaList = ahaStored[ahaKey] || [];
    const ahaMarked = ahaList.some(a => a.convIdx === convIdx);
    state.conversation.push({ role: "ai", text: answer, concepts, ahaMarked });
    state.msgHistory.push({ role: "assistant", content: answer });
    state.allConcepts = [...new Set([...state.allConcepts, ...concepts])];

    // Persist conversation so it survives sidebar close/reopen
    const url     = state.article?.url;
    const purpose = state.purpose;
    if (url && purpose) {
      const suffix = activeConvSuffix();
      chrome.storage.local.set({
        [`conv:${url}:${suffix}`]:  state.conversation,
        [`hist:${url}:${suffix}`]:  state.msgHistory,
        [`concepts:${url}`]:        state.allConcepts,
      }).catch(() => {});
      // Touch updatedAt on the active interview session
      if (purpose === "interview" && state.ivSessionId && state.ivMeta) {
        const s = state.ivMeta.sessions.find(x => x.id === state.ivSessionId);
        if (s) { s.updatedAt = Date.now(); saveIVMeta(url, state.ivMeta).catch(() => {}); }
      }
    }

    msg("SAVE_QA", { url: state.article.url, question: text, answer, concepts }).catch(() => {});

  } catch (e) {
    state.conversation.push({ role: "ai", text: `⚠️ ${e.message}`, concepts: [] });
  } finally {
    state.streaming  = false;
    state.streamText = "";
    renderChatMessages();
    scrollToLatestAnswer(); // scroll to TOP of answer so reader starts from beginning
  }
}

// ── Generate pre-reading questions ────────────────────────────────────────────
const PURPOSE_PROMPTS = {
  interview: 'Generate exactly 3 interview-style questions about this article. Focus on trade-offs and implications. Return ONLY a JSON array of 3 strings.',
  learning:  'Generate exactly 3 simple comprehension questions to check understanding of the core concepts. Return ONLY a JSON array of 3 strings.',
  research:  'Generate exactly 3 deep analytical questions about methodology, evidence, and implications. Return ONLY a JSON array of 3 strings.',
  general:   'Generate exactly 3 questions that test whether someone truly understood the key points. Return ONLY a JSON array of 3 strings.',
};

async function doGenerateQuestions({ fallback = null } = {}) {
  // For interview mode: ensure there is an active session
  if (state.purpose === "interview" && !state.ivSessionId) {
    // startNewIVSession should have been called first; if not, create one now
    const url = state.article?.url;
    if (url) await startNewIVSession(url);
    return; // startNewIVSession calls doGenerateQuestions recursively
  }

  // Show chat view immediately with a "thinking" bubble — questions appear inline
  state.conversation = [];
  state.msgHistory   = [];
  render("chat");
  // Inject a loading placeholder as the first AI message
  state.conversation = [{ role: "ai", text: "✦ Generating your reading questions…", concepts: [], loading: true }];
  renderChatMessages();

  try {
    let questions;
    let answers = []; // sample answers — only populated in apikey mode
    const prompt = PURPOSE_PROMPTS[state.purpose] || PURPOSE_PROMPTS.general;
    const sysPrompt = `Article: "${state.article.title}"\n\n${state.article.text}`;

    if (state.mode === "webllm") {
      const stream = await webllmEngine.chat.completions.create({
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `${prompt}\nExample: ["Q1?","Q2?","Q3?"]` },
        ],
        stream: false,
        max_tokens: 512,
      });
      const raw = stream.choices[0].message.content.trim();
      try { questions = JSON.parse(raw); } catch (_) {
        questions = raw.split("\n").map((l) => l.replace(/^[\d\.\-\*]+\s*/, "").trim()).filter((l) => l.length > 10).slice(0, 3);
      }

    } else if (state.mode === "ollama") {
      const { ollamaUrl, ollamaModel } = await chrome.storage.local.get(["ollamaUrl", "ollamaModel"]);
      const base  = (ollamaUrl || "http://localhost:11434").replace(/\/$/, "");
      const model = ollamaModel || "llama3.2";
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, stream: false,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: `${prompt}\nExample: ["Q1?","Q2?","Q3?"]` },
          ],
        }),
      });
      const data = await res.json();
      const raw  = data.choices[0].message.content.trim();
      try { questions = JSON.parse(raw); } catch (_) {
        questions = raw.split("\n").map((l) => l.replace(/^[\d\.\-\*]+\s*/, "").trim()).filter((l) => l.length > 10).slice(0, 3);
      }

    } else {
      const resp = await msg("GENERATE_QUESTIONS", {
        articleText:  state.article.text,
        articleTitle: state.article.title,
        purpose:      state.purpose,
        jobUrls:      state.jobUrls || [],   // interview mode: job posting URLs
      });
      // Service worker sends { error: "..." } on failure
      if (resp?.error) throw new Error(resp.error);
      questions = resp?.questions;
      answers   = resp?.answers || [];
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("No questions returned. The AI may have responded in an unexpected format.");
    }

    state.questions        = questions;
    state.questionAnswers  = answers;
    const suffix = activeConvSuffix();
    const storageUpdate = { [`questions:${state.article.url}:${suffix}`]: questions };
    if (answers.length) storageUpdate[`answers:${state.article.url}:${suffix}`] = answers;
    await chrome.storage.local.set(storageUpdate);

    // Re-render the entire chat view so pinned questions strip picks up state.questions
    state.conversation = [{ role: "ai", text: buildQuestionsMessage(state.purpose, questions), concepts: [] }];
    render("chat");
    scrollToBottom();

    // Trigger past-connections analysis asynchronously (don't await — non-blocking)
    loadArticleConnections();

  } catch (e) {
    // If we have a fallback (called from edit-links), restore previous questions and show a toast
    if (fallback?.questions?.length) {
      state.questions      = fallback.questions;
      state.questionAnswers = fallback.answers || [];
      state.jobUrls        = fallback.jobUrls  || [];
      // Undo the optimistic history entry we just archived
      if (state.questionHistory?.length) {
        state.questionHistory = state.questionHistory.slice(0, -1);
        const url = state.article?.url;
        if (url && state.ivSessionId) {
          chrome.storage.local.set({ [getQHistKey(url, state.ivSessionId)]: state.questionHistory }).catch(() => {});
        }
      }
      // Restore session meta job URLs
      if (state.ivMeta && state.ivSessionId && state.article?.url) {
        const session = state.ivMeta.sessions.find(s => s.id === state.ivSessionId);
        if (session) {
          session.jobUrls = fallback.jobUrls || [];
          saveIVMeta(state.article.url, state.ivMeta).catch(() => {});
        }
      }
      render("chat");
      showToast("⚠️ Couldn't read that job link — reverted to previous questions.");
      return;
    }

    // Clear saved purpose + questions so reopening starts fresh instead of re-failing
    if (state.article?.url) {
      const keysToRemove = [`purpose:${state.article.url}`];
      const suffix = activeConvSuffix();
      if (suffix) keysToRemove.push(`questions:${state.article.url}:${suffix}`);
      chrome.storage.local.remove(keysToRemove);
    }
    // Also roll back the iv_meta entry we may have created for this session
    if (state.purpose === "interview" && state.ivSessionId && state.ivMeta) {
      state.ivMeta.sessions = state.ivMeta.sessions.filter(s => s.id !== state.ivSessionId);
      state.ivMeta.activeId = state.ivMeta.sessions[state.ivMeta.sessions.length - 1]?.id || null;
      if (state.article?.url) saveIVMeta(state.article.url, state.ivMeta).catch(() => {});
    }
    state.purpose     = null;
    state.ivSessionId = null;

    const modeHints = {
      ollama:  "Ollama isn't running.\nOpen Terminal and run:\n  ollama serve\n  ollama pull llama3.2\n\nOr switch to API Key mode in Settings.",
      webllm:  "Local AI failed. Your browser may not support WebGPU.\nTry API Key mode in Settings.",
      apikey:  `API error: ${e.message}\n\nCheck your API key in Settings.`,
    };
    renderError(modeHints[state.mode] || e.message, { showSettings: true, showBack: true });
  }
}

// ── Interview session helpers ──────────────────────────────────────────────────
function makeIVSessionId() { return `iv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`; }

/** Returns the storage key suffix for a given interview sessionId. */
function getIVConvKeys(url, sessionId) {
  const suffix = sessionId ? `interview:${sessionId}` : "interview";
  return {
    qKey:    `questions:${url}:${suffix}`,
    convKey: `conv:${url}:${suffix}`,
    histKey: `hist:${url}:${suffix}`,
  };
}

/** Returns the storage key for question history for a given interview session. */
function getQHistKey(url, sessionId) { return `qhist:${url}:${sessionId}`; }

/** Returns the active conversation key suffix based on current state. */
function activeConvSuffix() {
  if (state.purpose === "interview" && state.ivSessionId) return `interview:${state.ivSessionId}`;
  return state.purpose;
}

/** Format a timestamp as "Jul 18 · 2:34 PM" */
function fmtSessionDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    + " · "
    + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

async function loadIVMeta(url) {
  const stored = await chrome.storage.local.get([`iv_meta:${url}`]);
  return stored[`iv_meta:${url}`] || null;
}

async function saveIVMeta(url, meta) {
  await chrome.storage.local.set({ [`iv_meta:${url}`]: meta });
}

/**
 * Migrate any legacy interview data into the new session structure.
 */
async function migrateOldIVSession(url, ivMeta) {
  if (ivMeta) return ivMeta;
  const old = await chrome.storage.local.get([
    `questions:${url}:interview`, `conv:${url}:interview`, `hist:${url}:interview`,
  ]);
  if (!old[`questions:${url}:interview`]) return null;
  const sessionId = "default";
  await chrome.storage.local.set({
    [`questions:${url}:interview:${sessionId}`]: old[`questions:${url}:interview`],
    [`conv:${url}:interview:${sessionId}`]:      old[`conv:${url}:interview`] || [],
    [`hist:${url}:interview:${sessionId}`]:      old[`hist:${url}:interview`] || [],
  });
  await chrome.storage.local.remove([
    `questions:${url}:interview`, `conv:${url}:interview`, `hist:${url}:interview`,
  ]);
  const meta = {
    sessions: [{ id: sessionId, label: "Session 1", ts: Date.now(), updatedAt: Date.now() }],
    activeId: sessionId,
  };
  await saveIVMeta(url, meta);
  return meta;
}

/**
 * Create a brand-new interview session and generate questions.
 * @param {string} url       - article URL
 * @param {string|string[]} [jobUrls] - optional job posting URL(s)
 */
async function startNewIVSession(url, jobUrls = []) {
  // Normalise: accept a single string for backwards compatibility
  if (typeof jobUrls === "string") jobUrls = jobUrls.trim() ? [jobUrls.trim()] : [];
  const validUrls = jobUrls.map(u => u.trim()).filter(u => u.length > 0);

  if (!state.ivMeta) state.ivMeta = { sessions: [], activeId: null };
  const n = state.ivMeta.sessions.length + 1;
  const sessionId = makeIVSessionId();

  // Label: domain of first valid URL, else "Session N"
  let label = `Session ${n}`;
  if (validUrls.length > 0) {
    try { label = new URL(validUrls[0]).hostname.replace(/^www\./, ""); } catch (_) { label = validUrls[0].slice(0, 30); }
  }

  const session = { id: sessionId, label, ts: Date.now(), updatedAt: Date.now(), jobUrls: validUrls };
  state.ivMeta.sessions.push(session);
  state.ivMeta.activeId = sessionId;
  state.ivSessionId = sessionId;
  state.jobUrls = validUrls;
  await saveIVMeta(url, state.ivMeta);
  await doGenerateQuestions();
}

/**
 * Delete an interview session and all its stored data.
 */
async function deleteIVSession(url, sessionId) {
  if (!state.ivMeta) return;
  const { qKey, convKey, histKey } = getIVConvKeys(url, sessionId);
  await chrome.storage.local.remove([qKey, convKey, histKey]);
  state.ivMeta.sessions = state.ivMeta.sessions.filter(s => s.id !== sessionId);
  // If we deleted the active session, pick the last remaining one
  if (state.ivMeta.activeId === sessionId) {
    const last = state.ivMeta.sessions[state.ivMeta.sessions.length - 1];
    state.ivMeta.activeId = last?.id || null;
    state.ivSessionId = last?.id || null;
  }
  await saveIVMeta(url, state.ivMeta);
}

/**
 * Handle clicking Interview Prep: load sessions and show picker or resume.
 */
async function handleInterviewPurposeClick(url) {
  let ivMeta = await loadIVMeta(url);
  ivMeta = await migrateOldIVSession(url, ivMeta);
  state.ivMeta = ivMeta;
  state.jobUrls = [];

  // Safety net: restore summaryData if lost
  if (!state.summaryData) {
    const sd = await chrome.storage.local.get([`summary:${url}`]);
    if (sd[`summary:${url}`]) state.summaryData = sd[`summary:${url}`];
  }

  if (!ivMeta || ivMeta.sessions.length === 0) {
    // No sessions yet → let user optionally add a job link first
    state.jobUrls = [];
    render("iv-new-session");
    return;
  }

  // One or more sessions → show the picker every time so user can choose
  const activeSession = ivMeta.sessions.find(s => s.id === ivMeta.activeId)
    || ivMeta.sessions[ivMeta.sessions.length - 1];
  state.ivSessionId = activeSession.id;
  render("iv-job-prompt");
}

// ── Load past article connections ───────────────────────────────────────────
async function loadArticleConnections() {
  const url = state.article?.url;
  if (!url || !state.article?.text) return;

  // Check cache first (only use cache if it has actual connections)
  const cached = await chrome.storage.local.get([`connections:${url}`]);
  const cachedConns = cached[`connections:${url}`];
  if (cachedConns?.length > 0) {
    state.connections = cachedConns;
    if (state.view === "chat") updateConnectionsSection();
    return;
  }

  // Generate new
  const result = await msg("FIND_CONNECTIONS", {
    url,
    title: state.article.title,
    text: state.article.text,
  }).catch(() => null);

  const connections = result?.connections || [];
  state.connections = connections;
  // Only cache non-empty results — if empty, retry next session as knowledge graph grows
  if (connections.length > 0) {
    await chrome.storage.local.set({ [`connections:${url}`]: connections });
  }
  if (state.view === "chat") updateConnectionsSection();
}

function updateConnectionsSection() {
  const section = $("#connections-section");
  if (!section) return;
  // Re-render the connections section in place
  const newSection = buildConnectionsHtml();
  section.outerHTML = newSection;
  // Re-attach toggle handler
  $("#connections-toggle")?.addEventListener("click", () => {
    const body = $("#connections-body");
    const chevron = $("#connections-chevron");
    const isOpen = body?.style.display !== "none";
    if (body) body.style.display = isOpen ? "none" : "block";
    if (chevron) chevron.textContent = isOpen ? "▸" : "▾";
  });
  // Re-attach click-to-open handlers
  document.querySelectorAll(".conn-item--clickable").forEach(el => {
    el.addEventListener("click", () => {
      const url = el.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
}

function buildConnectionsHtml() {
  const conns = state.connections;

  // null = still loading, show nothing
  if (conns === null) return `<div id="connections-section"></div>`;

  // Empty = not enough history
  if (conns.length === 0) {
    return `<div id="connections-section"></div>`; // hide when empty
  }

  const typeLabel = {
    "same-problem":     "Same problem",
    "contrasting-view": "Contrasting view",
    "builds-on":        "Builds on",
    "applies-to":       "Applies to",
  };

  const items = conns.map(c => `
    <div class="conn-item${c.articleUrl ? ' conn-item--clickable' : ''}" ${c.articleUrl ? `data-url="${esc(c.articleUrl)}"` : ''}>
      <div class="conn-type-badge">${esc(typeLabel[c.connectionType] || "Related")}</div>
      <div class="conn-title">${esc(c.articleTitle || "")}${c.articleUrl ? ' <span class="conn-open-hint">↗</span>' : ''}</div>
      <div class="conn-insight">${esc(c.connectionInsight || "")}</div>
    </div>`).join("");

  return `
    <div id="connections-section" class="connections-section">
      <div class="connections-header" id="connections-toggle">
        <span class="connections-teaser">✦ Possible connection from past reading — check here</span>
        <span id="connections-chevron" class="connections-chevron">▸</span>
      </div>
      <div id="connections-body" class="connections-body" style="display:none">
        ${items}
      </div>
    </div>`;
}

// ── Article complete — runs in background, doesn't block the sidebar ─────────
let _summaryGenerating = false;
let _initComplete = false; // guard: don't process articleCompleteSignal until init() finishes

async function onArticleComplete(signal, { force = false, silent = false } = {}) {
  if (!force) {
    // Any existing summaryData blocks auto-generation.
    // Re-generation is only via ↻ Update (force:true) or first-ever summary tab click.
    if (state.summaryData) return;
  }
  if (_summaryGenerating) return;  // generation already in progress — skip
  _summaryGenerating = true;
  if (!silent) showSummaryBanner("loading");

  try {
    const url = signal?.url || state.article?.url;

    // Re-fetch article from tab in case text is stale/empty (e.g. dynamic pages)
    if (!state.article?.text || state.article.text.trim().length < 100) {
      const fresh = await msg("GET_CURRENT_ARTICLE");
      if (fresh?.text && fresh.text.trim().length >= 100) state.article = fresh;
    }

    // Build Q&A history from state.conversation (sidebar saves to conv:url:purpose,
    // NOT to article:url.qa in the service worker — pass directly so readerAnalysis works)
    const userMsgs  = state.conversation.filter(m => m.role === "user");
    const aiReplies = state.conversation.filter((m, i) => m.role === "ai" && i > 0 && !m.loading);
    const qaHistory = userMsgs.map((m, i) => ({
      q: m.text,
      a: (aiReplies[i]?.text || "").slice(0, 600),
    })).filter(p => p.a);

    const result = await msg("ARTICLE_COMPLETE", {
      url,
      articleText:  state.article?.text  || "",
      articleTitle: state.article?.title || "",
      qaHistory,
    });
    // Track how many Q&A pairs were present at generation time (for stale detection)
    const qaCount = state.conversation.filter(m => m.role === "user").length;
    // Merge: always preserve existing summary/concepts, only replace readerAnalysis
    if (state.summaryData?.summary) {
      state.summaryData = { ...state.summaryData, readerAnalysis: result.readerAnalysis, raQACount: qaCount };
    } else {
      state.summaryData = { ...result, raQACount: qaCount };
    }
    if (url) chrome.storage.local.set({ [`summary:${url}`]: state.summaryData }).catch(() => {});
    // Re-render summary if currently visible so reader analysis appears immediately.
    // Use render("summary") (not just renderSummary()) so event handlers are re-attached
    // — otherwise the replaced ↻ Update button loses its click listener.
    if (state.view === "summary") render("summary");
    if (!silent) showSummaryBanner("ready");
  } catch (e) {
    // Store error so summary view can show it with a retry button
    if (!silent) {
      state.summaryData = { summary: "", concepts: [], crossGraph: null, error: e.message };
      showSummaryBanner("ready");
    }
  } finally {
    _summaryGenerating = false;
  }
}

// ── Summary banner (non-blocking) ────────────────────────────────────────────
function showSummaryBanner(status) {
  let banner = $("#summary-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "summary-banner";
    Object.assign(banner.style, {
      position: "fixed", bottom: "0", left: "0", right: "0",
      background: "#1e1b4b", color: "#fff",
      padding: "10px 16px", fontSize: "13px", fontWeight: "600",
      display: "flex", alignItems: "center", justifyContent: "space-between",
      zIndex: "9999", fontFamily: "system-ui, sans-serif",
    });
    document.body.appendChild(banner);
  }
  if (status === "loading") {
    banner.innerHTML = `<span>✦ Generating summary…</span><span style="opacity:.6;font-size:11px">You can keep reading</span>`;
  } else {
    banner.innerHTML = `<span>✦ Summary ready!</span><button id="btn-view-summary" style="background:#6366f1;border:none;color:#fff;padding:5px 12px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">View →</button>`;
    banner.style.background = "#312e81";
    $("#btn-view-summary")?.addEventListener("click", () => {
      banner.remove();
      render("summary");
    });
  }
}

// ── Render dispatcher ─────────────────────────────────────────────────────────
function render(view) {
  state.view = view;
  const app = $("#app");
  app.innerHTML = "";

  const views = {
    "loading":              renderLoading,
    "no-mode-set":          renderNoModeSet,
    "no-key":               renderNoKey,
    "no-article":           renderNoArticle,
    "downloading":          renderDownloading,
    "purpose":              renderPurpose,
    "interview-setup":      renderInterviewSetup,
    "iv-job-prompt":        renderIVJobPrompt,
    "iv-new-session":       renderIVNewSession,
    "iv-edit-links":        renderIVEditLinks,
    "generating-questions": renderGeneratingQuestions,
    "questions":            renderQuestions,
    "chat":                 renderChat,
    "summary-loading":      renderSummaryLoading,
    "summary":              renderSummary,
    "history":              renderHistory,
  };

  const fn = views[view];
  if (fn) app.appendChild(fn());
  attachHandlers(view);
}

// ── Screen renderers ──────────────────────────────────────────────────────────
function renderLoading() {
  return html(`<div class="center-screen"><span class="logo-xl">✦</span><div class="dots"><span></span><span></span><span></span></div></div>`);
}

function renderNoModeSet() {
  return html(`
    <div class="center-screen">
      <span class="logo-xl">✦</span>
      <p>Choose an AI mode to get started</p>
      <button class="btn-primary" id="btn-open-options">Open Settings</button>
    </div>`);
}

function renderNoKey() {
  return html(`
    <div class="center-screen">
      <span class="logo-xl">✦</span>
      <p>Please add your Anthropic API Key in settings</p>
      <button class="btn-primary" id="btn-open-options">Open Settings</button>
    </div>`);
}

function renderNoArticle() {
  const url = state.article?.url || "";
  const isPDF = url.toLowerCase().endsWith(".pdf") ||
                (url.includes("arxiv.org/pdf/"));
  const msg = isPDF
    ? `<p style="text-align:center;line-height:1.6">Couldn't read this PDF.<br><span style="font-size:11px;color:#9ca3af">For arXiv papers, try the <a href="#" id="link-arxiv-abs" style="color:#6366f1">Abstract page</a> instead.</span></p>`
    : `<p>Open an article to start reading with Copilot</p>`;
  return html(`
    <div class="center-screen">
      <span class="logo-xl">✦</span>
      ${msg}
    </div>`);
}

function renderDownloading() {
  return html(`
    <div class="center-screen" style="gap:20px;padding:32px">
      <span class="logo-xl">✦</span>
      <div style="width:100%">
        <div style="font-size:13px;font-weight:700;color:#1e1b4b;margin-bottom:8px">Downloading AI model</div>
        <div style="font-size:11px;color:#9ca3af;margin-bottom:12px">Phi-3.5 Mini · ~2.2 GB · one-time download</div>
        <div style="background:#f3f4f6;border-radius:99px;height:8px;overflow:hidden;margin-bottom:8px">
          <div id="dl-bar" style="height:100%;background:linear-gradient(90deg,#6366f1,#818cf8);border-radius:99px;width:0%;transition:width .3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between">
          <div id="dl-info" style="font-size:11px;color:#9ca3af">Starting…</div>
          <div id="dl-pct" style="font-size:11px;font-weight:700;color:#6366f1">0%</div>
        </div>
      </div>
      <p style="font-size:12px;color:#9ca3af;text-align:center;line-height:1.6">
        After this, the model runs entirely in your browser.<br/>No internet required. No API costs. Ever.
      </p>
    </div>`);
}

function renderPurpose() {
  const title = state.article?.title || "";
  const modeTag = { webllm: "🧠 Local AI", ollama: "🦙 Ollama", apikey: "☁️ API" }[state.mode] || "";
  return html(`
    <div class="purpose-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Reading Copilot</span></div>
        <span style="font-size:11px;color:#9ca3af">${esc(modeTag)}</span>
      </div>
      <div class="purpose-body">
        <div class="art-badge">${esc(title.slice(0, 70))}${title.length > 70 ? "…" : ""}</div>
        <h2>Why are you reading this?</h2>
        <p class="purpose-subtitle">I'll generate questions tailored to your goal</p>
        <div class="purpose-grid">
          <button class="purpose-btn" data-purpose="interview"><span class="purpose-icon">💼</span><span class="purpose-label">Interview Prep</span><span class="purpose-desc">Practice interview-style questions</span></button>
          <button class="purpose-btn" data-purpose="learning"><span class="purpose-icon">📖</span><span class="purpose-label">Learn Concepts</span><span class="purpose-desc">Understand core ideas & principles</span></button>
          <button class="purpose-btn" data-purpose="research"><span class="purpose-icon">🔬</span><span class="purpose-label">Deep Research</span><span class="purpose-desc">Analyze arguments & implications</span></button>
          <button class="purpose-btn" data-purpose="general"><span class="purpose-icon">👀</span><span class="purpose-label">General Read</span><span class="purpose-desc">Grasp the key takeaways</span></button>
        </div>
        <div style="text-align:center;margin-top:12px">
          <button class="history-link-btn" id="btn-purpose-history">📚 Reading history</button>
        </div>
      </div>
    </div>`);
}

function renderInterviewSetup() {
  const urls = state.jobUrls.length ? state.jobUrls : [""];
  const inputs = urls.map((u, i) => `
    <div class="job-url-row" data-i="${i}">
      <input class="job-url-input" type="url" placeholder="https://company.com/jobs/role" value="${esc(u)}" data-i="${i}"/>
      ${i > 0 ? `<button class="job-url-remove" data-i="${i}">×</button>` : ""}
    </div>`).join("");

  return html(`
    <div class="interview-setup-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Interview Prep</span></div>
        <button class="icon-btn" id="btn-skip-jobs">Skip →</button>
      </div>
      <div class="interview-setup-body">
        <div class="interview-setup-icon">💼</div>
        <h3 class="interview-setup-title">Add job postings <span style="font-weight:400;color:#9ca3af">(optional)</span></h3>
        <p class="interview-setup-desc">Paste links to the roles you're applying for. I'll generate questions that connect this article to the specific job requirements.</p>
        <div id="job-url-list">${inputs}</div>
        <button class="btn-add-url" id="btn-add-url">+ Add another role</button>
        <button class="btn-primary" id="btn-gen-interview" style="width:100%;margin-top:16px">Generate Questions →</button>
      </div>
    </div>`);
}

function renderIVJobPrompt() {
  const meta = state.ivMeta;
  // Show newest sessions first
  const allSessions = [...(meta?.sessions || [])].reverse();

  const sessionRowsHtml = allSessions.map(s => {
    const isActive = s.id === state.ivSessionId;
    const dateStr = fmtSessionDate(s.updatedAt || s.ts);
    return `<div class="iv-session-row iv-session-row--clickable ${isActive ? 'iv-session-row--active' : ''}" data-sid="${esc(s.id)}">
      <div class="iv-session-info">
        <span class="iv-session-label">${esc(s.label)}</span>
        ${dateStr ? `<span class="iv-session-date">${esc(dateStr)}</span>` : ""}
      </div>
      <div class="iv-session-actions">
        ${isActive
          ? `<span class="iv-active-badge">current ›</span>`
          : `<span class="iv-resume-arrow">Open ›</span>`}
        <button class="iv-delete-btn" data-sid="${esc(s.id)}" title="Delete session">✕</button>
      </div>
    </div>`;
  }).join("");

  return html(`
    <div class="interview-setup-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Interview Prep</span></div>
        <button class="icon-btn" id="btn-iv-prompt-back">← Back</button>
      </div>
      <div class="interview-setup-body">
        <h3 class="interview-setup-title" style="margin-bottom:4px">Sessions</h3>
        <p class="interview-setup-desc" style="margin-bottom:12px">Each session keeps a separate conversation history.</p>
        <div class="iv-session-list">${sessionRowsHtml}</div>
        <div style="margin-top:14px;border-top:1px solid #e5e7eb;padding-top:12px">
          <button class="btn-primary" id="btn-iv-add-job" style="width:100%">＋ New session</button>
        </div>
      </div>
    </div>`);
}

function renderIVNewSession() {
  const urls = (state.jobUrls?.length ? state.jobUrls : [""]);
  const inputs = urls.map((u, i) => `
    <div class="job-url-row">
      <input class="job-url-input" type="url" placeholder="https://company.com/jobs/role" value="${esc(u)}" data-i="${i}"/>
      ${i > 0 ? `<button class="job-url-remove" data-i="${i}">×</button>` : ""}
    </div>`).join("");

  return html(`
    <div class="interview-setup-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Interview Prep</span></div>
        <button class="icon-btn" id="btn-iv-new-back">← Back</button>
      </div>
      <div class="interview-setup-body">
        <h3 class="interview-setup-title" style="margin-bottom:4px">New session</h3>
        <p class="interview-setup-desc" style="margin-bottom:12px">Paste job links to get role-specific questions — or skip to use general interview questions.</p>
        <div id="iv-new-url-list">${inputs}</div>
        <button class="btn-add-url" id="btn-iv-new-add-url" style="width:100%;margin-top:6px">+ Add another role</button>
        <button class="btn-primary" id="btn-iv-new-start" style="width:100%;margin-top:14px;margin-bottom:8px">Start session →</button>
        <button class="btn-secondary" id="btn-iv-new-skip" style="width:100%">Skip — no job link</button>
      </div>
    </div>`);
}

function renderIVEditLinks() {
  const urls = (state.jobUrls?.length ? state.jobUrls : [""]);
  const inputs = urls.map((u, i) => `
    <div class="job-url-row">
      <input class="job-url-input" type="url" placeholder="https://company.com/jobs/role" value="${esc(u)}" data-i="${i}"/>
      ${i > 0 ? `<button class="job-url-remove" data-i="${i}">×</button>` : ""}
    </div>`).join("");

  return html(`
    <div class="interview-setup-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Interview Prep</span></div>
        <button class="icon-btn" id="btn-iv-edit-back">← Back</button>
      </div>
      <div class="interview-setup-body">
        <h3 class="interview-setup-title" style="margin-bottom:4px">Edit job links</h3>
        <p class="interview-setup-desc" style="margin-bottom:12px">Update the roles you're preparing for. New guiding questions will be generated — your conversation history stays intact.</p>
        <div id="iv-edit-url-list">${inputs}</div>
        <button class="btn-add-url" id="btn-iv-edit-add-url" style="width:100%;margin-top:6px">+ Add another role</button>
        <button class="btn-primary" id="btn-iv-edit-save" style="width:100%;margin-top:14px;margin-bottom:8px">Save &amp; refresh questions</button>
        <button class="btn-secondary" id="btn-iv-edit-clear" style="width:100%">Clear all links (use general questions)</button>
      </div>
    </div>`);
}

function renderGeneratingQuestions() {
  return html(`
    <div class="center-screen">
      <span class="logo-xl">✦</span>
      <p>Generating questions…</p>
      <div class="dots"><span></span><span></span><span></span></div>
    </div>`);
}

function renderQuestions() {
  const cards = state.questions.map((q, i) => {
    const a = state.questionAnswers[i] || "";
    return `
      <div class="question-card" style="display:flex;flex-direction:column">
        <div class="q-num">Q${i+1}</div>
        <div class="q-text">${esc(q)}</div>
        ${a ? `<button class="q-show-answer-btn" data-i="${i}">Show sample answer</button>
               <div class="q-answer-reveal" id="q-ans-${i}" style="display:none">${esc(a)}</div>` : ""}
      </div>`;
  }).join("");
  return html(`
    <div class="questions-screen screen">
      <div class="sidebar-header">
        <div class="header-left"><span class="logo-mark">✦</span><span class="logo-text">Reading Copilot</span></div>
      </div>
      <div class="questions-body">
        <div class="section-label">Before you start, try to answer these</div>
        <p class="questions-hint">Compare your answers with me in the chat after reading</p>
        ${cards}
      </div>
      <div class="questions-footer">
        <button class="btn-primary" id="btn-start-chat" style="width:100%">Start reading — ask as you go →</button>
      </div>
    </div>`);
}

function renderChat() {
  const purposeIcon = { interview: "💼", learning: "📖", research: "🔬", general: "🌐" }[state.purpose] || "✦";

  // Pinned questions strip — fixed below header, chat messages scroll underneath
  const pinnedQs = state.questions?.length ? `
    <div class="pinned-questions" id="pinned-qs">
      <div class="pinned-header" id="pinned-toggle">
        <span class="pinned-label">${purposeIcon} Guiding questions</span>
        <span id="pinned-chevron" style="font-size:10px;color:var(--color-text-tertiary);transition:transform .2s">▾</span>
      </div>
      <div id="pinned-body">
        ${state.questions.map((q, i) => {
          const hasAnswer = !!(state.questionAnswers?.[i]);
          return `
          <div class="pinned-q-wrap">
            <div class="pinned-q" data-q="${esc(q)}">
              <span class="pinned-num">${i + 1}</span>
              <span style="flex:1">${esc(q)}</span>
              ${hasAnswer ? `<button class="pinned-ans-btn" data-i="${i}" title="Sample answer">▸ answer</button>` : ""}
            </div>
            ${hasAnswer ? `<div class="pinned-ans-reveal" id="pinned-ans-${i}" style="display:none">${esc(state.questionAnswers[i])}</div>` : ""}
          </div>`;
        }).join("")}
        ${state.questionHistory?.length ? `
          <div class="past-qs-section">
            <div class="past-qs-toggle" id="past-qs-toggle">
              <span>Past question sets (${state.questionHistory.length})</span>
              <span class="past-qs-chevron">▸</span>
            </div>
            <div class="past-qs-body" id="past-qs-body" style="display:none">
              ${[...state.questionHistory].reverse().map((set, si) => {
                const label = `${fmtSessionDate(set.ts)}${set.jobUrls?.length ? ` · ${set.jobUrls.map(u => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return u; } }).join(', ')}` : ''}`;
                return `
                <div class="past-qs-set">
                  <div class="past-qs-set-toggle" data-si="${si}">
                    <span>${esc(label)}</span>
                    <span class="past-qs-set-chevron">▸</span>
                  </div>
                  <div class="past-qs-set-questions" id="past-qs-set-${si}" style="display:none">
                    ${set.questions.map((q, qi) => `<div class="past-qs-item"><span class="pinned-num">${qi+1}</span>${esc(q)}</div>`).join("")}
                  </div>
                </div>`;
              }).join("")}
            </div>
          </div>` : ""}
      </div>
    </div>` : "";

  const titleShort = state.article?.title
    ? state.article.title.slice(0, 38) + (state.article.title.length > 38 ? "…" : "")
    : "";

  return html(`
    <div class="chat-screen screen">
      <div class="sidebar-header">
        <div class="header-left">
          <span class="logo-mark">✦</span>
          <div class="header-title-stack">
            <span class="logo-text">Reading Copilot</span>
            ${titleShort ? `<span class="article-subtitle-wrap"><span class="article-subtitle">${esc(titleShort)}</span><span class="article-title-tooltip">${esc(state.article.title)}</span></span>` : ""}
          </div>
        </div>
        <div class="header-actions">
          <button class="icon-btn" id="btn-change-goal" title="Switch purpose" style="font-size:11px;padding:3px 7px;border-radius:6px">sessions ↺</button>
          ${state.purpose === "interview" ? `<button class="icon-btn" id="btn-edit-links" title="Edit job links" style="font-size:11px;padding:3px 7px;border-radius:6px">✏️ links</button>` : ""}
          <button class="icon-btn" id="btn-to-history" title="Reading history" style="font-size:11px;padding:3px 7px;border-radius:6px">📚</button>
          <button class="icon-btn" id="btn-to-summary" title="Summary" style="font-size:11px;padding:3px 7px;border-radius:6px">summary</button>
        </div>
      </div>
      ${pinnedQs}
      ${buildConnectionsHtml()}
      <div class="chat-messages" id="chat-messages"></div>
      <div class="chat-input-area">
        <div class="sel-preview" id="sel-preview" style="display:${state.pendingSelection ? 'flex' : 'none'}">
          <div class="sel-preview-text" id="sel-preview-text">${esc((state.pendingSelection || "").slice(0, 160))}${(state.pendingSelection || "").length > 160 ? "…" : ""}</div>
          <button class="sel-preview-clear" id="btn-clear-sel" title="Clear selection">×</button>
        </div>
        <div class="chat-input-row">
          <textarea id="chat-input" placeholder="${state.pendingSelection ? 'Ask about the selected text…' : 'Ask anything about this article…'}" rows="2"></textarea>
          <button class="send-btn" id="send-btn">↑</button>
        </div>
      </div>
    </div>`);
}

function renderSummaryLoading() {
  return html(`
    <div class="center-screen">
      <span class="logo-xl">✦</span>
      <p>Generating summary…</p>
      <div class="dots"><span></span><span></span><span></span></div>
    </div>`);
}

function renderSummary() {
  const d = state.summaryData || {};

  // ── Article summary ───────────────────────────────────────────────────────────
  const summaryText = (d.summary || "").trim();
  let summaryHtml, summaryCollapsible = false;
  if (d.error) {
    summaryHtml = `<p class="summary-para muted">⚠️ ${esc(d.error)}</p>
       <button class="btn-secondary" id="btn-retry-summary" style="margin-top:8px">↺ Retry</button>`;
  } else if (summaryText) {
    const paras = summaryText.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const renderedParas = paras.map(p => {
      const match = p.match(/^(Background|Problem|Approach|Conclusion|Implications):\s*(.*)/s);
      return match
        ? `<p class="summary-para"><strong>${match[1]}:</strong> ${esc(match[2])}</p>`
        : `<p class="summary-para">${esc(p)}</p>`;
    });
    if (renderedParas.length > 2) {
      summaryCollapsible = true;
      // Show first paragraph as preview, rest hidden
      summaryHtml = `
        <div class="summary-preview">${renderedParas[0]}</div>
        <div class="summary-full summary-full--hidden">${renderedParas.join("")}</div>
        <button class="summary-toggle-btn" id="btn-summary-toggle">Show full summary ▾</button>`;
    } else {
      summaryHtml = renderedParas.join("");
    }
  } else {
    summaryHtml = `<p class="summary-para muted">Scroll to the end of the article to generate a summary.</p>`;
  }

  // ── Key concept tags ──────────────────────────────────────────────────────────
  const concepts = [...new Set([...(d.concepts || []), ...state.allConcepts])];
  const CONCEPTS_VISIBLE = 9; // 3 columns × 3 rows
  const visibleConcepts = concepts.slice(0, CONCEPTS_VISIBLE);
  const hiddenConcepts  = concepts.slice(CONCEPTS_VISIBLE);
  const conceptsHtml = concepts.length
    ? `<div class="section-label mt-20">Key Concepts <span class="tag-note">saved to knowledge graph</span></div>
       <div class="concept-tags">
         ${visibleConcepts.map(c => `<span class="concept-tag">${esc(c)}</span>`).join("")}
         ${hiddenConcepts.length
           ? `<div class="concept-extra concept-extra--hidden">${hiddenConcepts.map(c => `<span class="concept-tag">${esc(c)}</span>`).join("")}</div>
              <button class="concept-more-btn" data-count="${hiddenConcepts.length}">+${hiddenConcepts.length} more</button>`
           : ""}
       </div>`
    : "";

  // ── Q&A pairs (role-based) ────────────────────────────────────────────────────
  const userMsgs  = state.conversation.filter(m => m.role === "user");
  const aiReplies = state.conversation.filter((m, i) => m.role === "ai" && i > 0 && !m.loading);
  const qaPairs   = userMsgs.map((m, i) => ({
    q: m.text, a: aiReplies[i]?.text, sel: m.selection,
    ahaMarked: !!aiReplies[i]?.ahaMarked,
    concepts:  aiReplies[i]?.concepts || [],
  })).filter(p => p.a);

  // ── Reader analysis section ───────────────────────────────────────────────────
  const ra = d.readerAnalysis;
  // Show Update button if: analysis is stale (new Q&A) OR never generated but Q&A exists
  const isRAStale = ra && d.raQACount !== undefined && qaPairs.length > d.raQACount;
  const showUpdateBtn = isRAStale || (!ra && qaPairs.length > 0);
  const readerAnalysisHtml = qaPairs.length ? `
    <div class="section-label mt-24">Your Reading Session${showUpdateBtn ? ` <button id="btn-refresh-ra" class="ra-refresh-btn">↻ Update</button>` : ``}</div>
    <div class="reader-analysis-card">
      ${!ra ? `<p class="ra-loading">Click ↻ Update to generate your session analysis.</p>` : ""}
      ${ra?.overview ? `<p class="ra-overview">${esc(ra.overview)}</p>` : ""}
      ${ra?.focusAreas?.length ? `
        <div class="ra-row">
          <span class="ra-label">You focused on</span>
          <div class="ra-tags">${ra.focusAreas.map(f => `<span class="ra-tag focus">${esc(f)}</span>`).join("")}</div>
        </div>` : ""}
      ${ra?.gaps?.length ? `
        <div class="ra-row ra-row-gaps">
          <span class="ra-label">Try this week</span>
          <ul class="ra-gap-list">${ra.gaps.map(g => {
            // AI sometimes returns objects {Pattern,Action} instead of strings — flatten gracefully
            const text = (g && typeof g === "object")
              ? [g.Pattern || g.pattern || "", g.Action || g.action || ""].filter(Boolean).join(" ")
              : String(g ?? "");
            return `<li>${esc(text)}</li>`;
          }).join("")}</ul>
        </div>` : ""}
    </div>
    <div class="section-label mt-16">Questions <span class="tag-note">${qaPairs.length} total · click to expand</span></div>
    <div class="qa-index">
      ${qaPairs.map((p, idx) => `
        <div class="qa-row" data-idx="${idx}">
          ${p.ahaMarked ? `<button class="qa-aha-btn" data-idx="${idx}" title="Learning moment — click to see concepts">💡</button>` : `<span class="qa-aha-placeholder"></span>`}
          <span class="qa-index-num">${idx + 1}</span>
          <span class="qa-index-q">${esc(p.q.slice(0, 72))}${p.q.length > 72 ? "…" : ""}</span>
          ${p.sel ? `<button class="jump-btn" data-idx="${idx}" title="Jump to source text">↗</button>` : ""}
          <span class="qa-chevron">›</span>
        </div>
        ${p.ahaMarked && p.concepts.length ? `
        <div class="qa-aha-reveal" id="qa-aha-${idx}" style="display:none">
          ${p.concepts.slice(0, 4).map(c => `<span class="topic-tag">${esc(c)}</span>`).join("")}
        </div>` : ""}
        <div class="qa-expand" id="qa-expand-${idx}" style="display:none">
          ${p.sel ? `<div class="qa-expand-quote">${esc(p.sel.slice(0, 150))}${p.sel.length > 150 ? "…" : ""}</div>` : ""}
          <div class="qa-expand-q">${esc(p.q)}</div>
          <div class="qa-expand-a">${esc(p.a).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>")}</div>
        </div>`).join("")}
    </div>` : "";

  // ── Aha moments — shown inline in Q&A rows, no separate section ──────────────
  const ahaHtml = "";

  // ── Cross-article graph ───────────────────────────────────────────────────────
  const cg = d.crossGraph;
  const crossHtml = cg?.connectedConcepts?.length ? `
    <div class="section-label mt-20">📊 Cross-Article Connections</div>
    <div class="cross-graph-card">
      ${cg.connectedConcepts.map(c => `
        <div class="cross-concept"><strong>${esc(c.concept)}</strong><span>${esc(c.insight || "")}</span></div>`).join("")}
      ${cg.suggestedTopics?.length ? `
        <div class="suggested-topics">
          <div class="section-label" style="margin:8px 0 6px">Suggested Next Reads</div>
          ${cg.suggestedTopics.map(t => `<span class="topic-tag">${esc(t)}</span>`).join("")}
        </div>` : ""}
    </div>` : "";

  renderSummary._qaPairs = qaPairs;

  return html(`
    <div class="summary-screen screen">
      <div class="sidebar-header">
        <div class="header-left">
          <span class="logo-mark">✦</span>
          <div class="header-title-stack">
            <span class="logo-text">Reading Summary</span>
            ${state.article?.title ? `<span class="article-subtitle-wrap"><span class="article-subtitle">${esc(state.article.title.slice(0, 38))}${state.article.title.length > 38 ? "…" : ""}</span><span class="article-title-tooltip">${esc(state.article.title)}</span></span>` : ""}
          </div>
        </div>
        <button class="icon-btn" id="btn-back-chat">← Back</button>
      </div>
      <div class="summary-body">
        <div class="section-label">Article Summary</div>
        <div class="summary-card">${summaryHtml}</div>
        ${conceptsHtml}${readerAnalysisHtml}${ahaHtml}${crossHtml}
      </div>
    </div>`);
}

// ── Event handlers ────────────────────────────────────────────────────────────
function attachHandlers(view) {
  if (view === "no-mode-set" || view === "no-key") {
    $("#btn-open-options")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
  }
  if (view === "no-article") {
    // arXiv PDF → link to abs page
    $("#link-arxiv-abs")?.addEventListener("click", (e) => {
      e.preventDefault();
      const url = state.article?.url || "";
      const m = url.match(/arxiv\.org\/pdf\/([^/?#v]+)/);
      if (m) chrome.tabs.update({ url: `https://arxiv.org/abs/${m[1]}` });
    });
  }
  if (view === "purpose") {
    document.querySelectorAll(".purpose-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        state.purpose = btn.dataset.purpose;
        await chrome.storage.local.set({ [`purpose:${state.article.url}`]: state.purpose });
        // Check for existing conversation first (applies to all purposes incl. interview)
        const url     = state.article.url;
        const purpose = state.purpose;
        const qKey    = `questions:${url}:${purpose}`;
        const convKey = `conv:${url}:${purpose}`;
        const histKey = `hist:${url}:${purpose}`;
        const aKey    = `answers:${url}:${purpose}`;
        const saved   = await chrome.storage.local.get([qKey, convKey, histKey, aKey]);
        // Safety net: restore summaryData if it was somehow lost (article-level, not purpose-level)
        if (!state.summaryData) {
          const sd = await chrome.storage.local.get([`summary:${url}`]);
          if (sd[`summary:${url}`]) state.summaryData = sd[`summary:${url}`];
        }
        if (state.purpose === "interview") {
          // Interview has its own session management
          await handleInterviewPurposeClick(url);
        } else if (saved[qKey] && saved[convKey]?.length > 1) {
          // Restore existing conversation for this purpose
          state.questions       = saved[qKey];
          state.questionAnswers = saved[aKey] || [];
          state.conversation    = saved[convKey];
          state.msgHistory      = saved[histKey] || [];
          await loadAhaMoments();
          render("chat");
        } else {
          await doGenerateQuestions();
        }
      });
    });
    // Load purpose badges for existing conversations
    loadPurposeBadges();

    $("#btn-purpose-history")?.addEventListener("click", () => {
      state.historyReturnView = "purpose";
      render("history");
    });
  }
  if (view === "iv-job-prompt") {
    // Back → purpose screen
    $("#btn-iv-prompt-back")?.addEventListener("click", () => render("purpose"));
    // New session → clear previous job URLs so the form starts fresh
    $("#btn-iv-add-job")?.addEventListener("click", () => { state.jobUrls = []; render("iv-new-session"); });

    // Delete buttons — stop propagation so row click doesn't fire
    document.querySelectorAll(".iv-delete-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const sessionId = btn.dataset.sid;
        const url = state.article?.url;
        if (!url || !state.ivMeta) return;
        if (!confirm("Delete this session and its conversation history?")) return;
        await deleteIVSession(url, sessionId);
        if (!state.ivMeta.sessions.length) {
          // No sessions left → go back to purpose screen
          render("purpose");
        } else {
          render("iv-job-prompt"); // re-render picker
        }
      });
    });

    // Each session row opens that session
    document.querySelectorAll(".iv-session-row--clickable").forEach(row => {
      row.addEventListener("click", async (e) => {
        if (e.target.closest(".iv-delete-btn")) return; // handled above
        const sessionId = row.dataset.sid;
        const url = state.article?.url;
        if (!url || !state.ivMeta) return;
        const session = state.ivMeta.sessions.find(s => s.id === sessionId);
        if (!session) return;

        // Update active session
        state.ivMeta.activeId = sessionId;
        state.ivSessionId = sessionId;
        state.jobUrls = session.jobUrls?.length ? session.jobUrls : (session.jobUrl ? [session.jobUrl] : []);
        await saveIVMeta(url, state.ivMeta);

        // Load this session's conversation
        const { qKey, convKey, histKey } = getIVConvKeys(url, sessionId);
        const qHistKey = getQHistKey(url, sessionId);
        const saved = await chrome.storage.local.get([qKey, convKey, histKey, qHistKey]);
        state.questionHistory = saved[qHistKey] || [];
        if (saved[qKey] && saved[convKey]?.length > 1) {
          state.questions    = saved[qKey];
          state.conversation = saved[convKey];
          state.msgHistory   = saved[histKey] || [];
          await loadAhaMoments();
          render("chat");
          loadArticleConnections();
        } else if (saved[qKey]) {
          state.questions    = saved[qKey];
          state.conversation = [{ role: "ai", text: buildQuestionsMessage(state.purpose, saved[qKey]), concepts: [] }];
          state.msgHistory   = [];
          render("chat");
          loadArticleConnections();
        } else {
          await doGenerateQuestions();
        }
      });
    });
  }
  if (view === "iv-new-session") {
    $("#btn-iv-new-back")?.addEventListener("click", () => {
      const hasSessions = state.ivMeta?.sessions?.length > 0;
      render(hasSessions ? "iv-job-prompt" : "purpose");
    });

    // Add a new URL row
    $("#btn-iv-new-add-url")?.addEventListener("click", () => {
      const list = $("#iv-new-url-list");
      if (!list) return;
      const i = list.querySelectorAll(".job-url-row").length;
      const row = document.createElement("div");
      row.className = "job-url-row";
      row.innerHTML = `<input class="job-url-input" type="url" placeholder="https://company.com/jobs/role" data-i="${i}"/>
        <button class="job-url-remove" data-i="${i}">×</button>`;
      list.appendChild(row);
      // Wire up the remove button on the newly added row
      row.querySelector(".job-url-remove")?.addEventListener("click", () => row.remove());
    });

    // Remove buttons for pre-existing rows (index > 0)
    document.querySelectorAll("#iv-new-url-list .job-url-remove").forEach(btn => {
      btn.addEventListener("click", () => btn.closest(".job-url-row")?.remove());
    });

    const startSession = async () => {
      const jobUrls = collectJobUrls().filter(u => u.length > 0);
      const url = state.article?.url;
      if (url) await startNewIVSession(url, jobUrls);
    };
    $("#btn-iv-new-start")?.addEventListener("click", startSession);
    $("#btn-iv-new-skip")?.addEventListener("click", async () => {
      const url = state.article?.url;
      if (url) await startNewIVSession(url, []);
    });
  }
  if (view === "iv-edit-links") {
    $("#btn-iv-edit-back")?.addEventListener("click", () => render("chat"));

    // Add URL row
    $("#btn-iv-edit-add-url")?.addEventListener("click", () => {
      const list = $("#iv-edit-url-list");
      if (!list) return;
      const i = list.querySelectorAll(".job-url-row").length;
      const row = document.createElement("div");
      row.className = "job-url-row";
      row.innerHTML = `<input class="job-url-input" type="url" placeholder="https://company.com/jobs/role" data-i="${i}"/>
        <button class="job-url-remove" data-i="${i}">×</button>`;
      list.appendChild(row);
      row.querySelector(".job-url-remove")?.addEventListener("click", () => row.remove());
    });

    // Remove buttons for pre-existing rows
    document.querySelectorAll("#iv-edit-url-list .job-url-remove").forEach(btn => {
      btn.addEventListener("click", () => btn.closest(".job-url-row")?.remove());
    });

    const saveLinks = async (newUrls) => {
      const url = state.article?.url;
      if (!url || !state.ivSessionId) return;

      // Snapshot current state for fallback (in case new links fail to generate questions)
      const prevQuestions = [...(state.questions || [])];
      const prevAnswers   = [...(state.questionAnswers || [])];
      const prevJobUrls   = [...(state.jobUrls || [])];

      // Archive current questions to history before regenerating
      if (state.questions?.length) {
        const histEntry = { ts: Date.now(), questions: prevQuestions, jobUrls: prevJobUrls };
        state.questionHistory = [...(state.questionHistory || []), histEntry];
        const qHistKey = getQHistKey(url, state.ivSessionId);
        await chrome.storage.local.set({ [qHistKey]: state.questionHistory });
      }

      // Update job URLs in session meta
      state.jobUrls = newUrls;
      if (state.ivMeta) {
        const session = state.ivMeta.sessions.find(s => s.id === state.ivSessionId);
        if (session) {
          session.jobUrls = newUrls;
          // Update label from first URL if available
          if (newUrls.length > 0) {
            try { session.label = new URL(newUrls[0]).hostname.replace(/^www\./, ""); } catch (_) { session.label = newUrls[0].slice(0, 30); }
          }
          await saveIVMeta(url, state.ivMeta);
        }
      }

      // Clear current questions (will be regenerated)
      state.questions = [];
      state.questionAnswers = [];
      await doGenerateQuestions({
        fallback: prevQuestions.length ? { questions: prevQuestions, answers: prevAnswers, jobUrls: prevJobUrls } : null
      });
    };

    $("#btn-iv-edit-save")?.addEventListener("click", async () => {
      const newUrls = Array.from(document.querySelectorAll("#iv-edit-url-list .job-url-input"))
        .map(el => el.value.trim()).filter(u => u.length > 0);
      await saveLinks(newUrls);
    });

    $("#btn-iv-edit-clear")?.addEventListener("click", async () => {
      await saveLinks([]);
    });
  }
  if (view === "questions") {
    $("#btn-start-chat")?.addEventListener("click", () => render("chat"));
    document.querySelectorAll(".q-show-answer-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const i = btn.dataset.i;
        const reveal = $(`#q-ans-${i}`);
        if (!reveal) return;
        const isOpen = reveal.style.display !== "none";
        reveal.style.display = isOpen ? "none" : "block";
        btn.textContent = isOpen ? "Show sample answer" : "Hide answer";
      });
    });
  }
  if (view === "chat") {
    renderChatMessages();
    const input = $("#chat-input");
    if (state.pendingLaymen && state.pendingSelection) {
      autoSendLaymen();
    } else if (state.pendingSelection) {
      prefillSelectionInput();
    }

    // Clear selection preview
    $("#btn-clear-sel")?.addEventListener("click", () => clearSelectionPreview());

    // Pinned questions: collapse/expand toggle
    let pinnedOpen = true;
    $("#pinned-toggle")?.addEventListener("click", () => {
      pinnedOpen = !pinnedOpen;
      const body = $("#pinned-body");
      const chevron = $("#pinned-chevron");
      if (body) body.style.display = pinnedOpen ? "" : "none";
      if (chevron) chevron.style.transform = pinnedOpen ? "" : "rotate(-90deg)";
    });

    // Connections section: collapse/expand toggle
    $("#connections-toggle")?.addEventListener("click", () => {
      const body = $("#connections-body");
      const chevron = $("#connections-chevron");
      if (!body) return;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      if (chevron) chevron.textContent = isOpen ? "▸" : "▾";
    });

    // Connections: click item to open article in new tab
    document.querySelectorAll(".conn-item--clickable").forEach(el => {
      el.addEventListener("click", () => {
        const url = el.dataset.url;
        if (url) chrome.tabs.create({ url });
      });
    });
    // Click question row OR the answer button to toggle the inline answer
    function togglePinnedAnswer(i) {
      const reveal = $(`#pinned-ans-${i}`);
      const btn    = $(`.pinned-ans-btn[data-i="${i}"]`);
      if (!reveal) return;
      const isOpen = reveal.style.display !== "none";
      reveal.style.display = isOpen ? "none" : "block";
      if (btn) btn.textContent = isOpen ? "▸ answer" : "▾ answer";
      // Make pinned-body scrollable when at least one answer is open
      const body = $("#pinned-body");
      if (body) {
        const anyOpen = document.querySelectorAll(".pinned-ans-reveal").length > 0 &&
          Array.from(document.querySelectorAll(".pinned-ans-reveal")).some(r => r.style.display !== "none");
        body.style.maxHeight = anyOpen ? "220px" : "";
        body.style.overflowY = anyOpen ? "auto"  : "";
      }
    }
    document.querySelectorAll(".pinned-q").forEach(el => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".pinned-ans-btn")) return;
        const wrap = el.closest(".pinned-q-wrap");
        const btn  = wrap?.querySelector(".pinned-ans-btn");
        if (btn) togglePinnedAnswer(btn.dataset.i);
      });
    });
    document.querySelectorAll(".pinned-ans-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePinnedAnswer(btn.dataset.i);
      });
    });

    // Past question sets — section toggle
    $("#past-qs-toggle")?.addEventListener("click", () => {
      const body    = $("#past-qs-body");
      const chevron = document.querySelector(".past-qs-chevron");
      if (!body) return;
      const isOpen = body.style.display !== "none";
      body.style.display = isOpen ? "none" : "block";
      if (chevron) chevron.textContent = isOpen ? "▸" : "▾";
    });

    // Past question sets — per-session collapse toggle
    document.querySelectorAll(".past-qs-set-toggle").forEach(toggle => {
      toggle.addEventListener("click", () => {
        const si       = toggle.dataset.si;
        const content  = document.getElementById(`past-qs-set-${si}`);
        const chevron  = toggle.querySelector(".past-qs-set-chevron");
        if (!content) return;
        const isOpen = content.style.display !== "none";
        content.style.display = isOpen ? "none" : "block";
        if (chevron) chevron.textContent = isOpen ? "▸" : "▾";
      });
    });

    // Edit job links (interview mode only)
    $("#btn-edit-links")?.addEventListener("click", () => render("iv-edit-links"));

    $("#btn-to-history")?.addEventListener("click", () => {
      state.historyReturnView = "chat";
      render("history");
    });

    $("#btn-change-goal")?.addEventListener("click", async () => {
      // Interview mode: show session picker instead of full purpose screen
      if (state.purpose === "interview" && state.ivMeta?.sessions?.length) {
        render("iv-job-prompt");
        return;
      }
      // Other modes: reset purpose and go back to purpose picker
      if (state.article?.url) {
        await chrome.storage.local.remove([`purpose:${state.article.url}`]);
      }
      state.purpose = null;
      state.questions = [];
      state.conversation = [];
      state.msgHistory = [];
      render("purpose");
    });

    const doSend = () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      // NOTE: do NOT clear state.pendingSelection here —
      // sendMessage() captures it first, then clears it itself.
      sendMessage(text);
    };

    $("#send-btn").addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    });

    // Aha moment buttons — event delegation on chat container
    $("#chat-messages")?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".aha-btn");
      if (!btn) return;
      const convIdx = parseInt(btn.dataset.convIdx, 10);
      if (isNaN(convIdx)) return;

      const isMarked = btn.classList.contains("aha-btn--marked");
      const conceptsEl = btn.nextElementSibling; // .aha-inline-concepts
      if (isMarked) {
        await removeAhaMoment(convIdx);
        btn.classList.remove("aha-btn--marked");
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`;
        btn.title = "Mark as a learning moment";
        if (conceptsEl) conceptsEl.innerHTML = "";
      } else {
        await saveAhaMoment(convIdx);
        btn.classList.add("aha-btn--marked");
        btn.innerHTML = "💡";
        btn.title = "Learning moment saved — click to remove";
        // Show concepts inline
        const concepts = state.conversation[convIdx]?.concepts || [];
        if (conceptsEl) {
          conceptsEl.innerHTML = concepts.slice(0, 3).map(c => `<span class="aha-concept-tag">${esc(c)}</span>`).join("");
        }
        showAhaToast();
      }
    });

    $("#btn-to-summary")?.addEventListener("click", () => {
      if (state.summaryData) {
        render("summary");
        // Never auto-regenerate here — show last saved state.
        // readerAnalysis is generated on article completion or via ↻ Update button.
      } else if (_summaryGenerating) {
        // Already in progress — do nothing (banner is showing)
      } else if (state.article) {
        onArticleComplete({ url: state.article.url }); // trigger generation
      }
    });
    input.focus();
  }
  if (view === "summary") {
    $("#btn-back-chat")?.addEventListener("click", () => render("chat"));
    $("#btn-retry-summary")?.addEventListener("click", () => {
      state.summaryData = null;
      _summaryGenerating = false;
      render("chat");
      onArticleComplete({ url: state.article?.url });
    });

    // Summary collapse/expand toggle
    $("#btn-summary-toggle")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      const full    = btn.previousElementSibling;  // .summary-full
      const preview = full?.previousElementSibling; // .summary-preview
      const isHidden = full?.classList.contains("summary-full--hidden");
      if (isHidden) {
        full?.classList.remove("summary-full--hidden");
        preview?.classList.add("summary-preview--hidden");
        btn.textContent = "Collapse ▴";
      } else {
        full?.classList.add("summary-full--hidden");
        preview?.classList.remove("summary-preview--hidden");
        btn.textContent = "Show full summary ▾";
      }
    });

    // Reader analysis refresh — silent: no banner, just re-renders inline
    $("#btn-refresh-ra")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.textContent = "updating…";
      btn.disabled = true;
      if (state.summaryData) {
        state.summaryData = { ...state.summaryData, readerAnalysis: null };
      }
      _summaryGenerating = false;
      onArticleComplete({ url: state.article?.url }, { force: true, silent: true });
    });

    // Concept "show more" toggle
    document.querySelectorAll(".concept-more-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const extra = btn.previousElementSibling; // .concept-extra div
        const isHidden = extra?.classList.contains("concept-extra--hidden");
        if (isHidden) {
          extra.classList.remove("concept-extra--hidden");
          btn.textContent = "show less";
        } else {
          extra?.classList.add("concept-extra--hidden");
          btn.textContent = `+${btn.dataset.count} more`;
        }
      });
    });

    // Aha concept reveal — 💡 button in Q&A row
    document.querySelectorAll(".qa-aha-btn").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation(); // don't also expand the Q&A row
        const idx = btn.dataset.idx;
        const reveal = $(`#qa-aha-${idx}`);
        if (!reveal) return;
        const isOpen = reveal.style.display !== "none";
        reveal.style.display = isOpen ? "none" : "flex";
      });
    });

    // Expandable Q&A rows
    document.querySelectorAll(".qa-row").forEach(row => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".jump-btn") || e.target.closest(".qa-aha-btn")) return;
        const idx = row.dataset.idx;
        const expand = $(`#qa-expand-${idx}`);
        const chevron = row.querySelector(".qa-chevron");
        const isOpen = expand?.style.display !== "none";
        if (expand) expand.style.display = isOpen ? "none" : "block";
        if (chevron) chevron.style.transform = isOpen ? "" : "rotate(90deg)";
      });
    });

    // Jump-to-source buttons
    document.querySelectorAll(".jump-btn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        const pair = renderSummary._qaPairs?.[idx];
        if (!pair?.sel) return;
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: "HIGHLIGHT_TEXT", text: pair.sel }).catch(() => {});
        }
      });
    });
  }
}

// ── Chat message rendering ────────────────────────────────────────────────────
function renderChatMessages() {
  const container = $("#chat-messages");
  if (!container) return;
  container.innerHTML = "";

  if (!state.conversation.length && !state.streaming) {
    container.innerHTML = '<div class="chat-empty">Select text on the page, or type a question</div>';
    return;
  }

  // Skip the first AI message only if it's the questions intro (not a loading indicator)
  const displayMsgs = state.conversation.filter((m, i) => !(i === 0 && m.role === "ai" && !m.loading));
  displayMsgs.forEach((m) => {
    const el = document.createElement("div");
    el.className = `msg msg-${m.role}${m.loading ? " loading-msg" : ""}`;

    if (m.role === "user") {
      // Show selected text as blockquote if present
      const quoteHtml = m.selection
        ? `<div class="selection-quote">${esc(m.selection.slice(0, 180))}${m.selection.length > 180 ? "…" : ""}</div>`
        : "";
      el.innerHTML = quoteHtml + esc(m.text)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n\n/g, "<br><br>")
        .replace(/\n/g, "<br>");
    } else {
      const textHtml = esc(m.text)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\n\n/g, "<br><br>")
        .replace(/\n/g, "<br>");

      if (!m.loading) {
        const marked = !!m.ahaMarked;
        // convIdx is the actual index in state.conversation
        const convIdx = state.conversation.indexOf(m);
        const concepts = m.concepts || [];
        const conceptTags = marked && concepts.length
          ? concepts.slice(0, 3).map(c => `<span class="aha-concept-tag">${esc(c)}</span>`).join("")
          : "";
        el.innerHTML = textHtml + `
          <div class="msg-actions">
            <button class="aha-btn${marked ? ' aha-btn--marked' : ''}"
                    data-conv-idx="${convIdx}"
                    title="${marked ? 'Learning moment saved — click to remove' : 'Mark as a learning moment'}">
              ${marked ? '💡' : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`}
            </button>
            <span class="aha-inline-concepts">${conceptTags}</span>
          </div>`;
      } else {
        el.innerHTML = textHtml;
      }
    }
    container.appendChild(el);
  });

  if (state.streaming) {
    const bubble = document.createElement("div");
    bubble.id = "streaming-bubble";
    bubble.className = "msg msg-ai streaming";
    bubble.innerHTML = state.streamText
      ? esc(state.streamText).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>")
      : "&nbsp;";
    container.appendChild(bubble);
  }

  scrollToBottom();
}

function updateStreamBubble() {
  const bubble = $("#streaming-bubble");
  if (!bubble) return;
  bubble.innerHTML = state.streamText
    ? esc(state.streamText).replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>")
    : "&nbsp;";
  scrollToBottom();
}

function scrollToBottom() {
  const c = $("#chat-messages");
  if (c) c.scrollTop = c.scrollHeight;
}

function showToast(message, durationMs = 3500) {
  const existing = document.getElementById("__rc_toast__");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "__rc_toast__";
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed", bottom: "72px", left: "50%", transform: "translateX(-50%)",
    background: "#1e1b4b", color: "#fff", padding: "8px 14px", borderRadius: "8px",
    fontSize: "12px", fontWeight: "600", zIndex: "9999", maxWidth: "90%",
    boxShadow: "0 4px 12px rgba(0,0,0,0.25)", opacity: "0",
    transition: "opacity 0.2s ease",
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = "1"; });
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, durationMs);
}

// After AI finishes, scroll to the TOP of the latest AI message.
function scrollToLatestAnswer() {
  // Double rAF ensures the DOM has fully laid out before measuring positions.
  // Use getBoundingClientRect (not offsetTop) because .chat-messages is a flex
  // container without position:relative, so offsetTop would be wrong.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const c = $("#chat-messages");
    if (!c) return;
    const msgs = c.querySelectorAll(".msg-ai:not(.loading-msg)");
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      const cRect  = c.getBoundingClientRect();
      const msgRect = last.getBoundingClientRect();
      c.scrollTop += msgRect.top - cRect.top - 8;
    }
  }));
}

// ── Aha moment recording ──────────────────────────────────────────────────────
async function saveAhaMoment(convIdx) {
  const url = state.article?.url;
  if (!url) return;
  const msg_entry = state.conversation[convIdx];
  if (!msg_entry) return;
  // Find the preceding user message
  const userMsg = state.conversation.slice(0, convIdx).reverse().find(m => m.role === "user");
  const ahaEntry = {
    convIdx,
    concepts: msg_entry.concepts || [],
    q:        (userMsg?.text || "").slice(0, 200),
    a:        msg_entry.text.slice(0, 300),
    ts:       Date.now(),
  };
  const ahaKey = `aha:${url}`;
  const stored = await chrome.storage.local.get([ahaKey]).catch(() => ({}));
  const list   = stored[ahaKey] || [];
  // Avoid duplicates
  if (!list.some(a => a.convIdx === convIdx)) list.push(ahaEntry);
  await chrome.storage.local.set({ [ahaKey]: list });
  // Update state
  state.conversation[convIdx].ahaMarked = true;
}

async function removeAhaMoment(convIdx) {
  const url = state.article?.url;
  if (!url) return;
  const ahaKey = `aha:${url}`;
  const stored = await chrome.storage.local.get([ahaKey]).catch(() => ({}));
  const list   = (stored[ahaKey] || []).filter(a => a.convIdx !== convIdx);
  await chrome.storage.local.set({ [ahaKey]: list });
  state.conversation[convIdx].ahaMarked = false;
}

async function loadAhaMoments() {
  const url = state.article?.url;
  if (!url) return;
  const ahaKey = `aha:${url}`;
  const stored = await chrome.storage.local.get([ahaKey]).catch(() => ({}));
  const list   = stored[ahaKey] || [];
  // Restore ahaMarked on existing conversation messages
  list.forEach(a => {
    if (state.conversation[a.convIdx]) {
      state.conversation[a.convIdx].ahaMarked = true;
    }
  });
}

function showAhaToast() {
  const existing = document.getElementById("aha-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "aha-toast";
  toast.innerHTML = `💡 <strong>Learning moment saved</strong>`;
  Object.assign(toast.style, {
    position: "fixed", bottom: "80px", left: "50%",
    transform: "translateX(-50%)",
    background: "#1e1b4b", color: "#fff",
    padding: "10px 16px", borderRadius: "10px",
    fontSize: "13px", fontWeight: "600",
    boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
    zIndex: "9999", textAlign: "center",
    lineHeight: "1.5", whiteSpace: "nowrap",
    animation: "aha-pop .25s ease",
  });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

// ── Purpose badges loader ─────────────────────────────────────────────────────
async function loadPurposeBadges() {
  if (!state.article?.url) return;
  const url = state.article.url;

  // Non-interview purposes: check old-style keys
  const nonIV = ["learning", "research", "general"];
  const keys  = nonIV.map(p => `questions:${url}:${p}`);
  const stored = await chrome.storage.local.get(keys);
  nonIV.forEach(p => {
    if (stored[`questions:${url}:${p}`]) {
      const btn = document.querySelector(`.purpose-btn[data-purpose="${p}"]`);
      if (btn && !btn.querySelector(".purpose-resume-badge")) {
        const badge = document.createElement("span");
        badge.className = "purpose-resume-badge";
        badge.textContent = "resume";
        btn.appendChild(badge);
      }
    }
  });

  // Interview: show badge if any session exists in iv_meta (or old-style key exists)
  const ivMeta = await loadIVMeta(url);
  const oldIV  = await chrome.storage.local.get([`questions:${url}:interview`]);
  const hasIV  = (ivMeta && ivMeta.sessions.length > 0) || !!oldIV[`questions:${url}:interview`];
  if (hasIV) {
    const ivBtn = document.querySelector(`.purpose-btn[data-purpose="interview"]`);
    if (ivBtn && !ivBtn.querySelector(".purpose-resume-badge")) {
      const sessionCount = ivMeta?.sessions.length || 1;
      const badge = document.createElement("span");
      badge.className = "purpose-resume-badge";
      badge.textContent = sessionCount > 1 ? `${sessionCount} sessions` : "resume";
      ivBtn.appendChild(badge);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function html(str) {
  const div = document.createElement("div");
  div.style.cssText = "display:contents";
  div.innerHTML = str.trim();
  return div;
}

function renderError(message, { showSettings = false, showBack = false } = {}) {
  const app = $("#app");
  app.innerHTML = "";
  const formatted = esc(message).replace(/\n/g, "<br>");
  app.appendChild(html(`
    <div class="center-screen">
      <span class="logo-xl">⚠️</span>
      <p style="white-space:pre-wrap;text-align:left;font-size:13px;line-height:1.6;max-width:240px">${formatted}</p>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:center">
        ${showBack ? '<button class="btn-secondary" id="btn-err-back">← Back</button>' : ''}
        <button class="btn-secondary" id="btn-retry">Retry</button>
        ${showSettings ? '<button class="btn-secondary" id="btn-err-settings">Settings</button>' : ''}
      </div>
    </div>`));
  $("#btn-err-back")?.addEventListener("click", () => render("purpose"));
  $("#btn-retry")?.addEventListener("click", () => state.purpose ? doGenerateQuestions() : init());
  $("#btn-err-settings")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

function collectJobUrls() {
  return Array.from(document.querySelectorAll(".job-url-input"))
    .map(el => el.value.trim());
}

function prefillSelectionInput() {
  const input = $("#chat-input");
  if (!input) return;
  if (state.pendingSelection) {
    // Show preview panel
    const preview = $("#sel-preview");
    const previewText = $("#sel-preview-text");
    if (preview) preview.style.display = "flex";
    if (previewText) previewText.textContent = state.pendingSelection.slice(0, 160) + (state.pendingSelection.length > 160 ? "…" : "");
    input.placeholder = "Ask about the selected text…";
  }
  input.focus();
}

function clearSelectionPreview() {
  state.pendingSelection = null;
  const preview = $("#sel-preview");
  if (preview) preview.style.display = "none";
  const input = $("#chat-input");
  if (input) input.placeholder = "Ask anything about this article…";
}

/** Auto-send a "laymen explanation" request for the pending selection. */
function autoSendLaymen() {
  if (!state.pendingLaymen || !state.pendingSelection) return;
  state.pendingLaymen = false;
  // Show the selection in the preview banner, then auto-send the prompt
  prefillSelectionInput();
  // Small delay so the DOM is ready
  setTimeout(() => {
    sendMessage("Please explain this in simple, plain language and give a concrete real-world example that makes it immediately obvious — as if explaining to someone who has no background in this topic.");
  }, 80);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
