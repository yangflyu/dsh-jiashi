# 架势画布（dsh-jiashi）架构说明

> 目标：让"画布"成为 DSH 会话的**非线性呈现层**——同一份对话，既能线性阅读，也能摆成卡片；画布上产生的新对话也写回同一条 DSH 会话。
> 当前版本：**v0.7.0**（原生架势 UI + DSH 会话一体 + 分段/合并 + 持久化 + 启动安全修复）。多人协作（共工）不在本阶段。

---

## 1. 四层模型（先分清，再写代码）

```
Workspace（工作区）
├─ Session（一条对话：消息 + 工具 + 模型上下文 + 运行状态）   ← DSH 的真相
│    └─ fork / 子会话（也是独立 Session）
└─ Board（画布：卡片摆在哪、连了哪些线、便签内容）           ← 插件的真相
     ├─ card(session)  一张卡 = 某个会话的一个显示单元（可多张卡显示同一会话的不同段）
     ├─ card(note)     纯便签卡（不绑定会话，只存 markdown 文本）
     └─ edge            卡片之间的空间关系（箭头）
```

- **线性模式** = 一条 Session 的聊天记录（原生 DSH 对话）。
- **画布模式** = 一个 Workspace 的空间视图。
- **卡片 = 会话的显示单元**，不是消息容器：多张卡可以属于同一条会话；拆/合只是显示层操作，不改 session log。

## 2. 数据归属（唯一真相原则）

| 数据 | 归属 | 存储 |
|---|---|---|
| 消息、回合、工具调用、流式回复 | DSH Session | Host 的 session log |
| 会话标题、运行状态、fork 关系 | DSH Session | 已有 |
| 卡片位置/尺寸/连线/便签/视口/拆分范围 | tldraw store（画布插件） | `persistenceKey="dsh-jiashi-board-v1"`（IndexedDB，绑定当前 origin） |
| 卡片 ↔ 会话的绑定 | tldraw shape props | `conversationId`（DSH `session-<uuid>`）+ `sessionFromSeq` / `sessionToSeq` |

**画布永远不复制消息。** 卡片通过 `ctx.sessions.retain()` 订阅会话事件窗口，输入通过 `face.prompt()` 写回同一个会话；标题通过 `useSessions` 的投影读出来。

## 3. "一体"的通路

1. **原生输入 → 卡片**：`binding.eventSource` 订阅 `user/message`、`assistant/message`（durable）与 `assistant/live-chunk`（transient 流式片段）。
2. **卡片输入 → 原生**：`face.prompt([{ type: 'text', text }], 'queue')` 写进同一会话，切回「对话」即可见。
3. **打开回原生**：`ctx.get('uiWorkspace').openSession(sessionId)`。
4. **统一到 DSH（v0.6）**：未绑定会话的普通文本方框，第一次在 AI 输入栏发消息时，自动创建一条 DSH 会话、写入 `conversationId`，并把刚输入的那句通过 `SessionThread` 的 `pendingPrompt` 送进会话——旧的本地 AI 不再接收新消息。
5. **标题同步（v0.5）**：插件入口用 `useSessions` 把"按 sessionId 查标题"放进 React Context（`session/SessionInfo.tsx`）；卡片标题为「标题待定」时显示会话标题，用户自定义标题优先。

## 4. 卡片语义

- **一张卡可以是会话的一段**：`sessionFromSeq`（从第几条消息起，含）/ `sessionToSeq`（到第几条止，含；缺省=尾巴，用 `SESSION_TAIL_SEQ` 哨兵）。
- **拆分只是显示**：用户消息上的「✂ 拆出」→ 当前卡收窄 `sessionToSeq`，右侧新建同会话卡从下一条开始，并连一条箭头。
- **合并也是显示**：「⇤ 合并」把分段卡合回上一张（上一张接上范围，删掉本卡和连线）。
- **卡内子框拆成两个**：编辑某张卡时，光标放进某个子框（user 条目）→ 按 Ctrl+Enter（或点右上角「拆」）→ 这个子框在光标处变成两个子框，**仍在同一张卡里**；不改会话数据。
- **箭头创建出来的卡 = 同一对话**：
  - 拉出/插入子卡：创建时继承 `conversationId`，并从父卡结束位置之后续接；
  - 手动画箭头连接两张**已有**文本块：目标没有会话时继承来源的会话（`session.inherit` 日志），已有会话不覆盖。
- **空白处新建卡**：工具栏「＋ 对话卡」= 新建 DSH 会话并放卡；「＋ 文本方框」= 纯便签 / 之后可首次发消息自动转成对话卡。

## 5. 仓库结构

```
dsh-jiashi/
├─ index.js                    Host 半边：/jiashi/api/log（诊断）、/jiashi/api/session/create（建会话）、/jiashi/ 静态资源
├─ lib/client.js               构建产物（DSH 客户端模块，window.__ModuleLoader__.load 包裹，~5MB）
├─ src/client/index.jsx        客户端入口：注入 CSS、注册 main / sidebar.panellist、会话标题 Context、启动安全
├─ src/jiashi/                 从 Framework/src 复制的架势源码（改动尽量局部）
│   ├─ App.tsx / App.css       画布 App：工具栏、Tldraw、注意力/线性视图、箭头继承、空卡清理
│   ├─ components/             TextBlockContent、MarkdownBlockEditor、AIInputBar、MarkdownPreview、AttentionMode…
│   ├─ shapes/TextBlockShapeUtil.tsx   卡片 shape（props、拉出、标题、会话绑定）
│   ├─ session/                bridge.ts（retain 缓存/建会话）、SessionThread.tsx（会话线程）、SessionInfo.tsx（标题 Context）
│   ├─ keyboard/               原版快捷键系统（KeyboardInterceptor / ShortcutEditor）
│   ├─ md/                     markdown 块切分/拼接
│   └─ ai/                     旧本地 AI（只保留给历史数据渲染；新消息不再走这里）
├─ scripts/build-client.mjs    esbuild 打包脚本（CSS→文本、KaTeX 字体内联）
├─ web/                        旧的 iframe 版架势构建（历史对照，原生版不依赖）
└─ cordis.patch.yml            装配声明
```

## 6. 关键接口（客户端）

```ts
// 注册 UI（注意：必须用 slots.inject 等父入口声明 slot，否则冷启动会失败）
ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'jiashi', locale: 'jiashi' }, BoardEntry))
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ id: 'jiashi', order: 20, label }, PanelIcon))
ctx.locale.register('jiashi', { zh, en })

// 会话数据
const ref = await ctx.sessions.retain(sessionId, { source: 'jiashi-board' })
const { session, eventSource } = ref.ready           // session: SessionFace（prompt/cancel/rename/snapshot）
binding.eventSource.getSnapshot()                    // SessionEventWindow（durable + transient）
await session.prompt([{ type: 'text', text }], 'queue')

// 宿主路由（客户端 fetch）
POST /jiashi/api/log            // 诊断日志 → $DSH_HOME/jiashi/board.log
POST /jiashi/api/session/create // 新建会话（Host 侧 sessionController.create）
```

## 7. 启动安全（v0.4.4 的教训）

- 客户端插件行只要有一个 entry `failed`，桌面端 **web boot 审计**就会判定启动失败，弹出"应用无法启动"。
- 曾经的 bug：`apply` 里直接注册一个临时探针到 `shell.overlay`，冷启动时父入口还没声明该 slot → 抛 `slot "shell.overlay" is not declared` → entry failed → DSH 打不开。
- 现在的规则：
  1. **所有 slot 注册用 `ctx.slots.inject(slot, () => register(...))`**，等父入口声明后再注册；
  2. 任何注册/初始化异常都只写 `board.log`（`activate.error`），**不抛出 apply**；
  3. 诊断日志：`module.load`、`activate.error`、`board.mount`、`board.crash`、`session.*`、`editor.split` 等。

## 8. 构建 & 安装

```sh
node scripts/build-client.mjs     # → lib/client.js
# 架势源码不在默认位置时：
JIASHI_SRC=D:/path/to/Framework node scripts/build-client.mjs
```

- `react` / `react-dom` / `react/jsx-runtime` 由 DSH 宿主提供（external），其余依赖从 `JIASHI_SRC/node_modules` 解析；
- tldraw / App / KaTeX 的 CSS 作为文本打进 bundle，`apply()` 时注入一次；
- 安装/更新：`plugin_manager install_bundle`（目标指向本目录），客户端代码更新后刷新 DSH 页面或等 HMR。

## 9. 快捷键（当前）

| 键 | 作用 |
|---|---|
| **Ctrl/⌘ + Enter** | 在块编辑态把**光标所在的子框拆成两个子框**（仍在同一张卡里） |
| **Ctrl/⌘ + Shift + \\** | 同上的子框拆分，走 DSH 命令注册表（桌面端原生键盘桥分发） |
| **Ctrl/⌘ + \\** | ⚠️ 被 DSH 的「拆分窗格」（`pane.split`）占用，桌面端原生键盘桥在页面之前拦截；在 DSH 设置里清掉该绑定后，它也能用于拆子框（DOM 兜底监听） |
| **Alt + T** | 进入/退出注意力模式 |
| **Esc** | 退出块编辑 → 卡片编辑 → 注意力模式（逐级） |
| 原版快捷键 | 选择/文本/箭头/连线等，见「快捷键」面板（可按原版方式改绑） |

> 子框拆分快捷键走 DSH 的命令注册表（`ctx.shortcuts.register`，id `jiashi.split-item`），桌面端由原生键盘桥分发，可在 DSH「设置 → 快捷键」改键。鼠标兜底：块编辑态右上角「拆」。

## 10. 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.2 | 左侧栏画布面板 + 原生 tldraw + 会话卡（读/发消息、回线性、新对话） | ✅ |
| v0.3 | 原生架势 UI 移植（自定义工具栏、块级 Markdown、注意力/线性视图、快捷键、AI 设置） | ✅ |
| v0.4 | 对话卡绑定真实会话、拆分（✂）/合并、流式渲染、持久化、启动安全修复 | ✅ |
| v0.5 | 会话标题同步、空卡清理、手动画箭头继承会话 | ✅ |
| v0.6 | 普通文本方框的旧本地 AI 统一到 DSH 会话（首次发送自动建会话） | ✅ |
| v0.7 | Ctrl+\ 拆块（捕获阶段兜底 + 块首/尾插入空块） | ✅ |
| v0.8 | 定位：Ctrl+\ 被 DSH「拆分窗格」原生抢占，DOM 收不到按键 | ✅ |
| v0.9 | 拆卡试验（把卡片拆成两张卡；代码保留，不再是主交互） | ✅ |
| v0.10 | **子框拆分**：光标所在的 user 子框拆成两个子框（仍在同一张卡），Ctrl+Enter / DSH 命令 / 「拆」按钮 | ✅ |
| 下一步 | 键盘作用域收敛（把全局监听收进画布容器）、首屏 5MB 模块懒加载 | 计划 |
| 后续 | 画布布局持久化到 Host（按 workspace 的 board.json）、从 DSH 拖会话/文件到画布 | 计划 |
| v1.0 | 共工：多人 + 多 agent 在画布上讨论 | 暂缓 |

## 11. 已知限制（v0.10）

- tldraw 持久化在浏览器 IndexedDB（绑定 `dsh-app://app/` origin），换端口/换承载方式会看起来"数据没了"；按 workspace 存到 Host 是后续项。
- tldraw 本地写入有 ~350ms 节流，切走面板前最后一下编辑可能来不及落盘。
- 客户单模块约 5MB，首屏加载偏慢（懒加载优化待做）。
- 旧本地 AI 的历史数据保留为静态卡片，不迁移到 DSH 会话。
- 多人协作（共工）未开始。
