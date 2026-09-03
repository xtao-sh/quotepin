# AI 隔离审阅任务工作流

批注工作台通过本地 MCP 服务，把文档批注作为独立任务开放给 Codex、Claude Code 等支持 MCP 的 IDE 工具。每个任务都有唯一 ID、固定文档快照、书面清单、逐项状态和对话记录。

## 使用流程

1. 在 App 中完成一篇文档或一个项目的批注。
2. 在文档右侧生成“文档任务”，或在项目首页生成“项目任务”。
3. 复制形如 `REV-20260714-A1B2C3` 的任务 ID。
4. 在 Codex 或 Claude Code 中输入：

   > 处理批注工作台任务 `REV-20260714-A1B2C3`。只使用这个任务的快照和清单，逐项标记处理中；完成后回复修改内容、文件和章节，并设为待我确认。需要我决定的问题设为待我回复。

5. IDE 通过 MCP 按任务 ID 读取快照并逐项回写。此时可以在 App 中切换到其他文档并继续创建新任务。
6. 用户确认解决或继续反馈；任务目录中的 `REVIEW_CHECKLIST.md` 和 `task.json` 会同步更新。

任务目录还包含创建任务时的文档副本。刷新或删除 App 中的原文不会改变旧任务保存的审阅基准。

## 任务工具

- `list_review_tasks`：列出任务摘要和任务 ID，不读取文档内容。
- `get_review_task`：读取一个任务的固定范围、文档副本、工作路径和全部任务项。
- `get_review_task_checklist`：读取该任务的 Markdown 清单及本地路径。
- `list_task_review_items`：列出一个任务中的待处理项。
- `get_task_review_item`：读取单项批注、页面文字和任务对话。
- `update_task_review_item_status`：更新单项处理状态。
- `reply_to_task_review_item`：回写 AI 回复和修改依据。

任务专属 MCP 连接只注册以上 7 个任务工具，不会暴露当前文档工具。普通 MCP
连接只注册 `list_review_threads`、`get_review_thread`、
`reply_to_review_thread` 等当前文档工具，不会暴露任务工具。普通连接始终
跟随 App 当前打开的文档，不适合同时处理多个文档。

## 连接方式

桌面安装版请优先从 App 的“导出 → AI 指令”复制连接信息。App 会按当前安装位置生成可执行的 MCP 路径，并把当前 API 地址、工作区 ID、任务 ID 和任务专属令牌写入 Codex、Claude Code 及通用 JSON 配置；这样不会误连到另一份工作区或另一个任务。每个隔离任务使用自己的连接配置。

仓库内包含 Codex 的 `.codex/config.toml` 和 Claude Code 的 `.mcp.json`。从本仓库启动 IDE 时会加载 `review-annotation` MCP 服务。

需要在其他项目中使用时，可以注册为用户级服务：

```bash
codex mcp add review-annotation -- node "$(pwd)/mcp/review-annotation-server.mjs"
claude mcp add --transport stdio --scope user review-annotation -- node "$(pwd)/mcp/review-annotation-server.mjs"
```

MCP 服务会自动寻找运行在本机标准端口上的兼容版批注工作台，也可以通过
`REVIEW_API_URL` 指定地址。升级 App 后应退出旧进程并重新启动，协议版本不
兼容时客户端会拒绝复用旧后端。

## 范围规则

任务工具必须显式传入任务 ID。服务同时校验任务专属令牌，只返回该任务在
创建时记录的文档和任务项，不查询 App 当前文档；任务回复也只能写入该任务
清单中的任务项。

文档任务只包含一篇文档，项目任务包含创建时该项目下的文档。项目首页的“设置目录”用于记录 IDE 可定位的工作目录；每篇文档同时保存自己的工作文件路径和快照路径。

MCP 可以严格限制它自身提供的数据和回写接口，但不能拦截 IDE 中其他具有文件系统权限的工具。任务清单会声明允许的项目目录和文档路径，IDE 仍应遵守该范围。

默认导出和“待处理”列表不会再次发送已解决或已拒绝的意见。需要审计历史时，
可以在导出窗口选择“包含已解决”和“完整对话”。

## 当前边界

MCP 不会主动唤醒没有运行任务的 IDE 会话。每个新任务或新一轮处理仍需在 IDE 中提交一次任务 ID。完全自动触发需要额外的常驻 Agent 服务。
