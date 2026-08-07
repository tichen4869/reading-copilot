# Reading Copilot

A Chrome Extension (Manifest V3) sidebar that turns any article into an interactive AI-powered reading session — with guided questions, grounded Q&A, interview prep, article summaries, and a cross-article knowledge graph.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=google-chrome) ![MV3](https://img.shields.io/badge/Manifest-V3-green) ![Anthropic](https://img.shields.io/badge/Powered%20by-Claude-orange)

---

## Features

### Reading Modes
Choose your intent before you start — the AI tailors everything to your goal:

| Mode | What it does |
|---|---|
| 💼 Interview Prep | Generates role-specific interview questions; supports multiple job links per session |
| 📖 Learn Concepts | Extracts core ideas, builds a cross-article concept graph |
| 🔬 Deep Research | Surfaces arguments, implications, and counterpoints |
| 👀 General Read | Key takeaways and main ideas |

### Guided Questions
- AI-generated guiding questions pinned in the chat header
- Click any question to expand a sample answer inline
- Multiple answers open simultaneously — scrollable
- Edit job links mid-session (interview mode) — only questions refresh, conversation stays intact
- Past question sets preserved and viewable when links are updated

### Grounded Q&A Chat
- Highlight any passage → floating menu appears:
  - **Ask Copilot** — pre-fills selection as context for your question
  - **Explain simply** 🧑‍🏫 — one click auto-sends a plain-language explanation with real-world examples
- Full conversation persists per article per mode

### Article Summary
- Auto-generated after you finish reading
- Collapsible — preview the first paragraph, expand to read all
- Q&A breakdown with aha moment markers (💡)
- Tracks learning moments you marked during the session

### Aha Moments (💡)
- Mark any AI answer as a learning moment mid-chat
- Saved concepts appear as inline tags next to the lightbulb
- Viewable in the summary Q&A list

### Cross-Article Connections
- Detects conceptual links to past articles you've read
- Builds up over sessions as your reading history grows

### Interview Session Management
- Multiple sessions per article, each with independent conversation history
- Sessions shown by date with rename/delete support
- Edit job links within an active session without losing chat history

### Reading History
- Browse all articles you've read with Reading Copilot
- Filter by recency; click any article to reopen it in a new tab with its full conversation restored

---

## Installation

1. **Clone this repo**
   ```bash
   git clone https://github.com/YOUR_USERNAME/reading-copilot.git
   ```

2. **Open Chrome Extensions**
   Navigate to `chrome://extensions/`

3. **Enable Developer Mode**
   Toggle "Developer mode" in the top-right corner

4. **Load Unpacked**
   Click "Load unpacked" and select the cloned folder

5. **Configure API Key**
   Click the extension icon → Options → enter your [Anthropic API key](https://console.anthropic.com/)

---

## AI Backend Options

| Mode | Description |
|---|---|
| ☁️ API Key | Calls Anthropic Claude via service worker — best quality, requires API key |
| 🦙 Ollama | Calls a local Ollama instance at `http://localhost:11434` — private, free |
| 🧠 WebLLM | Runs a local model in-browser via WebGPU — no server needed, ~2GB first-run download |

---

## Tech Stack

- **Chrome Extension Manifest V3** — sidePanel API, service worker, content scripts
- **Anthropic Claude API** — with prompt caching for efficiency
- **Vanilla JS + CSS** — no build step, no bundler, no framework
- **WebLLM** — optional in-browser LLM via WebGPU (Phi-3.5-mini)

---

## Project Structure

```
reading-copilot/
├── manifest.json              # Extension manifest (MV3)
├── background/
│   └── service-worker.js      # API calls, streaming, prompt caching
├── content/
│   └── content-script.js      # Article extraction, floating selection menu
├── sidebar/
│   ├── sidebar.html           # Sidebar UI shell
│   ├── sidebar.js             # All UI logic and state management
│   ├── sidebar.css            # Styles
│   └── webllm.bundle.js       # WebLLM engine (optional local AI)
├── options/
│   ├── options.html           # Settings page
│   └── options.js
└── icons/
```

---

## Privacy

- Article text is sent to the Anthropic API (or processed locally in Ollama/WebLLM mode)
- All conversation history and reading data is stored locally in `chrome.storage.local`
- No analytics, no tracking, no external services beyond the AI backend you choose

---

## License

MIT
