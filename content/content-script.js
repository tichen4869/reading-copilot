/**
 * Reading Copilot — Content Script
 *
 * Responsibilities:
 *  - Extract article text from the page
 *  - Detect "article complete" via scroll-to-bottom OR 1-hour inactivity
 *  - Show a floating "Ask Copilot" button on text selection
 *  - Register the current article with the service worker
 */

(function () {
  "use strict";

  // Don't run inside iframes or extension pages
  if (window !== window.top) return;
  if (location.protocol === "chrome-extension:") return;

  const MAX_ARTICLE_CHARS = 60000; // cap to control token use (~15k words, covers most academic papers)
  const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 hour in ms

  // Normalize URL for storage keys — strip hash fragments and trailing slashes
  // so that scrolling (which may add #section IDs) doesn't break key consistency.
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return u.toString().replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  // ── Extract article text ───────────────────────────────────────────────────

  function extractArticleText() {
    // Priority selectors for well-known article containers
    const candidates = [
      "article",
      '[role="main"]',
      ".post-content",
      ".article-content",
      ".entry-content",
      ".story-body",
      ".article-body",
      "#article-body",
      "main",
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const text = el.innerText?.trim();
        if (text && text.length > 500) {
          return text.slice(0, MAX_ARTICLE_CHARS);
        }
      }
    }

    // Fallback: strip nav/footer noise from body
    const clone = document.body.cloneNode(true);
    for (const tag of ["nav", "header", "footer", "aside", "script", "style", "noscript"]) {
      clone.querySelectorAll(tag).forEach((el) => el.remove());
    }
    return (clone.innerText || "").trim().slice(0, MAX_ARTICLE_CHARS);
  }

  // ── Register article with service worker ───────────────────────────────────

  function registerArticle() {
    chrome.runtime.sendMessage({
      type: "REGISTER_ARTICLE",
      url: normalizeUrl(location.href),
      title: document.title,
      text: extractArticleText(),
    }).catch(() => {
      // Sidebar may not be open yet — that's fine
    });
  }

  // ── Article completion detection ───────────────────────────────────────────

  let articleCompleted = false;

  function onArticleComplete(trigger) {
    if (articleCompleted) return;
    articleCompleted = true;

    // Notify service worker — it will generate the summary and update the graph
    chrome.runtime.sendMessage({
      type: "ARTICLE_COMPLETE",
      url: normalizeUrl(location.href),
      title: document.title,
      text: extractArticleText(),
      trigger, // "scroll" | "inactivity"
    }).catch(() => {});

    // Also signal the sidebar via storage so it can switch to summary view
    chrome.storage.local.set({ articleCompleteSignal: { url: normalizeUrl(location.href), trigger, ts: Date.now() } });
  }

  // Scroll-to-bottom: IntersectionObserver on a sentinel appended to body.
  // Minimum 10s delay prevents firing immediately on short/fast-loading pages.
  function setupScrollDetection() {
    const sentinel = document.createElement("div");
    sentinel.id = "__rc_sentinel__";
    sentinel.style.cssText = "height:1px;pointer-events:none;";
    document.body.appendChild(sentinel);

    let readyToFire = false;
    setTimeout(() => { readyToFire = true; }, 10000); // 10s minimum reading time

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && readyToFire) onArticleComplete("scroll");
      },
      { threshold: 1.0 }
    );
    observer.observe(sentinel);
  }

  // Inactivity: 1-hour timer reset on any user interaction
  let inactivityTimer = null;

  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => onArticleComplete("inactivity"), INACTIVITY_TIMEOUT);
  }

  ["mousemove", "keydown", "scroll", "click", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, resetInactivityTimer, { passive: true });
  });

  // ── Floating "Ask Copilot" button on text selection ───────────────────────

  let floatingBtn = null;

  function removeFloatingBtn() {
    floatingBtn?.remove();
    floatingBtn = null;
  }

  function showFloatingBtn(rect, selectedText) {
    removeFloatingBtn();

    floatingBtn = document.createElement("div");
    floatingBtn.id = "__rc_floating_btn__";

    const top  = rect.top + window.scrollY - 52;
    const left = rect.left + rect.width / 2;

    const BASE_STYLE = [
      "display:inline-flex", "align-items:center", "gap:5px",
      "padding:6px 12px", "border-radius:7px", "border:none",
      "font-size:12px", "font-weight:700",
      "font-family:system-ui,-apple-system,sans-serif",
      "cursor:pointer", "white-space:nowrap", "user-select:none", "letter-spacing:0.01em",
    ].join(";");

    floatingBtn.innerHTML = `
      <button id="__rc_ask__"     style="${BASE_STYLE};background:#1e1b4b;color:#fff">✦ Ask Copilot</button>
      <button id="__rc_laymen__"  style="${BASE_STYLE};background:#f0fdf4;color:#166534;border:1px solid #bbf7d0">🧑‍🏫 Explain simply</button>`;

    Object.assign(floatingBtn.style, {
      position:   "absolute",
      top:        `${top}px`,
      left:       `${left}px`,
      transform:  "translateX(-50%)",
      display:    "flex",
      gap:        "6px",
      zIndex:     "2147483647",
      boxShadow:  "0 4px 14px rgba(0,0,0,0.22)",
      borderRadius: "9px",
      background: "#fff",
      padding:    "4px",
    });

    // "Ask Copilot" — original behaviour
    floatingBtn.querySelector("#__rc_ask__").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ pendingSelection: selectedText });
      chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" }).catch(() => {});
      registerArticle();
      removeFloatingBtn();
    });

    // "Explain simply" — auto-sends a laymen prompt
    floatingBtn.querySelector("#__rc_laymen__").addEventListener("click", (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ pendingSelection: selectedText, pendingLaymen: true });
      chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" }).catch(() => {});
      registerArticle();
      removeFloatingBtn();
    });

    document.body.appendChild(floatingBtn);
  }

  document.addEventListener("mouseup", (e) => {
    // If the click was on our own floating button, do nothing — let the click handler run
    if (floatingBtn && floatingBtn.contains(e.target)) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (text && text.length >= 15) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      showFloatingBtn(rect, text);
    } else {
      // Small delay so click on the button itself registers first
      setTimeout(removeFloatingBtn, 150);
    }
  });

  // ── Prompt card: appears after 2s, invites user to set reading purpose ───────

  const PURPOSES = [
    { key: "interview", icon: "💼", label: "Interview",  desc: "Trade-offs & implications" },
    { key: "learning",  icon: "📖", label: "Learning",   desc: "Grasp core concepts" },
    { key: "research",  icon: "🔬", label: "Research",   desc: "Methods & evidence" },
    { key: "general",   icon: "🌐", label: "General",    desc: "Key takeaways" },
  ];

  function showPromptCard() {
    if (document.getElementById("__rc_prompt_card__")) return;

    const card = document.createElement("div");
    card.id = "__rc_prompt_card__";
    Object.assign(card.style, {
      position: "fixed", bottom: "20px", right: "20px",
      background: "#1e1b4b", color: "#fff",
      borderRadius: "16px", padding: "16px",
      width: "248px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
      zIndex: "2147483646", userSelect: "none",
    });

    const btnStyle = `
      background:rgba(255,255,255,.09);border:1.5px solid rgba(255,255,255,.13);
      border-radius:10px;padding:9px 10px;cursor:pointer;text-align:left;
      color:#fff;font-family:system-ui,sans-serif;width:100%;display:block;
    `;

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px">
          <span style="color:#a5b4fc">✦</span> Reading Copilot
        </div>
        <button id="__rc_x__" style="background:none;border:none;color:rgba(255,255,255,.35);font-size:16px;cursor:pointer;padding:0;line-height:1">×</button>
      </div>
      <div style="font-size:12px;color:rgba(255,255,255,.55);margin-bottom:10px">What's your reading goal?</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
        ${PURPOSES.map(p => `
          <button class="__rc_purpose__" data-key="${p.key}" style="${btnStyle}">
            <div style="font-size:15px;margin-bottom:4px">${p.icon}</div>
            <div style="font-size:12px;font-weight:600">${p.label}</div>
            <div style="font-size:10px;color:rgba(255,255,255,.45);margin-top:2px;line-height:1.3">${p.desc}</div>
          </button>
        `).join("")}
      </div>
    `;

    document.body.appendChild(card);

    card.querySelector("#__rc_x__").addEventListener("click", () => card.remove());

    card.querySelectorAll(".__rc_purpose__").forEach(btn => {
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "rgba(255,255,255,.18)";
        btn.style.borderColor = "rgba(255,255,255,.3)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "rgba(255,255,255,.09)";
        btn.style.borderColor = "rgba(255,255,255,.13)";
      });
      btn.addEventListener("click", () => {
        const purpose = btn.dataset.key;
        chrome.storage.local.set({ pendingPurpose: purpose });
        registerArticle(); // ensure fresh article data is registered before sidebar opens
        chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" }).catch(() => {});
        card.remove();
      });
    });

    // No auto-dismiss — stays until user picks a purpose or clicks ×
  }

  // ── Resume card: for returning to an article already in progress ──────────

  function showResumeCard(purpose) {
    if (document.getElementById("__rc_resume_card__")) return;
    if (document.getElementById("__rc_prompt_card__")) return; // don't show both

    const purposeLabels = { interview: "💼 Interview", learning: "📖 Learning", research: "🔬 Research", general: "🌐 General" };
    const label = purposeLabels[purpose] || "✦ Reading";

    const card = document.createElement("div");
    card.id = "__rc_resume_card__";
    Object.assign(card.style, {
      position: "fixed", bottom: "20px", right: "20px",
      background: "#1e1b4b", color: "#fff",
      borderRadius: "14px", padding: "14px 16px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
      zIndex: "2147483646", userSelect: "none",
      display: "flex", alignItems: "center", gap: "12px",
      minWidth: "200px",
    });

    card.innerHTML = `
      <div style="flex:1">
        <div style="font-size:12px;color:rgba(255,255,255,.5);margin-bottom:3px">Reading Copilot</div>
        <div style="font-size:13px;font-weight:600">${label} session</div>
      </div>
      <button id="__rc_resume_btn__" style="
        background:#6366f1;border:none;border-radius:8px;
        color:#fff;font-size:12px;font-weight:600;
        padding:7px 14px;cursor:pointer;white-space:nowrap;
      ">Resume ↗</button>
      <button id="__rc_resume_x__" style="background:none;border:none;color:rgba(255,255,255,.35);font-size:16px;cursor:pointer;padding:0;line-height:1;margin-left:2px">×</button>
    `;

    document.body.appendChild(card);

    card.querySelector("#__rc_resume_btn__").addEventListener("click", () => {
      registerArticle();
      chrome.runtime.sendMessage({ type: "OPEN_SIDEBAR" }).catch(() => {});
      card.remove();
    });
    card.querySelector("#__rc_resume_x__").addEventListener("click", () => card.remove());
  }

  // ── Message listener (from sidebar / options) ─────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "HIGHLIGHT_TEXT") {
      highlightTextInPage(msg.text);
    }
    if (msg.type === "SHOW_PURPOSE_CARD") {
      showPromptCard();
    }
    if (msg.type === "SHOW_RESUME_CARD") {
      const url = normalizeUrl(location.href);
      chrome.storage.local.get([`purpose:${url}`]).then(stored => {
        // Remove any existing cards first
        document.getElementById("__rc_resume_card__")?.remove();
        document.getElementById("__rc_prompt_card__")?.remove();
        const purpose = stored[`purpose:${url}`];
        if (purpose) {
          // Check if this purpose has questions (new scoped key format)
          chrome.storage.local.get([`questions:${url}:${purpose}`]).then(qs => {
            if (qs[`questions:${url}:${purpose}`]) {
              showResumeCard(purpose);
            } else {
              showPromptCard();
            }
          });
        } else {
          showPromptCard();
        }
      });
    }
  });

  // Find text in page, highlight it yellow, and scroll to it
  function highlightTextInPage(searchText) {
    if (!searchText) return;
    // Remove previous highlights
    document.querySelectorAll(".__rc_hl__").forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    });
    // Use window.find to locate the text (cross-browser, works in Chrome)
    const found = window.find(searchText.slice(0, 80), false, false, true, false, false, false);
    if (found) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const mark = document.createElement("mark");
        mark.className = "__rc_hl__";
        mark.style.cssText = "background:#fef08a;border-radius:2px;padding:0 1px;";
        try {
          range.surroundContents(mark);
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
          sel.removeAllRanges();
        } catch (_) {
          // surroundContents fails if range crosses element boundaries — just scroll
          mark.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }

  // ── PDF page detection ────────────────────────────────────────────────────
  // Chrome's native PDF viewer sandboxes all content inside a plugin/shadow root,
  // so mouseup events from PDF text selections never reach the content script.
  // Text selection (floating button) is fundamentally unsupported on PDF pages.
  // We show a banner pointing users to an HTML alternative where it DOES work.

  function isPDFPage() {
    if (document.contentType === "application/pdf") return true;
    const path = location.pathname.toLowerCase();
    if (path.endsWith(".pdf")) return true;
    if (location.hostname.includes("arxiv.org") && path.startsWith("/pdf/")) return true;
    return false;
  }

  function getHTMLAlternativeUrl() {
    // arXiv: /pdf/ID → /html/ID (try HTML first; abs always works as fallback)
    if (location.hostname.includes("arxiv.org")) {
      const m = location.pathname.match(/\/pdf\/([^/?#v]+)/);
      if (m) return { html: `https://arxiv.org/html/${m[1]}`, abs: `https://arxiv.org/abs/${m[1]}`, label: "HTML" };
    }
    return null;
  }

  function showPDFBanner() {
    if (document.getElementById("__rc_pdf_banner__")) return;

    const alt = getHTMLAlternativeUrl();
    const banner = document.createElement("div");
    banner.id = "__rc_pdf_banner__";

    Object.assign(banner.style, {
      position: "fixed", top: "0", left: "0", right: "0",
      background: "#1e1b4b", color: "#fff",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "13px", fontWeight: "500",
      padding: "10px 16px",
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
      zIndex: "2147483647",
      boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
    });

    const btnStyle = `
      background: #6366f1; border: none; border-radius: 7px;
      color: #fff; font-size: 12px; font-weight: 700;
      padding: 6px 14px; cursor: pointer; white-space: nowrap; flex-shrink: 0;
    `;
    const closeBtnStyle = `
      background: none; border: none; color: rgba(255,255,255,.4);
      font-size: 18px; cursor: pointer; padding: 0; line-height: 1; flex-shrink: 0;
    `;

    banner.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;min-width:0">
        <span style="color:#a5b4fc;font-size:15px">✦</span>
        <span style="color:rgba(255,255,255,.75)">
          Text selection isn't available in PDF viewer.
          ${alt ? `Open the <strong style="color:#fff">HTML version</strong> to use Ask Copilot on selected text.` : ""}
        </span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${alt ? `<button id="__rc_pdf_html__" style="${btnStyle}">Open HTML →</button>` : ""}
        <button id="__rc_pdf_close__" style="${closeBtnStyle}">×</button>
      </div>
    `;

    document.body?.appendChild(banner) || document.documentElement.appendChild(banner);

    document.getElementById("__rc_pdf_close__")?.addEventListener("click", () => banner.remove());

    if (alt) {
      document.getElementById("__rc_pdf_html__")?.addEventListener("click", async () => {
        // Try HTML version first; fall back to abs if it 404s
        try {
          const res = await fetch(alt.html, { method: "HEAD", signal: AbortSignal.timeout(4000) });
          location.href = res.ok ? alt.html : alt.abs;
        } catch (_) {
          location.href = alt.abs;
        }
      });
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  registerArticle();

  if (isPDFPage()) {
    // On PDF pages: show banner immediately (no scroll detection or floating button needed)
    showPDFBanner();
  } else {
    setupScrollDetection();
    resetInactivityTimer();

    // On page load: check if user already chose a reading purpose for this URL.
    // If yes → open sidebar directly (they're returning to an article in progress).
    // If no  → show the purpose selection card after 2s.
    setTimeout(async () => {
      const url = normalizeUrl(location.href);
      const stored = await chrome.storage.local.get([`purpose:${url}`]);
      const purpose = stored[`purpose:${url}`];
      if (purpose) {
        // Check if this purpose has questions saved (new scoped key format)
        const qs = await chrome.storage.local.get([`questions:${url}:${purpose}`]);
        if (qs[`questions:${url}:${purpose}`]) {
          // Returning to an article in progress — show resume card (needs user gesture to open sidebar)
          showResumeCard(purpose);
        } else {
          showPromptCard();
        }
      } else {
        // New article — show the full purpose picker
        showPromptCard();
      }
    }, 2000);
  }
})();
