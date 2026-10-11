# zcode-unrestricted

这份交付安装到已有的 Windows 桌面 ZCode。首次安装给它的 Agent 加一个小型、
可恢复的 Hook；日常仍从原来的 ZCode 快捷方式进入。

当前适配 **Desktop 3.14.4.7912**，同时校验 Agent 原始 SHA-256。其他版本拒绝
修改，需要另行适配。开发范围和验收见 [docs/design.md](docs/design.md)。

当前版本 **0.3.0**。从旧名 `dsh-unrestricted` 升级：先完全退出 ZCode，再运行
`install.cmd`。安装器识别已校验的旧补丁，迁移用户级开关和文件选项，保留默认正文及
原始备份；已有的新默认正文不会被覆盖。工作区专属设置需在原版 UI 对新名称重新设置。
`status.cmd` 显示 `legacy_mounted` 时，说明本机仍运行旧名版本，不表示覆盖失效。

第一次使用先看 [配置与使用说明](docs/usage.md)，了解各目录和文件看
[项目目录说明](docs/project-layout.md)。`docs/design.md` 讲实现原理，
`docs/validation.md` 记录测试范围，二者不代替操作手册。

## 你现在应该怎样配置

已安装补丁后，在原版 ZCode 的插件管理中找到 **zcode-unrestricted**，打开详情，
展开 **高级信息**，找到 **配置 → 系统提示词文件**。这是 `promptFile` 字段，
填写提示词文件的路径。例如使用本项目改写的提示词：

```text
D:\Work\Zcode\zcode-unrestricted\docs\test.md
```

输入框内只填这一行路径，不加引号、不粘贴提示词正文，也不粘贴 JSON。
点击 **保存配置**，开启插件，再发送下一轮消息。一般选择 **用户 / User** 范围；
如果只针对某个项目使用，选择那个 **工作区 / Workspace**，注意工作区配置会覆盖用户配置。

随后运行 `status.cmd`：`state=mounted` 表示补丁文件校验通过；
`lastTurn.state=active` 表示最近一轮成功解析了提示词。若为 `error`，查看
`lastTurn.code`，不要根据模型对自己提示词的描述判断是否加载。

`docs/test.md` 是可选提示词文件，修改它不会自动修改安装后的默认 `system.md`。
只有 `promptFile` 指向它时，下一轮才读取它。具体说明见 [使用手册](docs/usage.md)。
这份本地草稿由 Git 忽略；公共源码和 ZIP 不附带它。新用户可留空使用默认正文，
或选择包内已有的 `plugins/zcode-unrestricted/prompts/example-system.md`，再换成自己的文件。

## 使用

1. 完全退出 ZCode，包括托盘/后台进程。
2. 双击本目录的 `install.cmd`；脚本检查、备份和安装，默认关闭插件。
3. 按原来的方式打开 ZCode，在插件设置里找到 **zcode-unrestricted** 并开启。
4. 正常发送消息：这一轮开始应用你的系统提示词。

若此前还启用了追加上下文版 `zcode-unrestricted-zcode`，先在插件设置中关闭旧版，
避免同一份正文同时进入 system 和用户附加上下文。

不需要设置代理、修改模型 Base URL/API key，也不需要独立运行一个 Agent。
安装脚本只打印普通文字，没有之前 CLI 的终端界面和 ANSI 绘制。

从源码使用 CMD 脚本需要已有 Node.js 24，或本地的 `tools/runtime/node.exe`。
脚本优先使用随包运行时，否则使用 PATH 中的 Node。运行时二进制保留在本地并由 Git 忽略。

安装时会保留已有正文；首次正文来自本包 `plugins/zcode-unrestricted/prompts/system.md`，
若包内没有用户正文，则使用明确的示例。当前开发目录已保留旧项目的用户正文。

## 开关、编辑与状态

- **开启/关闭**：使用原版插件设置。下一轮生效；正在执行的一轮保持其原快照。
- **编辑默认正文**：双击 `edit-prompt.cmd` 用记事本打开。保存为 UTF-8，最多 256 KiB。
  此脚本始终打开安装后的默认文件；若已选择其他文件，需要直接编辑那个文件。
- **选择别的文件**：在插件详情的“高级信息 → 配置”中填写 `promptFile` 文件路径，
  再点击“保存配置”。建议使用绝对路径。字段留空时使用安装后的默认文件。
- **查看挂载**：双击 `status.cmd`。`mounted` 表示安装文件校验一致；`lastTurn`
  只表示最近解析的一轮，修改开关后需发送下一轮再查看。`userEnabled` 只显示用户级
  开关；当前项目最终状态以原版 Workspace 设置与该轮 `lastTurn` 为准。
  输出中的 `promptFile`、`promptBytes`、`promptHash` 描述默认文件，并不表示高级配置
  当前选中的文件；`lastTurn.revision` 才是最近一轮解析正文的摘要。
- **撤销安装**：完全退出 ZCode，双击 `uninstall.cmd`。恢复 Agent 并清理本插件注册，
  保留提示词 data、原文件备份和安装记录供检查。

默认正文安装到：

```text
%USERPROFILE%\.zcode\cli\plugins\data\zcode-unrestricted@inline\system.md
```

插件包安装到用户持久目录并通过原版 `plugins.dirs` 注册，不依赖开发目录。
安装器只增加本插件路径和启用键；Provider、其它插件与用户配置保持原样。

## 更新与限制

ZCode 更新可能覆盖补丁。此时状态会变为 `unmounted`，原版继续使用原生 system。
不要把旧备份复制到新版本；卸载器识别未带 Hook 的升级版，只撤销注册，不回写旧 Agent。
已带 Hook 但发生未知修改的文件会拒绝自动覆盖。
原始备份和安装记录保存在用户目录的 `.zcode/cli/desktop-patches/zcode-unrestricted/`，
按安装路径隔离，避免跟随 ZCode 资源目录被更新器删除。

首次安装后需重启；提示词文件与开关下一轮热加载。第一版覆盖 Windows 本地
普通主会话（包括 Plan/Build），不覆盖远程 Agent、子代理、工作流或专用标题/摘要请求。
工具 schema、聊天正文和原生权限机制沿用宿主行为。

这里只修改客户端送出的 system 文本，模型端对回答的处理取决于原供应商。

## 开发与验证

```powershell
.\tools\runtime\node.exe --test tests/*.test.mjs
.\tools\runtime\node.exe tools/check.mjs
.\tools\runtime\node.exe tools/package.mjs
```

测试读取本机适配版本的原始 bundle，所有变更在临时副本里完成。真实桌面会话的
手动验证与离线验证结果分别记录在 [docs/validation.md](docs/validation.md)。

私人 `system.md` 和用户保存的提示词草稿保留在本地，由 `.gitignore` 排除。
公共 ZIP 只包含示例正文，不包含私人 prompt 或整个 `docs` 目录里的草稿。
`zocde-old`、`artifacts` 和 `dist` 为可清理的本地旧副本或产物，当前源码和公共交付不依赖它们。
