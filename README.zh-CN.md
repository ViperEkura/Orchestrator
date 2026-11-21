# Orchestrator

[English](README.md) | 简体中文

TypeScript 多 Agent 框架，包含运行时、终端聊天界面、HTTP/SSE API 和客户端 SDK。界面、内置角色和默认回复使用英文；Web 页面和桌面安装包尚未实现。

## 启动

需要 Node.js 24.14+。只有可写子任务工作区需要 Git。

```powershell
cd C:\Develop\Orchestrator
npm.cmd ci
npm.cmd run build
npm.cmd start -- init
npm.cmd run tui
```

`npm.cmd run demo` 无需 API Key，使用确定性演示模型。指定项目：`npm.cmd run tui -- --cwd C:\Develop\MyProject`。

输入 `/` 或 `/ap` 自动显示补全；方向键选择、Tab 补全、Esc 关闭。Enter 先补全未完成命令，再次 Enter 执行。支持 `/new`、`/use`、`/approve`、`/deny`、`/cancel`、`/retry`、`/help`、`/quit`。输入框只显示一个提示符。

需要关闭界面后继续运行任务时，单独启动 `npm.cmd run server`，客户端用 `npm.cmd run tui -- --url http://127.0.0.1:4317` 连接。

## 存储

```text
~/.orchestrator/
  settings.json                              全局配置
  agents/<agent-id>.json                      角色定义
  sessions/<project-hash>/<session-id>.jsonl   会话日志
  sessions/_system/runtime.jsonl             运行时事件
  artifacts/<session-id>/<artifact-id>.json    结果文件
  worktrees/<session-id>/                     可写子任务工作区
  runtime.lock                               单进程锁

<项目>/.orchestrator/settings.json             项目配置覆盖
<项目>/AGENTS.md                              项目指令
```

`~` 表示用户主目录；`ORCHESTRATOR_DATA_DIR` 可修改存储根目录。配置优先级：默认值 → 全局 JSON → 项目 JSON → 环境变量。启动自动创建缺失的默认配置和角色，修改后重启生效。

项目配置示例：

```json
{
  "provider": "compatible",
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "concurrency": 3
}
```

API Key 放在 `$env:LLM_API_KEY`；API 访问令牌放在 `$env:ORCHESTRATOR_TOKEN`，不写入配置 JSON。默认 provider 是 demo。真实模型适配器支持流式 Chat Completions。`.env` 不自动读取，需要用 `node --env-file=.env --import tsx src/main.ts tui`。

## 会话与工作空间

- 会话绑定项目 cwd，多轮聊天和重启后保持一致。
- 子 Agent 默认共享父目录，但只获得只读工具；有独立会话。
- 委派时指定 `workspace: "worktree"`，为可写子任务创建 Git worktree。它基于已提交 HEAD，不包含未提交内容；不自动合并或删除。
- 只读 Agent 不能创建可写后代。写文件和执行命令仍逐次审批。工作区内 AGENTS.md 会加入运行指令。
- 演示输入包含 `approval` 或 `审批` 时会创建可写 worktree，因此需要 Git 仓库已有提交。

JSONL 每行包含版本、事件、增量状态变更；完整消息落盘，流式 token 仅实时推送。启动按全局序号重放全部日志。未写完的尾行备份后修复，完整行损坏则报错。运行中任务重启后标为 interrupted，不自动重放工具调用。

备份请复制整个数据目录，目前不支持单独删除会话日志。结果正文放在 artifact JSON 中，状态只保存路径。

## 旧数据迁移

新数据目录不存在时，会自动导入项目原来的 `.orchestrator/state.sqlite`。也可显式迁移到一个不存在的目录：

```powershell
npm.cmd start -- migrate C:\Develop\Orchestrator\.orchestrator\state.sqlite --output C:\Develop\Orchestrator-history
```

保留原数据库、旧工作目录、会话 ID 和事件；验证重放后才发布新目录。旧会话继续使用最后一次任务的旧目录，新会话使用项目目录。正常启动不再加载 SQLite。

## 范围

目前适合本地单用户、小规模项目；一个数据目录只允许一个运行时。全部历史仍加载到内存，尚无自动压缩、多用户隔离或分布式调度。命令在宿主机执行，worktree 不提供操作系统沙箱。

验证命令：`npm.cmd run check`、`npm.cmd test`、`npm.cmd run build`。详见英文版 [架构与类图](docs/ARCHITECTURE.md)、[API](docs/API.md)、[扩展](docs/EXTENDING.md)、[验证记录](docs/VALIDATION.md)。

## 聊天界面和协作

界面参考 Pi / Codex：对话为主、一个输入框，会话选择、Agent 和审批使用临时面板。

- Ctrl+P 或 `/resume`：搜索并切换会话；Esc 返回并保留草稿。
- Ctrl+T：查看任务树，Enter 打开子 Agent 对话。
- Ctrl+O：查看审批，Y 同意、N 拒绝。
- ↑/↓ 或鼠标滚轮：上下滚动；PageUp/PageDown 翻页。
- Ctrl+R 或 `/history`：按每轮用户输入搜索定位，Enter 跳转，不改变当前任务或发送消息。
- Alt+↑/↓：上一轮／下一轮；Home 到开头、End 回到最新并恢复跟随输出。
- 浏览旧消息时新输出不会拉动阅读位置，草稿保留；Ctrl+N 开始新聊天。
- 普通输入：Assistant 直接流式回复，续聊保留上下文。
- `/delegate reviewer 检查 API`：创建一个子任务。
- `/team researcher,reviewer 分析项目`：创建多个角色任务并汇总。

协作计划由运行时执行，API 支持并行和依赖关系，不依赖演示输出。角色可以修改或新增，写操作仍需审批。当前多 Agent 是主 Agent 协调任务树，不包含任意 Agent 之间的私信或自动辩论。

本机配置已切换为 DeepSeek V4.1 Flash（`deepseek-flash`），thinking=enabled、effort=high，引用 OpenCode 原有凭据。配置中不复制密钥。修改配置后需重启运行时；`npm run demo` 仍固定使用演示模型。

详细说明：[界面快捷键](docs/TUI.md)、[子 Agent 与团队 API](docs/COLLABORATION.md)。

本轮界面修正：启动时显示新会话帮助，不自动展开旧 Demo；模型回复支持 Markdown 加粗、标题、列表、代码块和表格，窄窗口自动换行或按字段展示。最后一条审批处理完成会自动回到聊天并保留草稿；空审批面板可按 Enter/Esc 返回。

审批默认使用 **manual（手动）**，需要审批时自动弹出。使用 `/approval manual`、`/approval agent`、`/approval all` 切换运行中的模式；在 settings.json 中设置 `approvalMode` 可保存启动默认值。Agent 判定不确定或失败时转人工，所有模式均保留工具权限和路径检查。
