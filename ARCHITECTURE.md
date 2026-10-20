# 架势画布（dsh-jiashi）架构说明

> 目标：让"画布"成为 DSH 会话的**非线性呈现层**——同一份对话，既能线性阅读，也能摆成卡片。
> 当前版本：v0.2（原生 tldraw 画布 + 会话卡最小闭环）。多人协作（共工）不在本阶段。

---

## 1. 四层模型（先分清，再写代码）

```
Workspace（工作区）
├─ Session（一条对话：消息 + 工具 + 模型上下文 + 运行状态）   ← DSH 的真相
│    └─ fork / 子会话（也是独立 Session）
└─ Board（画布：卡片摆在哪、连了哪些线、便签内容）           ← 插件的真相
     ├─ card(session)  一张卡 = 某个会话的一个显示单元
     ├─ card(note)     纯便签（后期）
     └─ edge            卡片之间的空间关系（后期）
```

- **线性模式** = 一条 Session 的聊天记录；
- **画布模式** = 一个 Workspace 的空间视图；
- **卡片** = 会话的显示单元。v0.2 一张卡对应整条会话；v0.3 起一张卡可以只显示会话的一段（拆分/合并只是显示层操作）。
- 你在画布上看到的"多条对话同时存在" = 同一个 Workspace 的多个 Session 卡片。

## 2. 数据归属（唯一真相原则）

| 数据 | 归属 | 存储 |
|---|---|---|
| 消息、回合、工具调用、流式回复 | DSH Session | Host 的 session log（已有持久化） |
| 会话标题、运行状态、fork 关系 | DSH Session | 已有 |
| 卡片位置/尺寸/连线/便签/视口 | 画布插件 | 现在：tldraw `persistenceKey`（localStorage）；后续迁到 Host 文件，按 workspace 存 |

**画布永远不复制消息。** 卡片通过 `ctx.sessions.retain()` 订阅会话的事件窗口，输入通过 `face.prompt()` 写回同一个会话。

## 3. "一体"的三条通路（v0.2 已实现前两条）

1. 原生输入 → session → 事件窗口 → 对应卡片实时更新（反向同理：卡片输入 → 同一个 session → 原生线性视图可见）；
2. 点卡片「打开」→ `ctx.sessions.open(sessionId)` + `ctx.layout.selectPanel(null)` → 回到该会话的线性视图；
3. （后期）卡片输入框与原生 composer 共享草稿/发送状态。

## 4. 卡片语义（按你的定义，分阶段实现）

- **一张卡可以属于同一对话**：v0.3 引入"会话显示分段"（把一条 session 的消息按轮次/区间分配给多张卡，纯展示数据，可拆可合）。
- **箭头创建出来的卡 = 同一对话**：从一条会话的卡拉箭头 → 新卡默认绑定同一个 session（v0.3 支持"从末端继续"；从中间拉箭头时提供"fork 分支/仅视觉标注"二选一）。
- **空白处新建卡**：选"新对话"（新 Session）或"加入已有对话"（该会话的新显示段）。
- **拆分只是显示**：拆卡 = 重新分配显示范围，不改 session log。

## 5. 技术结构

```
dsl-jiashi/
├─ index.js                  Host 半边：只在 webServer 上挂 /jiashi/ 静态路由（旧的 iframe 构建，保留作对照）
├─ lib/client.js             构建产物（DSH 客户端模块，window.__ModuleLoader__.load 包裹）
├─ src/client/index.jsx      客户端源码（React + tldraw + 会话桥）
├─ scripts/build-client.mjs  esbuild 构建脚本
├─ web/                      旧的 iframe 版架势构建（历史产物）
└─ cordis.patch.yml          装配声明
```

客户端源码分区（`src/client/index.jsx`）：

| 区块 | 责任 |
|---|---|
| `createSessionBridge` | `ctx.sessions.retain()/release()` 的引用计数缓存 |
| `useSessionEntry` | 卡片组件拿 binding（`face` = 生命周期快照，`eventSource` = 事件窗口） |
| `extractMessages` | 从事件窗口提取 user/assistant 文本 |
| `SessionCard` / `SessionCardInner` | 卡片 UI：标题、状态、消息列表、输入框、打开回线性 |
| `SessionCardShapeUtil` | tldraw 自定义 shape（`BaseBoxShapeUtil` + `HTMLContainer`） |
| `Board` | 主面板：`Tldraw` + 自动为当前会话放卡 + "＋ 新对话" |
| `PanelIcon` | 左侧栏面板行图标 |
| `apply` | 注册 `main` 面板与 `sidebar.panellist` 行 |

关键 DSH 接口（都来自 `@deepseek-ai/dsh-api-session-controller` 的 Client 面）：

```ts
ctx.sessions.list                    // SessionListState（ids / byId / current）
ctx.sessions.retain(id, { source })  // → ref.ready → SessionBinding
binding.session                      // SessionFace：prompt() / cancel() / rename() / snapshot
binding.eventSource                  // ObservableSnapshot<SessionEventWindow>
ctx.sessions.create({ workspaceId }) // 新建会话
ctx.sessions.open(id)                // 选中会话（原生视图跟着切）
ctx.layout.selectPanel(null)         // 从全局面板回到对话
```

## 6. 构建

```sh
node scripts/build-client.mjs    # esbuild 打包 → lib/client.js（约 3.5MB）
```

- 依赖（tldraw / react 类型）从架势源码目录的 `node_modules` 解析，可用 `JIASHI_SRC` 覆盖；
- `react` / `react-dom` / `react/jsx-runtime` 由 DSH 宿主提供（external）；
- tldraw 的 CSS 作为文本打进 bundle，`apply()` 时注入一次。

## 7. 路线图

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.2 | 左侧栏画布面板 + 原生 tldraw + 会话卡（读消息、发消息、回线性、新对话） | ✅ 本轮 |
| v0.3 | 卡片拆分/合并、箭头（同会话续接 / fork 分支）、卡片标题实时更新、消息流式渲染 | 下一步 |
| v0.4 | 便签卡、Markdown 富文本卡、从 DSH 拖文件/会话到画布 | |
| v0.5 | 画布布局持久化到 Host（按 workspace 的 board.json），跨设备/刷新恢复 | |
| v1.0 | 共工：多人 + 多 agent 在画布上讨论 | 暂缓 |

## 8. 已知限制（v0.2）

- 一张卡显示**整条会话**，还不能拆分；
- 助手回复目前**在整条消息落库后**才出现（未处理 live chunk 流式片段）；
- 卡片位置存在浏览器 localStorage（tldraw persistenceKey），刷新能恢复，但换设备/换端口会丢；
- 消息用纯文本渲染（无 Markdown/KaTeX/工具卡片）；
- 没有卡片设置/删除的 UI，删除卡片会留下 session（符合"画布只是呈现层"的语义）。
