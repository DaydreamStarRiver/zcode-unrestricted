# zcode-unrestricted

用于 Windows 桌面版 ZCode 的系统提示词替换插件。通过可恢复的 Agent 桥接补丁接入原版 ZCode，在插件设置中管理开关和提示词文件，文件修改与开关变化在下一轮对话生效。

模型连接、工具和权限设置沿用原版 ZCode 的配置。

**插件版本：0.3.0 · 适配 ZCode Desktop：3.14.4.7912 · 许可证：MIT**

## 安装

从源码使用需要 **Node.js 24**，并确保命令行可以运行 `node`。如果交付包内包含 `tools/runtime/node.exe`，脚本会优先使用它。无需安装 npm 依赖。

1. 下载或克隆本仓库，进入项目目录。
2. 完全退出 ZCode，包括托盘和后台进程。
3. 双击 `install.cmd`。安装器检查 Agent 版本、备份原文件并安装桥接补丁；首次安装默认关闭插件。
4. 双击 `edit-prompt.cmd`，将默认示例改为自己的提示词，保存为 UTF-8。
5. 按平时的方式打开 ZCode，在插件管理中开启 **zcode-unrestricted**，发送下一轮消息。

安装器会校验原始 Agent 的 SHA-256，未适配版本或未知修改会被拒绝。仅通过插件管理导入插件目录，无法完成宿主桥接安装。

ZCode 安装在其他位置时，可在终端指定目录：

```powershell
.\install.cmd --app-dir "D:\Apps\ZCode"
```

其他脚本也支持 `--app-dir`，填写实际安装目录即可。

## 配置提示词

可以使用安装后的默认文件，也可以选择自己已有的文件。

- **默认文件**：运行 `edit-prompt.cmd` 编辑。在插件配置中将“系统提示词文件”留空并保存。
- **自定义文件**：打开插件详情中的 **高级信息 → 配置 → 系统提示词文件**，填写文件的实际绝对路径，例如 `D:\Prompts\system.md`，点击 **保存配置**。

输入框保存的是文件路径；提示词正文应写在该文件中。路径不加外层引号。文件必须非空、采用 UTF-8 编码，大小不超过 256 KiB。读取失败时，本轮恢复原生系统提示词。

**用户 / User** 配置作为默认值，**工作区 / Workspace** 的显式配置优先。修改提示词文件或插件开关后，下一轮生效；正在执行的一轮保持原快照。

默认提示词的位置：

```text
%USERPROFILE%\.zcode\cli\plugins\data\zcode-unrestricted@inline\system.md
```

公共仓库只提供 [示例提示词](plugins/zcode-unrestricted/prompts/example-system.md)。首次安装用它初始化默认文件；重新安装会保留已编辑的默认正文。

## 常用脚本

| 脚本 | 用途 |
| --- | --- |
| `install.cmd` | 安装或迁移补丁；运行前完全退出 ZCode。 |
| `edit-prompt.cmd` | 用记事本编辑安装后的默认提示词。 |
| `status.cmd` | 检查挂载状态和最近一轮解析记录。 |
| `uninstall.cmd` | 撤销补丁并清理插件注册，保留提示词、备份和安装记录；运行前完全退出 ZCode。 |

`status.cmd` 中的 `state: mounted` 表示安装文件校验通过；`lastTurn.state: active` 表示最近一轮成功读取提示词。核对记录中的工作区和时间，详细字段及排查方法见 [使用手册](docs/usage.md)。

`edit-prompt.cmd` 始终编辑默认文件。选择了自定义文件时，应直接编辑那个文件。

## 兼容范围

当前支持 Windows 本地普通主会话，包括 Plan / Build。子代理、工作流、远程 Agent 和标题、摘要等专用请求尚未覆盖。

ZCode 更新可能覆盖桥接补丁，届时需要重新确认版本适配。请使用安装器和卸载器维护补丁，避免用旧 Agent 备份覆盖新版应用。

插件调整客户端构造的系统提示词；模型服务端的处理规则仍由供应商决定。

## 从旧版升级

已安装旧名 `dsh-unrestricted` 的用户，完全退出 ZCode 后运行新版 `install.cmd`。安装器迁移用户级开关和文件选项，保留旧提示词与备份；已有的新默认正文不会被覆盖。工作区专属设置需在原版 UI 对新名称重新配置。

旧版状态与配置迁移说明见 [使用手册](docs/usage.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [配置与使用说明](docs/usage.md) | 文件选择、配置优先级、状态字段和常见问题。 |
| [项目目录说明](docs/project-layout.md) | 源文件与安装后文件的用途。 |
| [设计说明](docs/design.md) | 桥接实现、快照和恢复机制。 |
| [验证记录](docs/validation.md) | 已完成测试及验证范围。 |

## 开发

在项目目录运行：

```powershell
node --test tests/*.test.mjs
node tools/check.mjs
node tools/package.mjs
```

离线测试读取本机适配版本的 Agent；已安装补丁时，会校验并读取安装器保存的原始备份。安装与恢复测试在临时副本中执行，不启动真实模型会话。打包输出位于 `dist/`，公共包只包含示例提示词。

## 许可证

[MIT](LICENSE)
