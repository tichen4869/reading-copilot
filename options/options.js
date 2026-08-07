"use strict";

const $ = (id) => document.getElementById(id);

// ── Load saved settings ───────────────────────────────────────────────────────
async function load() {
  const { aiMode, apiKey, ollamaUrl, ollamaModel, webllmModel } =
    await chrome.storage.local.get(["aiMode", "apiKey", "ollamaUrl", "ollamaModel", "webllmModel"]);

  // Activate correct mode button & panel
  setMode(aiMode || null, false);

  if (apiKey)     $("api-key").value      = apiKey;
  if (ollamaUrl)  $("ollama-url").value   = ollamaUrl;
  if (ollamaModel) $("ollama-model").value = ollamaModel;
  if (webllmModel) $("webllm-model").value = webllmModel;

  await loadStats();
}

// ── Mode selector ─────────────────────────────────────────────────────────────
function setMode(mode, updateStorage = false) {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  ["webllm", "ollama", "apikey"].forEach((m) => {
    const panel = $(`panel-${m}`);
    if (panel) panel.classList.toggle("active", m === mode);
  });
  if (updateStorage && mode) {
    chrome.storage.local.set({ aiMode: mode });
  }
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => setMode(btn.dataset.mode, true));
});

// ── Save ──────────────────────────────────────────────────────────────────────
$("btn-save").addEventListener("click", async () => {
  const status = $("status");
  const { aiMode, apiKey: existingKey } = await chrome.storage.local.get(["aiMode", "apiKey"]);

  if (!aiMode) {
    status.textContent = "Please select an AI mode first.";
    status.className = "status err";
    return;
  }

  const toSave = { aiMode };
  const isFirstSave = !existingKey; // first time setting API key

  if (aiMode === "apikey") {
    const key = $("api-key").value.trim();
    if (!key) { status.textContent = "API Key is required."; status.className = "status err"; return; }
    if (!key.startsWith("sk-")) { status.textContent = "API Key should start with sk-"; status.className = "status err"; return; }
    toSave.apiKey = key;
  }

  if (aiMode === "ollama") {
    toSave.ollamaUrl   = $("ollama-url").value.trim()   || "http://localhost:11434";
    toSave.ollamaModel = $("ollama-model").value.trim() || "llama3.2";
  }

  if (aiMode === "webllm") {
    toSave.webllmModel = $("webllm-model").value;
  }

  await chrome.storage.local.set(toSave);
  status.textContent = "✓ Saved!";
  status.className = "status ok";

  // On first successful save: notify the active tab's content script to show the
  // purpose card, then close the options page so the user lands back on the article.
  if (isFirstSave) {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "SHOW_PURPOSE_CARD" }).catch(() => {});
    }
    setTimeout(() => window.close(), 900);
  } else {
    setTimeout(() => { status.textContent = ""; }, 2500);
  }
});

// ── Clear data ────────────────────────────────────────────────────────────────
$("btn-clear").addEventListener("click", async () => {
  if (!confirm("Clear all reading history and knowledge graph? This cannot be undone.")) return;
  await chrome.storage.local.clear();
  $("api-key").value = "";
  $("ollama-url").value = "";
  $("ollama-model").value = "";
  setMode(null, false);
  $("status").textContent = "✓ Cleared";
  $("status").className = "status ok";
  await loadStats();
  setTimeout(() => { $("status").textContent = ""; }, 2500);
});

// ── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const data  = await chrome.storage.local.get("knowledgeGraph");
  const graph = data.knowledgeGraph || { articles: [], concepts: {}, sessionCount: 0 };
  $("stat-articles").textContent = graph.articles.length;
  $("stat-concepts").textContent = Object.keys(graph.concepts).length;
  $("stat-sessions").textContent = graph.sessionCount || 0;
}

document.addEventListener("DOMContentLoaded", load);
