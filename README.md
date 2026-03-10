# OxideNote

A local-first Markdown knowledge vault desktop application. All notes are stored as plain `.md` files on disk — no proprietary formats, no cloud lock-in. Built with **Tauri 2** (Rust) and **React 19** (TypeScript).

> This project is partially inspired by [Lumina-Note](https://github.com/blueberrycongee/Lumina-Note).

[简体中文](README.zh-CN.md)

## Features

### Editor

- **CodeMirror 6** editor with syntax highlighting for Markdown, Typst, and LaTeX
- Multi-tab editing with drag-and-drop tab reordering
- Split view with line-level scroll sync between editor and preview
- Toolbar for common formatting: headings, bold, italic, lists, tables, links, images, math blocks
- Slash commands (`/`) for quick insertion of code blocks, callouts, mermaid diagrams, and more
- WikiLink syntax (`[[Note Name]]`) with click-to-navigate and auto-completion
- Block references (`[[note#^blockId]]`)
- Tag auto-completion
- Auto-save with configurable debounce interval
- External file conflict detection and resolution UI
- Voice input via Web Speech API
- Canvas/whiteboard drawing (SVG-based)
- Audio recording as inline attachments

### Preview & Rendering

- Real-time Markdown preview via `marked`
- KaTeX math rendering (inline and block)
- Mermaid diagram rendering (flowchart, sequence, gantt, class, state, pie)
- Code block syntax highlighting (highlight.js, 100+ languages)
- Embedded Typst compiler — compiles `.typ` files to SVG/PDF with diagnostics
- PDF viewer with zoom, page navigation, text selection, and annotation support
- Presentation mode — split notes by `---` into full-screen slides

### Note Organization

- Hierarchical file tree browser with drag-and-drop file moving
- Daily notes with auto-creation (`daily/YYYY-MM-DD.md`)
- Custom note templates with variable substitution (`{{title}}`, `{{date}}`, `{{datetime}}`)
- Bookmarks / favorites
- Soft delete with 30-day auto-purge trash
- YAML frontmatter parsing for metadata (title, tags, aliases, dates)
- Attachments stored content-addressed in `.attachments/`

### Search & Discovery

- Full-text search powered by SQLite FTS5
- Quick Open file switcher (Cmd+P)
- Backlinks panel — find all notes linking to the current note
- Tag panel with frequency-based tag cloud
- Task panel — aggregates all `- [ ]` items across the vault
- Knowledge graph — force-directed visualization of note connections with a timeline slider
- Random note

### Database Views

- Parse structured data from frontmatter into five view modes: Table, Kanban, Calendar, Gallery, Timeline
- Support for column types: text, number, select, multiselect, date, checkbox, URL
- In-place data editing with real-time schema updates

### AI Integration

- Chat panel with streaming responses
- Supports multiple LLM providers: OpenAI, Claude, DeepSeek, Gemini, Moonshot, Groq, OpenRouter, Ollama, and custom OpenAI-compatible endpoints
- Inline AI transforms via slash commands: rewrite, continue, summarize, translate
- AI memory — extracts and reuses key facts from conversations
- RAG context injection from current note
- Token usage tracking (per-session and lifetime)
- Chat session persistence in SQLite

### Agent System

- 6 built-in agents: Duplicate Detector, Outline Extractor, Index Generator, Daily Review, Graph Maintainer, Typst Reviewer
- Custom agent definitions via Markdown
- Approval workflow — review proposed changes before applying
- Agent execution history

### Export & Import

- Export notes as ZIP bundle (with referenced images/files)
- Export to HTML and PDF
- Static site publishing (export vault as HTML site)
- Bulk import of `.md`, `.typ`, `.tex` files

### Security

- AES-256-GCM note encryption with Argon2id key derivation
- Per-file salt and nonce
- No key storage — derived from password on each use
- Snapshot-based version history with content-hash deduplication
- Line-level diff between versions

### Customization

- 35 built-in themes across three categories (Oxide, Classic Dark, Light)
- Custom CSS editor
- 3 UI density levels (compact, comfortable, spacious)
- Configurable editor font, size, line height, tab size, word wrap
- 11 customizable keyboard shortcuts with live key capture
- Bilingual interface (简体中文 / English)

### Other

- Command palette (Cmd+K) for all major actions
- In-app web browser with web clipping (save page as Markdown)
- Bilibili video embedding with timestamp insertion
- Vault health check and index repair
- Flashcard system with SM-2 spaced repetition
- Outline panel for heading navigation

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | [Tauri 2](https://v2.tauri.app/) |
| Backend | Rust (SQLite, Typst compiler, AES-256-GCM, Argon2id) |
| Frontend | React 19, TypeScript, Vite 7 |
| Editor | CodeMirror 6 |
| Styling | Tailwind CSS 4 |
| State management | Zustand 5 |
| UI primitives | Radix UI |
| Internationalization | i18next |
| Graph | force-graph (d3-force) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Tauri 2 system dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
pnpm install          # Install frontend dependencies
pnpm tauri dev        # Start in dev mode (frontend + Rust hot-reload)
```

### Build

```bash
pnpm tauri build      # Production build
```

### Verification

```bash
npx tsc --noEmit                    # TypeScript type check
cd src-tauri && cargo check         # Rust check
```

## Data Storage

All data stays on your machine:

```
your-vault/
├── notes.md                    # Plain Markdown files
├── daily/
│   └── 2026-03-11.md           # Daily notes
├── .attachments/               # Content-addressed attachments
└── .oxidenote/
    ├── index.db                # SQLite FTS5 index
    ├── history/                # Version snapshots
    ├── trash/                  # Soft-deleted files
    ├── flashcards/             # Spaced repetition data
    └── annotations/            # PDF annotation data
```

## License

[PolyForm Noncommercial 1.0.0](LICENSE)

## Acknowledgments

- [Lumina-Note](https://github.com/blueberrycongee/Lumina-Note) — partial inspiration for this project
