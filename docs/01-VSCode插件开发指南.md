# VSCode 插件开发指南

> 本文档回答：**如何开发一个基于 VSCode 的插件服务**。涵盖扩展概念、环境准备、脚手架、结构剖析、核心能力、调试与打包全流程。

---

## 一、什么是 VSCode 扩展（插件）

VSCode 扩展（Extension）是基于 TypeScript/JavaScript 开发的模块，通过 VSCode 暴露的 [Extension API](https://code.visualstudio.com/api) 增强编辑器能力：命令、自定义 UI（Webview）、侧边栏视图、状态栏、语言服务、调试器等。

### 运行机制

- **Extension Host（扩展宿主进程）**：扩展运行在独立的 Node.js 进程中，与 VSCode 主进程隔离，避免扩展崩溃影响编辑器。
- **激活事件（Activation Events）**：扩展默认不加载，仅当触发指定事件（如执行命令、打开特定文件、视图被显示）时才激活（`activate()`），保证启动性能。
- **贡献点（Contribution Points）**：在 `package.json` 中静态声明扩展能力（命令、菜单、视图、配置项等），VSCode 启动时读取，无需运行扩展代码即可注册。

### 扩展能做什么（与本项目相关）

| 能力                                   | 说明                                     | 本插件用途               |
| -------------------------------------- | ---------------------------------------- | ------------------------ |
| **Command（命令）**              | 注册命令，可通过命令面板/快捷键/菜单触发 | 打开聊天面板             |
| **Webview**                      | 在编辑器/面板中渲染自定义 HTML/CSS/JS    | 聊天界面 UI 载体         |
| **Views Containers（视图容器）** | 在侧边栏/面板区添加自定义视图入口        | 侧边栏 Agent 入口        |
| **Configuration（配置项）**      | 声明用户可配置的 Settings                | 服务地址 base URL        |
| **Menus（菜单）**                | 在各处右键菜单/命令面板注入项            | 编辑器右键"发送到 Agent" |

---

## 二、开发环境准备

### 2.1 必备工具

| 工具                              | 说明                          | 安装方式                             |
| --------------------------------- | ----------------------------- | ------------------------------------ |
| **Node.js**（LTS）          | 扩展运行时与构建工具链依赖    | https://nodejs.org/                  |
| **Git**                     | 版本管理与发布                | https://git-scm.com/                 |
| **VS Code**                 | 开发与调试 IDE                | https://code.visualstudio.com/       |
| **Yeoman + generator-code** | 官方脚手架，生成扩展项目骨架  | `npm install -g yo generator-code` |
| **vsce**                    | 打包与发布工具，生成`.vsix` | `npm install -g @vscode/vsce`      |

### 2.2 验证环境

```bash
node -v        # >= 18 LTS
npm -v
git --version
code -v        # VS Code 命令行
yo --version   # Yeoman
```

---

## 三、脚手架创建项目

### 3.1 生成项目

在目标父目录执行（生成到子文件夹）：

```bash
yo code
```

按提示选择（推荐配置）：

```
? What type of extension do you want to create? New Extension (TypeScript)
? What's the name of your extension? ai-agent-chat
? What's the identifier of your extension? ai-agent-chat
? What's the description of your extension? AI Agent 对话面板 - 对接自有 AI 服务
? Initialize a git repository? Yes
? Bundle the source code with webpack? (选 esbuild 更快)  -> 选 esbuild
? Which package manager to use? npm
? Do you want to open the new folder with Visual Studio Code? Open with `code`
```

> **为何选 TypeScript + esbuild**：官方推荐组合，类型安全 + 极快构建速度。esbuild 已取代 webpack 成为默认推荐打包器。

### 3.2 生成的项目结构

```
ai-agent-chat/
├── src/
│   └── extension.ts          # 扩展入口（activate/deactivate）
├── package.json              # 扩展清单（元数据 + 贡献点声明）
├── tsconfig.json             # TypeScript 配置
├── esbuild.js                # esbuild 打包脚本
├── .vscode/
│   └── launch.json           # 调试配置（F5 启动 Extension Development Host）
├── .vscodeignore             # 打包时排除的文件
├── CHANGELOG.md
├── README.md
└── vsc-extension-quickstart.md
```

### 3.3 首次运行验证

1. 在生成的项目中打开 `src/extension.ts`。
2. 按 `F5`（或运行命令 **Debug: Start Debugging**）。
3. VSCode 会启动一个新的 **Extension Development Host** 窗口。
4. 在新窗口按 `Ctrl+Shift+P`，执行 **Hello World** 命令。
5. 看到右下角通知 "Hello World from ai-agent-chat!" 即成功。

---

## 四、插件结构剖析

### 4.1 `package.json` —— 扩展清单（核心）

`package.json` 既是 npm 包描述，也是扩展声明文件。VSCode 专有字段：

```jsonc
{
  "name": "ai-agent-chat",
  "displayName": "AI Agent 对话面板",
  "version": "0.0.1",
  "engines": { "vscode": "^1.85.0" },   // 兼容的 VSCode 版本
  "main": "./dist/extension.js",         // esbuild 打包后的入口
  "activationEvents": [],                // 留空：现代 VSCode 基于 contributes 自动推断激活
  "contributes": {                       // ★ 贡献点：静态声明扩展能力
    "commands": [
      { "command": "aiAgentChat.openPanel", "title": "打开 Agent 对话" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "ai-agent-sidebar", "title": "AI Agent", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "ai-agent-sidebar": [
        { "id": "aiAgent.sessions", "name": "会话" }
      ]
    },
    "configuration": {
      "title": "AI Agent",
      "properties": {
        "aiAgentChat.serviceBaseUrl": {
          "type": "string",
          "default": "http://127.0.0.1:8002",
          "description": "AI 服务的 Base URL"
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run package",
    "package": "esbuild --bundle --platform=node --format=cjs --outfile=dist/extension.js",
    "compile": "esbuild --bundle --watch --platform=node --format=cjs --outfile=dist/extension.js",
    "watch": "npm run compile"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "esbuild": "^0.20.0",
    "typescript": "^5.3.0"
  }
}
```

关键字段说明：

| 字段                 | 作用                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `engines.vscode`   | 声明最低兼容 VSCode 版本，决定可用 API 范围                                                    |
| `main`             | 扩展激活后加载的入口文件（打包产物）                                                           |
| `activationEvents` | 激活时机；现代版本可留空，由`contributes` 自动推断（如 `onCommand:aiAgentChat.openPanel`） |
| `contributes`      | **贡献点**：扩展能力的静态声明，是开发中最常编辑的部分                                   |

### 4.2 `src/extension.ts` —— 入口

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // 扩展激活时调用，注册命令、监听器等
    const disposable = vscode.commands.registerCommand('aiAgentChat.openPanel', () => {
        // 打开聊天面板的逻辑
    });
    context.subscriptions.push(disposable);
}

export function deactivate() {
    // 扩展停用时清理资源（可选）
}
```

- `activate()`：扩展被激活时执行一次。所有命令注册、事件监听都在这里完成。
- `context.subscriptions`：注册的 Disposable 推入此数组，扩展停用时自动释放，避免内存泄漏。
- `deactivate()`：通常无需实现，除非有异步资源需要显式释放（返回 Promise 可等待清理完成）。

### 4.3 贡献点（Contributes）速览

贡献点是 `package.json` 中 `contributes` 对象下的静态声明，VSCode 启动时读取，无需运行扩展代码即可生效。常用贡献点：

| 贡献点              | 作用                                       | 本插件示例                |
| ------------------- | ------------------------------------------ | ------------------------- |
| `commands`        | 注册命令 ID + 标题                         | `aiAgentChat.openPanel` |
| `menus`           | 把命令注入到右键菜单/编辑器标题栏/命令面板 | 编辑器右键"发送到 Agent"  |
| `viewsContainers` | 在活动栏（侧边栏）添加图标入口             | AI Agent 侧边栏图标       |
| `views`           | 在视图容器内添加树视图/WebView 视图        | 会话列表                  |
| `configuration`   | 声明用户 Settings 配置项                   | 服务地址 base URL         |
| `keybindings`     | 绑定快捷键到命令                           | `Ctrl+Shift+A` 打开面板 |
| `icon`            | 扩展图标                                   | 市场展示                  |

---

## 五、核心能力：Webview（本插件 UI 载体）

聊天面板需要富交互 UI（消息气泡、输入框、流式渲染），VSCode 原生控件不足以表达，因此使用 **Webview**。

### 5.1 什么是 Webview

Webview 是 VSCode 内嵌的 iframe 沙箱，可加载任意 HTML/CSS/JS，拥有完全的 UI 自由度。常用于：聊天界面、表单、数据可视化。

### 5.2 创建 Webview Panel

```typescript
import * as vscode from 'vscode';

export function openChatPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'aiAgentChat',                      // 内部标识
        'AI Agent 对话',                     // 面板标题
        vscode.ViewColumn.One,              // 显示在哪一栏
        {
            enableScripts: true,            // ★ 必须，否则内嵌 JS 不执行
            retainContextWhenHidden: true,  // 隐藏时保留状态（避免重载丢会话）
        }
    );

    // 注入 HTML
    panel.webview.html = getWebviewContent();

    // 监听 Webview 发来的消息
    panel.webview.onDidReceiveMessage(
        (message) => {
            switch (message.command) {
                case 'sendMessage':
                    // 处理用户发送的消息（调用服务端 SSE）
                    break;
            }
        },
        undefined,
        context.subscriptions
    );
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><style>/* 聊天 UI 样式 */</style></head>
<body>
  <div id="messages"></div>
  <textarea id="input"></textarea>
  <button id="sendBtn">发送</button>
  <script>
    const vscode = acquireVsCodeApi();      // ★ Webview 专用 API
    document.getElementById('sendBtn').addEventListener('click', () => {
      const text = document.getElementById('input').value;
      vscode.postMessage({ command: 'sendMessage', text });
    });
    window.addEventListener('message', (event) => {
      // 接收扩展主进程推来的流式回复
      const msg = event.data;
    });
  </script>
</body>
</html>`;
}
```

### 5.3 Webview ↔ 扩展主进程通信

这是本插件的核心架构（详见 [02-服务集成方案.md](./02-服务集成方案.md)）：

```
┌─────────────────┐  postMessage   ┌──────────────────┐  HTTP / SSE  ┌──────────────┐
│   Webview (UI)  │ ─────────────▶ │  扩展主进程       │ ───────────▶ │  AI 服务      │
│  HTML/JS 渲染   │ ◀───────────── │  (Node.js)       │ ◀─────────── │  FastAPI     │
└─────────────────┘   推送消息     └──────────────────┘   响应/流     └──────────────┘
```

- **Webview → 主进程**：`vscode.postMessage({ command, ...data })`
- **主进程 → Webview**：`panel.webview.postMessage({ ... })`
- **原则**：网络请求（HTTP/SSE）只在主进程执行，Webview 只负责渲染与用户交互。这样可规避跨域、复用 Node 原生模块。

---

## 六、调试

### 6.1 启动调试

1. 打开 `src/extension.ts`，在目标行号左侧点击设置断点。
2. 按 `F5`，VSCode 编译并启动 **Extension Development Host**（一个加载了你的扩展的独立 VSCode 窗口）。
3. 在新窗口触发命令/操作，断点会在原窗口命中。

### 6.2 launch.json（脚手架自动生成）

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: watch"   // 启动前先 watch 编译
    }
  ]
}
```

### 6.3 调试技巧

- 修改代码后，在 Extension Development Host 窗口执行 **Developer: Reload Window** 重新加载，无需重启调试。
- `console.log` 输出在原窗口的 **Debug Console**（调试控制台）。
- Webview 内的 `console.log` 在新窗口执行 **Developer: Open Webview Developer Tools** 查看。

---

## 七、打包与分发

### 7.1 打包成 .vsix

```bash
# 确保已安装 vsce
npm install -g @vscode/vsce

# 在扩展项目根目录执行
vsce package
```

生成 `ai-agent-chat-0.0.1.vsix` 文件。

> **注意**：`vsce package` 要求 `package.json` 有 `repository` 字段或加 `--no-dependencies`，且 `README.md` 不能为空（脚手架生成的默认 README 可用）。

### 7.2 安装 .vsix

```bash
# 命令行安装
code --install-extension ai-agent-chat-0.0.1.vsix

# 或在 VSCode 内：扩展面板 → 右上角 ··· → 从 VSIX 安装
```

### 7.3 私有内部分发流程（本项目选定方案）

无需发布到公共市场，团队内通过 `.vsix` 文件分发：

1. 开发者在本地 `vsce package` 生成 `.vsix`。
2. 将 `.vsix` 放到团队共享盘 / 内网 Git 仓库 release。
3. 团队成员 `code --install-extension xxx.vsix` 安装。
4. 更新版本：修改 `package.json` 的 `version` 字段后重新 `vsce package`。

### 7.4 预发布检查清单

- [ ] `engines.vscode` 版本与目标用户 VSCode 版本兼容
- [ ] `package.json` 的 `version` 已更新
- [ ] `README.md` 含使用说明
- [ ] 扩展图标（`icon` 字段，128x128 PNG）已配置
- [ ] `vsce package` 无报错，`.vsix` 可正常安装运行

---

## 八、参考资料

- [VSCode 扩展 API 官方文档](https://code.visualstudio.com/api)
- [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension)
- [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)
- [Webview 指南](https://code.visualstudio.com/api/extension-guides/webview)
- [Contribution Points 参考](https://code.visualstudio.com/api/references/contribution-points)
- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

---

**下一步**：阅读 [02-服务集成方案.md](./02-服务集成方案.md) 了解如何与现有 AI 服务打通。
