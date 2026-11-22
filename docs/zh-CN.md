# Orchestrator 中文指南

[English README](../README.md)

Orchestrator 是本地运行的 TypeScript 多 agent 框架。终端、浏览器和 Windows 桌面客户端共用模型配置、对话历史和工具审批，界面默认使用英文。

## 启动

如果已有 Windows 压缩包，完整解压后双击 `Orchestrator.exe` 即可。程序需要同目录的 DLL 和 `resources` 文件夹。[桌面端与 Web 使用说明](CLIENTS.md)

从源码启动需要 Node.js 24.14+ 和 npm。在仓库根目录运行一次 `npm.cmd ci`，然后按需选择一个入口。

| 客户端 | PowerShell 命令 |
| --- | --- |
| 终端 | `npm.cmd run tui` |
| 浏览器 | `npm.cmd run web`，打开终端输出的网址 |
| Windows 桌面 | `npm.cmd run desktop`，构建并打开窗口 |

同一数据目录同时由一个运行时使用。要让运行时在关闭终端界面后继续工作，先运行 `npm.cmd run server`，再从另一个终端运行 `npm.cmd run tui -- --url http://127.0.0.1:4317`。

## 配置与协作

- **模型**：`npm.cmd run demo` 可体验演示流程。在 TUI 输入 `/models`，可添加自己的模型地址和 API key，或切换已有模型。[模型配置](MODELS.md)
- **对话与项目**：`/resume` 打开历史会话，`Ctrl+R` 按用户输入定位到某一轮。全局配置和历史保存在 `~/.orchestrator/`；项目配置写入 `.orchestrator/settings.json`。[存储与环境变量](../README.md#configuration-and-files)
- **多 agent**：输入 `/delegate reviewer 检查这次改动` 派一个子任务，或用 `/team researcher,reviewer 分析项目` 分工。输入 `/agents` 查看子 agent，进入子对话后按 Esc 返回父会话。[终端快捷键](TUI.md) · [多 agent 协作](COLLABORATION.md)
- **项目指令与技能**：将项目约定写入 `AGENTS.md`，将技能写入 `.agents/skills/<名称>/SKILL.md`。在对话中输入 `$名称` 可显式使用技能。[加载规则与示例](AGENT_GUIDANCE.md)
