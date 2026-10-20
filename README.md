# 架势画布（dsh-jiashi）

把**架势**的非线性画布接进 DeepSeek Harness：同一份对话，既能在原生聊天里线性读，也能在画布上摆成卡片。

## 现在能做什么（v0.2）

- 左侧栏多一个**「画布」**面板行，点开是工作区级的 tldraw 画布（不是右侧栏，也不是对话的 View 标签）；
- 画布上每张卡绑定一个 **DSH 会话**：
  - 卡片里实时显示该会话的 user / assistant 消息；
  - 卡片底部输入框发送的消息，会**写进同一个会话**——切回原生「对话」就能看到；
  - 点卡片右上角「打开」→ 回到该会话的线性视图；
- 「＋ 新对话」在工作区里新建会话并放一张卡；
- 卡片位置/尺寸由 tldraw 持久化（localStorage），刷新后还在。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host：把旧版 iframe 构建挂在 `/jiashi/`（历史对照，原生版不依赖它） |
| `src/client/index.jsx` | 核心源码：React + tldraw + 会话桥（详见 [ARCHITECTURE.md](ARCHITECTURE.md)） |
| `lib/client.js` | 构建产物（DSH 客户端模块） |
| `scripts/build-client.mjs` | esbuild 构建脚本 |
| `cordis.patch.yml` | 装配声明 |

## 构建

```sh
node scripts/build-client.mjs
# 架势源码在别处时：
JIASHI_SRC=D:/path/to/Framework node scripts/build-client.mjs
```

依赖（tldraw、React 类型）从 `JIASHI_SRC` 目录的 `node_modules` 解析；`react`/`react-dom` 由 DSH 宿主提供。

## 安装 / 更新

用 `plugin_manager install_bundle` 指向本目录即可（已装进 desktop profile）。
客户端代码更新后，**刷新一次 DSH 页面**让新的客户端模块生效。

## 下一步

见 [ARCHITECTURE.md](ARCHITECTURE.md) 的路线图：卡片拆分/箭头 → 富文本卡 → 布局持久化 → 共工（多人）。
