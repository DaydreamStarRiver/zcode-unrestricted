# 项目目录与文件用途

本项目目录是 `D:\Work\Zcode\zcode-unrestricted`。当前交付包括插件定义、
给原版 Desktop Agent 接线的桥接模块，以及可恢复的安装器。
用户继续运行已安装的 ZCode；这里不需要再启动一个 CLI 或代理。

配置步骤见 [使用手册](usage.md)。下面区分开发文件、安装后的文件和用户正在处理的项目。

## 1. 开发目录

```text
zcode-unrestricted/
├─ README.md                  使用入口和文档索引
├─ install.cmd                安装插件和宿主桥接补丁
├─ uninstall.cmd              撤销安装并恢复符合校验条件的原 Agent
├─ status.cmd                 只读检查挂载与最近一轮状态
├─ edit-prompt.cmd            打开安装后的默认提示词
├─ plugins/
│  └─ zcode-unrestricted/
│     ├─ .zcode-plugin/plugin.json
│     ├─ README.md
│     ├─ native/bridge.cjs
│     └─ prompts/
│        ├─ system.md          私人初始正文，可能不随 Git 分发
│        └─ example-system.md  缺少私人正文时的示例
├─ docs/
│  ├─ usage.md                实际配置与排查手册
│  ├─ project-layout.md       本文
│  ├─ design.md               实现与状态设计
│  ├─ validation.md           已完成验证及未验证范围
│  └─ test.md                 可选的 ZCode 提示词草稿
├─ tools/                     安装、校验和打包实现
│  └─ runtime/                安装脚本使用的 Node 运行时
├─ tests/                     离线测试与 fixture
├─ dist/                      生成的交付目录和 ZIP
├─ artifacts/                 本地候选文件、解压验证等产物
└─ prompts/                  本地保留的历史正文，Git 和公共打包忽略
```

这是职责图，生成目录或私人文件可能不会出现在 Git 中。只有 `zcode-unrestricted` 一个有效插件。
`docs` 中其他用户自行保存的草稿和测试材料也不会被桥接自动加载。

### 根目录文件

| 文件 | 做什么 | 日常使用 |
| --- | --- | --- |
| `README.md` | 使用入口、限制和文档链接 | 首次阅读。 |
| `install.cmd` | 调用安装器，检查版本与进程，备份原 Agent，复制插件、桥接并注册 | 首次安装或已确认适配后的维护；先关闭 ZCode。 |
| `uninstall.cmd` | 校验后恢复原 Agent，撤销本插件注册，保留正文与备份 | 要撤销宿主补丁时使用；先关闭 ZCode。 |
| `status.cmd` | 校验磁盘文件，显示用户级开关与最近一轮解析记录 | 排查时使用。 |
| `edit-prompt.cmd` | 用记事本打开用户数据目录里的默认 `system.md` | 仅当需要编辑默认文件时使用。 |
| `package.json` | 开发脚本与项目元信息 | 维护项目时使用。 |
| `AGENTS.md` | 开发约定 | 修改实现前阅读。 |
| `LICENSE` | 本项目许可证 | 发布和分发时查看。 |

### 插件源目录

| 文件 | 作用 |
| --- | --- |
| `.zcode-plugin/plugin.json` | 原版插件清单，声明名称、版本和 `promptFile` 文件配置字段；它本身不是提示词。 |
| `README.md` | 安装后插件包内的简要说明。 |
| `native/bridge.cjs` | 每轮读取最终插件配置和选中的正文，建立快照，并供已接线的 ContextBuilder 使用。 |
| `prompts/system.md` | 首次安装默认正文的种子文件；是私人数据，不是每轮读取的固定源文件。 |
| `prompts/example-system.md` | 首次安装时缺少私人种子文件所用的示例。 |

只把此插件源目录导入原版插件管理，不能替代宿主补丁安装。
原版普通插件 Hook 没有因此自动获得替换 system 的接口。

### 文档目录

`usage.md` 说明高级配置如何填写；`project-layout.md` 解释文件职责；
`design.md` 面向维护者，解释接线和失败恢复；`validation.md` 区分测试证据与待实测范围。

`docs/test.md` 是用户要求改写的一份可选提示词。它没有特殊文件名约定，
修改它不会自动同步到插件数据目录。需要在 `promptFile` 中指定它的路径才能选中。

### 工具与测试目录

| 文件或目录 | 作用 |
| --- | --- |
| `tools/desktop.mjs` | CMD 调用的入口，分派 install、uninstall、status、edit 动作。 |
| `tools/install-lib.mjs` | 路径计算、进程检查、插件复制、安装记录、状态和回滚逻辑。 |
| `tools/patch.mjs` | 当前版本允许的原始哈希、接线锚点、候选补丁及语法校验。 |
| `tools/files.mjs` | 原子写入、JSON 和并发变更检查辅助。 |
| `tools/check.mjs` | 开发文件、JSON 和 CMD 等静态检查。 |
| `tools/package.mjs` | 生成交付目录和 ZIP。 |
| `tools/runtime/node.exe` | 运行这些脚本的独立 Node，不是新 ZCode Agent，也不接收聊天请求。 |
| `tests/native-*.test.mjs` | 原生配置、ContextBuilder 和运行时接线的离线验证。 |
| `tests/install.test.mjs` | 临时安装副本的安装、重复执行、失败恢复和卸载验证。 |
| `tests/process-check.test.mjs` | 安装前的进程检查验证。 |
| `tests/*fixture.mjs` | 测试环境与原 bundle 的受控加载辅助。 |

普通用户无需运行这些测试或阅读桥接源码才能配置提示词。

### 生成目录与旧目录

- `dist` 是生成的交付快照。修改开发文件不会自动改写已有 ZIP；已有包里的文档也不会自动更新。
- `artifacts` 是本地验证产物。里面即便有候选 `zcode.cjs`，也不表示它是当前应用正在运行的 Agent。
- 本地若仍有 `zocde-old`，它是旧 CLI 与上游源码副本，已由 Git 忽略，当前实现不依赖它。它可在保留 prompt 后删除，不属于必要交付。
- 私人 prompt 草稿仍保留原来的文件路径，避免使已配置的路径失效；旧示例另保留在 `prompts/legacy-example-system.md`。这些私人或历史正文不随公共仓库及 ZIP 发布。

## 2. 安装后真正使用的目录

以下是当前用户 `xiaoh`、默认 ZCode 安装路径的示例。其他账户或安装位置应按实际路径替换。

| 位置 | 用途 | 是否需要手动编辑 |
| --- | --- | --- |
| `C:\Users\xiaoh\.zcode\cli\plugins\local\zcode-unrestricted` | 安装器复制的插件包，供原版插件管理发现 | 日常不需要；修改开发源文件不会自动同步到这里。 |
| `C:\Users\xiaoh\.zcode\cli\plugins\data\zcode-unrestricted@inline\system.md` | 默认提示词正文 | 使用默认文件时编辑。 |
| 同一 data 目录的 `last-turn.json` | 最近一轮解析的工作区、时间、状态与正文摘要 | 只读排查，不用手动维护。 |
| `C:\Users\xiaoh\.zcode\cli\config.json` | 原版用户级配置，包含插件注册、开关与文件选项 | 优先通过原版 UI 修改，保留其他配置。 |
| `C:\Users\xiaoh\.zcode\cli\desktop-patches\zcode-unrestricted\<安装路径摘要>` | 原始 Agent 备份和 `receipt.json` 安装记录 | 不删除、不改写；安装器据此校验和恢复。 |
| `C:\Users\xiaoh\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs` | 原版桌面应用运行的 Agent；安装时加入少量接线 | 交给安装器维护，不从旧目录复制文件覆盖。 |
| 同一 glm 目录的 `zcode-unrestricted-native\bridge.cjs` | 被 Agent 接线实际加载的桥接模块副本 | 日常不编辑。 |
| 同一 glm 目录的 `zcode-unrestricted-native\binding.json` | 绑定插件包、默认正文和状态文件的绝对路径 | 安装器生成，不是提示词正文。 |

插件包中的 `native/bridge.cjs` 是复制的包内文件；Agent 接线实际加载的是
`resources/glm/zcode-unrestricted-native/bridge.cjs`。不要仅编辑其中一份就认为运行逻辑已经更新。

安装后的桥接不依赖开发目录；但如果 `promptFile` 指向开发目录的 `docs/test.md`，
该文件就成为读取依赖。移动或删除开发目录前，需要改用保留下来的提示词文件。

0.3.0 安装器支持已校验的旧名 0.2.0 安装。升级后使用新目录，旧默认正文和备份仍保留，
用户级配置转为新 ID；旧 Workspace 专属键需要在原版 UI 对新名称重新配置。
开发文件改名不会自行改变本机已安装插件，实际迁移由用户关闭 ZCode 后运行安装器完成。

## 3. 从“选择文件”到“本轮读取”的关系

```text
原版插件 UI
  ├─ 保存 User / Workspace 的启用状态
  └─ 保存 promptFile 文件路径
              │
              ▼
下一轮普通本地主会话：桥接读取合并后的配置
  ├─ promptFile 非空 → 读取选定文件
  └─ promptFile 为空 → 读取安装后的 data/system.md
              │
              ▼
读取成功 → 固定本轮正文快照 → ContextBuilder 的 system 替换入口
关闭或读取失败 → 使用原生基线
```

正文是文件内容；`promptFile` 只是地址；启用状态由原版插件开关保存。
进行中的一轮固定快照，文件或开关变化在下一轮读取。

这套机制处理客户端构造的 system 内容，不改变工具 schema、模型 Base URL、API key
和宿主权限，也不承诺改变模型或服务端自身的行为约束。
