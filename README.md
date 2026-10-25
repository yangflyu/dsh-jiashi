# 架势画布（dsh-jiashi）

把**架势**的非线性画布接进 DeepSeek Harness：同一份对话，既能在原生聊天里线性读，也能在画布上摆成卡片；画布上输入的消息写回同一条 DSH 会话。

> 当前版本 **v0.7.0**。架构细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> 名字暂定 `dsh-jiashi`；「共工」（多人协作模式）是后续阶段。

## 现在能做什么

- 左侧栏「画布」面板 → 工作区级 tldraw 画布（不是右侧栏，也不是对话的 View 标签）。
- **对话卡**绑定真实 DSH 会话：
  - 卡片里实时显示消息 + 流式回复；
  - 卡片输入框写进同一个会话，切回「对话」可见；
  - 卡头「打开」回到该会话的线性视图。
- **分段显示**：用户消息悬停「✂ 拆出」→ 右侧新卡（同一会话的下一段）；「⇤ 合并」拼回去。会话日志不动。
- **会话续接**：拉出/插入子卡、手动画箭头连接空白卡 → 自动继承同一会话，从父卡结束位置之后继续。
- **统一到 DSH**：普通文本方框第一次发 AI 消息时自动创建 DSH 会话并绑定，旧的本地 AI 不再使用；纯便签卡不发消息就不会建会话。
- **标题同步**：卡片标题还是「标题待定」时显示会话标题（自定义标题优先）。
- **持久化**：切走画布/刷新后，卡片、连线、绑定、拆分范围都还在。
- **启动安全**：插件注册失败只写日志，不会阻断 DSH 启动。
- 原版架势能力保留：块级 Markdown 编辑、KaTeX、注意力模式（Alt+T）、线性视图、快捷键设置、AI 设置面板。

## 常用操作

| 操作 | 方式 |
|---|---|
| 新建对话卡 | 工具栏「＋ 对话卡」（新建 DSH 会话） |
| 新建普通文本方框 | 工具栏「＋ 文本方框」 |
| 拆块 | 双击文本 → 点进某一块 → 光标处 **Ctrl/⌘ + \\** |
| 拆卡（拆成两张卡） | 块编辑态 **Ctrl/⌘ + Shift + \\**，或点块右上角「拆成新卡」 |
| 拆卡/合并 | 用户消息悬停「✂ 拆出」；分段卡头部「⇤ 合并」 |
| 清理空卡 | 工具栏「清理空卡」（删除无内容、未绑定会话的文本方框，可撤销） |
| 专注模式 | 工具栏「专注」或 **Alt+T** |

完整快捷键见画布「快捷键」面板。

> `Ctrl/⌘ + \\` 被 DSH 自带的「拆分窗格」命令占用（桌面端原生键盘桥在页面之前拦截）。想在架势里用它拆卡：到 DSH「设置 → 快捷键」把「拆分窗格」的绑定清掉即可。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`/jiashi/api/log`（诊断日志）、`/jiashi/api/session/create`、`/jiashi/` 静态资源 |
| `src/client/index.jsx` | 客户端入口：注册面板、注入样式、标题 Context、启动安全 |
| `src/jiashi/` | 从架势源码复制的 App / 组件 / 卡片 shape / 会话桥（改动尽量局部） |
| `lib/client.js` | 构建产物（DSH 客户端模块，约 5MB） |
| `scripts/build-client.mjs` | esbuild 构建脚本（CSS 文本化、KaTeX 字体内联） |
| `cordis.patch.yml` | 装配声明 |
| `web/` | 旧的 iframe 版构建，仅作历史对照 |

## 构建

```sh
node scripts/build-client.mjs
# 架势源码在别处时：
JIASHI_SRC=D:/path/to/Framework node scripts/build-client.mjs
```

依赖从 `JIASHI_SRC/node_modules` 解析；`react` / `react-dom` 由 DSH 宿主提供。

## 安装 / 更新

用 `plugin_manager install_bundle` 指向本目录（已装进 desktop profile）。
客户端代码更新后刷新一次 DSH 页面（或等 HMR 生效）即可。

## 排查

- 诊断日志：`C:\Users\<你>\.dsh\jiashi\board.log`（JSON 行；`module.load` / `activate.error` / `board.mount` / `session.*` / `editor.split`）。
- 启动失败：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`；恢复对话框会禁用第三方插件并备份 profile patch。

## 下一步

见 [ARCHITECTURE.md](ARCHITECTURE.md) 路线图：键盘作用域收敛、首屏模块懒加载、画布布局持久化到 Host，最后是「共工」多人协作。
