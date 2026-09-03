# 本地数据与隐私

批注工作台是本地优先应用。当前版本不包含账号、遥测、广告、云端同步或远程
AI API 调用。Codex 或 Claude Code 集成通过用户主动配置的本地 MCP 进程完成。

## 存储位置

- macOS：`~/Library/Application Support/review-annotation-prototype/data/`
- Windows：`%APPDATA%/review-annotation-prototype/data/`
- Linux：`$XDG_DATA_HOME/review-annotation-prototype/data/`，未设置时使用
  `~/.local/share/review-annotation-prototype/data/`

数据目录包含工作区索引、导入文档副本、页面渲染、审阅任务快照和备份暂存
文件。每个审阅任务会在 `review-tasks/<任务 ID>/` 保存一份文档副本、JSON
任务清单和 Markdown 清单。删除 App 不会自动删除该目录。

## 原始文件路径

使用桌面端“导入并跟踪”时，工作区会记录原始文件的绝对路径，以便刷新时自动
读取新版文件。完整工作区备份可能保留这些路径，因此分享备份前应视为敏感信息。

## MCP

任务模式下，MCP 只返回指定任务 ID 保存的文档快照和任务项；旧版线程工具只
允许访问 App 当前打开的文档。AI 工具本身可能拥有更广泛的文件系统权限，实际
修改范围仍由 AI 工具的权限配置和用户批准共同决定。

## 网络边界

本地 API 只绑定 `127.0.0.1`，并拒绝非 loopback Host 和不匹配的浏览器 Origin。
不要将端口 `4517` 或 `4520` 暴露到局域网或公网。
