# Reading Copilot · 阅读副驾驶

[English](#english) | [中文](#中文)

---

## English

A Chrome Extension (Manifest V3) sidebar that turns any article into an interactive AI-powered reading session — with guided questions, grounded Q&A, interview prep, article summaries, and a cross-article knowledge graph.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=google-chrome) ![MV3](https://img.shields.io/badge/Manifest-V3-green) ![Anthropic](https://img.shields.io/badge/Powered%20by-Claude-orange)

### Features

#### Reading Modes
Choose your intent before you start — the AI tailors everything to your goal:

| Mode | What it does |
|---|---|
| 💼 Interview Prep | Generates role-specific interview questions; supports multiple job links per session |
| 📖 Learn Concepts | Extracts core ideas, builds a cross-article concept graph |
| 🔬 Deep Research | Surfaces arguments, implications, and counterpoints |
| 👀 General Read | Key takeaways and main ideas |

#### Guided Questions
- AI-generated guiding questions pinned in the chat header
- Click any question to expand a sample answer inline
- Multiple answers open simultaneously — scrollable
- Edit job links mid-session (interview mode) — only questions refresh, conversation stays intact
- Past question sets preserved and viewable when links are updated

#### Grounded Q&A Chat
- Highlight any passage → floating menu appears:
  - **Ask Copilot** — pre-fills selection as context for your question
  - **Explain simply** 🧑‍🏫 — one click auto-sends a plain-language explanation with real-world examples
- Full conversation persists per article per mode

#### Article Summary
- Auto-generated after you finish reading
- Collapsible — preview the first paragraph, expand to read all
- Q&A breakdown with aha moment markers (💡)

#### Aha Moments (💡)
- Mark any AI answer as a learning moment mid-chat
- Saved concepts appear as inline tags next to the lightbulb
- Viewable in the summary Q&A list

#### Cross-Article Connections
- Detects conceptual links to past articles you've read
- Builds up over sessions as your reading history grows

#### Interview Session Management
- Multiple sessions per article, each with independent conversation history
- Sessions shown by date with rename/delete support
- Edit job links within an active session without losing chat history

#### Reading History
- Browse all articles you've read with Reading Copilot
- Filter by recency; click any article to reopen it in a new tab with its full conversation restored

### Installation

1. **Clone this repo**
   ```bash
   git clone https://github.com/tichen4869/reading-copilot.git
   ```
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the cloned folder
5. Click the extension icon → **Options** → enter your [Anthropic API key](https://console.anthropic.com/)

### AI Backend Options

| Mode | Description |
|---|---|
| ☁️ API Key | Calls Anthropic Claude via service worker — best quality, requires API key |
| 🦙 Ollama | Calls a local Ollama instance at `http://localhost:11434` — private, free |
| 🧠 WebLLM | Runs a local model in-browser via WebGPU — no server needed, ~2GB first-run download |

### Tech Stack
- Chrome Extension Manifest V3 — sidePanel API, service worker, content scripts
- Anthropic Claude API — with prompt caching for efficiency
- Vanilla JS + CSS — no build step, no bundler, no framework
- WebLLM — optional in-browser LLM via WebGPU (Phi-3.5-mini)

### Privacy
- Article text is sent to the Anthropic API (or processed locally in Ollama/WebLLM mode)
- All conversation history and reading data stored locally in `chrome.storage.local`
- No analytics, no tracking, no external services beyond the AI backend you choose

### License
MIT

---

## 中文

一个 Chrome 扩展（Manifest V3），在侧边栏将任何文章变成 AI 驱动的交互式阅读体验 —— 包含引导式提问、基于原文的问答、面试备考、文章总结和跨文章知识图谱。

![Chrome Extension](https://img.shields.io/badge/Chrome-扩展-blue?logo=google-chrome) ![MV3](https://img.shields.io/badge/Manifest-V3-green) ![Anthropic](https://img.shields.io/badge/驱动-Claude-orange)

### 功能介绍

#### 阅读模式
开始前选择你的阅读目标，AI 会根据目标定制所有内容：

| 模式 | 功能 |
|---|---|
| 💼 面试备考 | 根据职位链接生成针对性面试问题，支持同一会话多个岗位链接 |
| 📖 概念学习 | 提取核心概念，构建跨文章概念知识图谱 |
| 🔬 深度研究 | 梳理论点、影响和反驳视角 |
| 👀 通用阅读 | 提炼关键要点和核心观点 |

#### 引导式提问
- AI 生成的引导问题固定显示在聊天顶部
- 点击任意问题可在原地展开参考答案
- 支持同时展开多个答案，可滚动查看
- 面试模式下可在会话中途编辑职位链接 —— 只刷新问题，对话历史完整保留
- 更新职位链接时，历史问题集会被存档并可随时查看

#### 基于原文的问答
- 划选任意段落 → 浮出菜单：
  - **Ask Copilot（问副驾驶）** —— 将所选内容作为上下文预填入输入框
  - **Explain simply（通俗解释）** 🧑‍🏫 —— 一键自动发送，用大白话加真实例子解释选中内容
- 每篇文章每种模式的对话历史完整保留

#### 文章总结
- 读完后自动生成总结
- 可折叠 —— 默认显示第一段，点击展开全文
- 包含带顿悟标记（💡）的问答列表

#### 顿悟时刻（💡）
- 在聊天中随时将 AI 回答标记为学习收获
- 标记的概念以内联标签形式显示在灯泡旁边
- 在总结页面可查看所有标记内容

#### 跨文章关联
- 自动检测与过往阅读文章的概念关联
- 随着阅读积累，关联网络不断丰富

#### 面试会话管理
- 每篇文章支持多个独立会话，各自保留独立对话历史
- 按日期展示会话，支持重命名和删除
- 在当前会话中编辑职位链接，不影响已有对话记录

#### 阅读历史
- 浏览所有用 Reading Copilot 读过的文章
- 按时间筛选；点击任意文章可在新标签页中完整恢复该文章的对话

### 安装方法

1. **克隆仓库**
   ```bash
   git clone https://github.com/tichen4869/reading-copilot.git
   ```
2. 在 Chrome 中打开 `chrome://extensions/`
3. 开启右上角的**开发者模式**
4. 点击**加载已解压的扩展程序** → 选择克隆的文件夹
5. 点击扩展图标 → **选项** → 填入你的 [Anthropic API Key](https://console.anthropic.com/)

### AI 后端选项

| 模式 | 说明 |
|---|---|
| ☁️ API Key | 通过 Service Worker 调用 Anthropic Claude —— 效果最好，需要 API Key |
| 🦙 Ollama | 调用本地 Ollama（`http://localhost:11434`）—— 完全私密，免费 |
| 🧠 WebLLM | 在浏览器内通过 WebGPU 运行本地模型 —— 无需服务器，首次下载约 2GB |

### 技术栈
- Chrome Extension Manifest V3 —— sidePanel API、Service Worker、Content Scripts
- Anthropic Claude API —— 启用 Prompt Caching 提升效率
- 原生 JS + CSS —— 无需构建工具、打包器或框架
- WebLLM —— 可选的浏览器内 LLM（Phi-3.5-mini，WebGPU 驱动）

### 隐私说明
- 文章内容会发送给 Anthropic API（或在 Ollama/WebLLM 模式下本地处理）
- 所有对话历史和阅读数据均存储在本地 `chrome.storage.local`，不上传任何服务器
- 无埋点、无追踪，除所选 AI 后端外无任何外部服务

### 许可证
MIT
