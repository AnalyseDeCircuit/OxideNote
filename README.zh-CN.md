# OxideNote

一款本地优先的 Markdown 知识库桌面应用。所有笔记以纯 `.md` 文件存储在本地磁盘——没有私有格式，没有云端锁定。基于 **Tauri 2**（Rust）和 **React 19**（TypeScript）构建。

> 本项目部分灵感来源于 [Lumina-Note](https://github.com/blueberrycongee/Lumina-Note)。

[English](README.md)

## 功能特性

### 编辑器

- 基于 **CodeMirror 6** 的编辑器，支持 Markdown、Typst、LaTeX 语法高亮
- 多标签编辑，支持拖拽排序标签页
- 分栏视图，编辑器与预览行级同步滚动
- 工具栏：标题、加粗、斜体、列表、表格、链接、图片、数学公式等常用格式
- 斜杠命令（`/`）快速插入代码块、提示框、Mermaid 图表等
- WikiLink 语法（`[[笔记名]]`），点击导航，自动补全
- 块引用（`[[笔记#^blockId]]`）
- 标签自动补全
- 自动保存，防抖间隔可配置
- 外部文件冲突检测与解决界面
- 语音输入（Web Speech API）
- 画布 / 白板绘图（SVG）
- 录音功能，作为内联附件保存

### 预览与渲染

- 基于 `marked` 的实时 Markdown 预览
- KaTeX 数学公式渲染（行内与块级）
- Mermaid 图表渲染（流程图、时序图、甘特图、类图、状态图、饼图）
- 代码块语法高亮（highlight.js，100+ 语言）
- 内嵌 Typst 编译器——将 `.typ` 文件编译为 SVG/PDF，并报告诊断信息
- PDF 查看器，支持缩放、翻页、文字选择和批注
- 演示模式——以 `---` 分割笔记为全屏幻灯片

### 笔记组织

- 层级文件树浏览器，支持拖拽移动文件
- 每日笔记，自动创建（`daily/YYYY-MM-DD.md`）
- 自定义笔记模板，支持变量替换（`{{title}}`、`{{date}}`、`{{datetime}}`）
- 收藏 / 书签
- 软删除，30 天自动清理回收站
- YAML 前置元数据解析（标题、标签、别名、日期）
- 附件按内容哈希存储在 `.attachments/` 目录

### 搜索与发现

- 基于 SQLite FTS5 的全文搜索
- 快速打开文件切换器（Cmd+P）
- 反向链接面板——查找所有链接到当前笔记的笔记
- 标签面板，按频率排序的标签云
- 任务面板——汇集库中所有 `- [ ]` 待办项
- 知识图谱——力导向布局的笔记关系可视化，带时间轴滑块
- 随机笔记

### 数据库视图

- 从前置元数据解析结构化数据，提供五种视图：表格、看板、日历、画廊、时间线
- 支持列类型：文本、数字、单选、多选、日期、复选框、URL
- 就地编辑数据，实时更新 schema

### AI 集成

- AI 聊天面板，支持流式响应
- 多 LLM 提供商：OpenAI、Claude、DeepSeek、Gemini、Moonshot、Groq、OpenRouter、Ollama，以及自定义 OpenAI 兼容端点
- 斜杠命令内联 AI 变换：改写、续写、总结、翻译
- AI 上下文记忆——从对话中提取关键信息并复用
- 当前笔记 RAG 上下文注入
- Token 用量追踪（按会话及累计）
- 聊天会话持久化存储（SQLite）

### 智能体系统

- 6 个内置智能体：重复检测、大纲提取、索引生成、每日回顾、图谱维护、Typst 审校
- 支持通过 Markdown 自定义智能体
- 审批工作流——在应用变更前预览和确认
- 智能体执行历史记录

### 导出与导入

- 导出笔记为 ZIP 包（包含引用的图片和文件）
- 导出为 HTML 和 PDF
- 静态站点发布（将整个知识库导出为 HTML 站点）
- 批量导入 `.md`、`.typ`、`.tex` 文件

### 安全

- AES-256-GCM 笔记加密，Argon2id 密钥派生
- 每个文件独立的盐值和随机数
- 不存储密钥——每次从密码派生
- 基于快照的版本历史，按内容哈希去重
- 版本间行级差异对比

### 自定义

- 35 个内置主题，分为三类（Oxide 系列、经典深色、浅色）
- 自定义 CSS 编辑器
- 3 种 UI 密度（紧凑、舒适、宽松）
- 可配置编辑器字体、字号、行高、缩进、自动换行
- 11 个可自定义快捷键，支持实时按键捕获
- 双语界面（简体中文 / English）

### 其他

- 命令面板（Cmd+K）快速访问所有主要操作
- 内置 Web 浏览器，支持网页裁剪（保存为 Markdown）
- Bilibili 视频嵌入与时间戳插入
- 知识库健康检查与索引修复
- 闪卡系统（SM-2 间隔重复算法）
- 大纲面板（按标题导航）

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | [Tauri 2](https://v2.tauri.app/) |
| 后端 | Rust（SQLite、Typst 编译器、AES-256-GCM、Argon2id） |
| 前端 | React 19、TypeScript、Vite 7 |
| 编辑器 | CodeMirror 6 |
| 样式 | Tailwind CSS 4 |
| 状态管理 | Zustand 5 |
| UI 基础组件 | Radix UI |
| 国际化 | i18next |
| 图谱 | force-graph（d3-force） |

## 快速开始

### 前置条件

- [Node.js](https://nodejs.org/)（v18+）
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install)（stable 工具链）
- Tauri 2 系统依赖——参见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)

### 开发

```bash
pnpm install          # 安装前端依赖
pnpm tauri dev        # 启动开发模式（前端 + Rust 热重载）
```

### 构建

```bash
pnpm tauri build      # 生产构建
```

### 验证

```bash
npx tsc --noEmit                    # TypeScript 类型检查
cd src-tauri && cargo check         # Rust 检查
```

## 数据存储

所有数据保留在本地：

```
your-vault/
├── notes.md                    # 纯 Markdown 文件
├── daily/
│   └── 2026-03-11.md           # 每日笔记
├── .attachments/               # 按内容寻址的附件
└── .oxidenote/
    ├── index.db                # SQLite FTS5 索引
    ├── history/                # 版本快照
    ├── trash/                  # 软删除文件
    ├── flashcards/             # 间隔重复数据
    └── annotations/            # PDF 批注数据
```

## 许可证

[PolyForm Noncommercial 1.0.0](LICENSE)

## 致谢

- [Lumina-Note](https://github.com/blueberrycongee/Lumina-Note)——本项目的部分灵感来源
