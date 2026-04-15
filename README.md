# 🧠 Tallei AI

> A cross-AI ghost memory system that bridges Claude, ChatGPT, and Gemini.

Tallei is a high-performance, persistent memory layer for AI assistants. It enables your AIs to remember facts, preferences, and context across sessions and platforms. Our primary goal is to make memory I/O blazingly fast so Claude's MCP tools never block your workflow.


![Tallei Home](./dashboard/public/tallei-home.png)

## ✨ Features

- **Cross-AI Shared Context:** Share a single memory graph between Claude, ChatGPT, and Gemini using OAuth.
- **Blazing Fast MCP Server:** Sub-10ms latency for saving memories using a fire-and-forget architecture.
- **Lightning Fast Recall:** ~5ms latency on warm cache for recalling vector search results (60s TTL).
- **Beautiful Workspace UI:** A modern Next.js dashboard with a sleek light greenish-yellow and lime theme for managing your AI's memories.
- **Seamless Integrations:** Step-by-step connector wizards for easy setup with Claude Desktop and ChatGPT.
- **Smart Summarization:** OpenAI `gpt-4o-mini` summarization extracts titles, key points, and decisions automatically in the background.

## 🛠 Tech Stack

- **Backend:** Node.js, Express, MCP (Model Context Protocol) Server
- **Frontend:** Next.js (App Router), Tailwind CSS v4
- **Database:** PostgreSQL with `pgvector` extension
- **AI/Embeddings:** OpenAI `text-embedding-3-small` and `gpt-4o-mini`, `mem0ai` SDK
- **Authentication:** Google OAuth with Session JWTs

## 🏗 Architecture Overview

Tallei is split into two main components:

- **`/src` (Backend):** The Node.js/Express server that runs the MCP server. It handles vector embeddings, background summarization, PostgreSQL connections, and OAuth token caching.
- **`/dashboard` (Frontend):** The Next.js web interface where users can view their memory feed, search past context, and generate connector URLs via a 4-step wizard.

## 🚀 Getting Started

To get Tallei running locally, check out our comprehensive setup guide:

👉 **[Read the Setup Guide (setup.md)](./setup.md)**

## 🤝 Contributing

We welcome contributions! When adding new MCP tools or API routes, please keep performance in mind. If an operation hits OpenAI or a vector DB, always implement caching to maintain our sub-100ms latency standard.

- Use conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `perf:`).
- Run `npx tsc --noEmit` in `dashboard/` to catch TypeScript errors after UI changes.

## 📄 License

MIT License.
