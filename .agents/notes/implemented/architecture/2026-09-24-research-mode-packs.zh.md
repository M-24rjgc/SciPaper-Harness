# Agent Note: Research modes as installable packs over a general mode

Status: implemented

[English](2026-09-24-research-mode-packs.md) | 中文

## 问题

科研工作台原先把三种模式写死在代码里——`paper-first`、`from-results` 和 `free`——分布在类型、记录 schema、`checks.ts` 的阶段表与检查表，以及桌面端 UI 中。两个论文模式是对 spark-to-paper-skills 流水线的重新实现；而且无论项目处于哪种模式，每个会话都会列出全部科研技能。

产品需要一个通用模式，它就是科研 agent 本身：全部工具，没有流水线。spark-to-paper、CCFA-Skills 这类方法叠加在它之上，带着各自的技能、脚本和门禁，与内置工具融合，未启用时完全不可见。以后还会有更多方法（比如学习模式），所以新增一个模式不能再意味着把类型、schema、检查、UI 和文案都改一遍。多个方法都要用的能力——会议模板、生图、科研模式知识图谱、SVG 审计与导出、行文检查——属于平台，而不属于某一个方法。

## 决定

一个模式就是 `packages/research/workbench/runtime/modes/<id>/` 下的一个目录：一份 `mode.yml` 清单（标识以及中英文名称、上游来源与许可证、入口技能与预加载技能、路线、阶段、门禁、脚本），`skills/<name>/SKILL.md`，门禁和脚本运行的 Python；改编自上游的方法还带上它的 `LICENSE` 和 `NOTICE.md`。`ModeRegistry`（`src/modes.ts`）在启动时加载并校验这些包，损坏的包给出警告后跳过；没有阶段、没有技能的 `general` 包必须加载成功。随包发布三个模式包：`general`、`spark-to-paper` 和 `ccfa`。

- **记录。** `mode` 与 `route` 是字符串，由注册表在 `set-mode` 和 `create` 时校验。旧记录在读取时迁移：`free` 或未设置的模式转为 `general`，`paper-first` 与 `from-results` 转为 spark-to-paper 的 `proposal` 与 `data` 路线。记录所指的模式包若已不再安装，记录照样能打开，项目按通用模式运行，简报里会说明这一点。
- **阶段。** 一个阶段写明它所属的路线、使用的技能、是否为检查点、决定它的检查，以及它要求的事实，这些事实来自一组固定的种类（文件通配、`manuscript`、`bibEntries`、`sections`、`figures`、`diagram`、`pagesInspected`、`reviewCurrent`、`runsCollected`、`noActiveRuns`、`dataEvidence`、`resultsOrData`）。要求成立、且决定它的检查没有错误时，阶段即为完成。检查只报告；任何操作都不会因为检查不通过而被拒绝。
- **门禁与脚本。** 门禁是模式包里的脚本，用平台 Python 运行（`python -I -X utf8`，按参数向量传参，不经过 shell，以项目根目录为工作目录），最后一行输出 `{"findings": [...]}`；除此之外的输出记为一条错误发现，检查从不安装 Python。`research_artifact` 的 run-script 只运行模式包为项目当前路线声明的脚本。
- **技能跟随模式。** 与科研工具一起挂载的技能提供者，按会话工作目录所在项目的模式列出技能：通用模式不列出任何模式包技能，切换模式会在进行中的会话里替换技能目录；`research/mode` 事件让它失效重算。工具 schema 保持静态；模式、路线、阶段、入口技能和脚本通过 `research_project` 的 current 与 modes 告诉模型。
- **忠于上游。** 每份上游 `SKILL.md` 原样保存为 `references/upstream.md`，上游的参考资料放在旁边；改编后的 `SKILL.md` 说明每个上游宿主步骤由哪个科研工具完成、每份交付物放在哪里、以 `research_check` 的口径什么叫完成。上游的检查器与校验器经由各包的 `gates/run_gate.py` 原样运行；少量补丁标注 `[research-workbench]`，并与替换了什么、没有收录什么一起列在该包的 `NOTICE.md` 里。
- **上游控制与自主度。** spark-to-paper 在实验前的停顿是一个检查点阶段。CCFA 的交接模式就是项目的自主度：`checkpoints` 对应 PARTIAL，`automatic` 对应 OFF。
- **共享能力原生实现，在每种模式下都可用。** 会议模板库（139 个 CCF 会议、16 套官方样式，由 `scripts/build_venues.py` 从 CCFA-Skills 构建，编译时把文档类缺的依赖装进托管的 TeX Live）；`research_media` 的 generate-image（默认 gpt-image-2）与 fetch-reference-figures；基于内置图谱的 `research_knowledge`，该图谱由 `scripts/build_kg.py` 从 spark-to-paper 的 AI 语料精简而来；`research_media` 的 audit-svg（上游审计，原样运行）与 export-figure；基础检查 `prose`。
- **平台 Python。** `src/components.ts` 里的 `PLATFORM_PYTHON_PACKAGES` 这一份包清单同时用于运行时安装和桌面端构建；就绪标记记录这份清单，所以按旧清单装好的环境会被更新到当前清单。

## 考虑过的替代方案

**在代码里把 CCFA 加成第三种模式。** 此后每加一种模式都要在类型、schema、检查、UI 和文案里重复这番修改，而且一个模式的技能无法对其他模式隐藏。每个模式一个目录，新模式就不必改代码，除非某个阶段需要一种新的事实。

**把上游脚本移植成 TypeScript。** 移植会与上游逐渐偏离，也会丢掉上游的自检；而平台本来就为文档处理托管了一个 Python。上游脚本按原样运行；只有在原生工具本身就是目的的地方才写 TypeScript：知识图谱召回、套用会议模板和行文检查。

**按模式切换工具 schema。** 工具列表随模式变化，每次切换都会改写已缓存的请求前缀和工具目录。静态 schema 加上项目简报里的模式信息，两者都能保持稳定。

**列出全部模式包技能，再告诉模型该用哪些。** 模型仍会加载别的方法的技能，而用户要求未启用的模式完全不可见。

**原样发布上游知识图谱。** 压缩包有 763 MB，其中的向量绑定某一个嵌入模型，图本身是加载时会执行代码的 pickle。内置图谱保留模式和论文、不带向量，读取时用的反序列化器只解析五个已知类；用户配置嵌入接口后，语义排序才会加入。

**给 CCFA 一条固定流水线。** 上游按任务定义门禁，没有固定的阶段顺序。模式包把上游总控建议的路线做成阶段，另加一条不设阶段的 `open` 路线。

**按会议逐一复制 CCFA 的 LaTeX 模板。** 139 个文件夹里大部分是重复的文档类文件，还有几个套错了样式；现在去重成 16 套样式并修正了套错的映射，每套样式的审稿版和终稿版都通过工作台自己的编译流程编出了 PDF。

## 影响

新增一个模式就是一个目录，外加一个类似 `tests/ccfa-pack.spec.ts` 的测试；预设的 `research-modes` 技能里再为它写一行。只有当某个阶段需要要求集合里还没有的事实时，才需要改代码。

模式包脚本以固定到上游 commit 的产品内容身份在用户文件上运行，从不运行模型写的代码：按参数向量传参、隔离模式、不经过 shell，并由 `runProcess` 从环境变量里剥离密钥。

平台 Python 变大了（svglib、reportlab、PyYAML），已有的安装会在清单变化时重装一次依赖。

上游文本里仍有宿主特定的指令（Codex 路径、宿主的生图工具），模型会把它们与改编页放在一起读；因此每份改编后的 `SKILL.md` 都写明了由什么替换了什么。

ACL 系会议需要 `acl_natbib.bst`，上游和 TeX Live 都没有提供；这些会议的 PDF 能编出来，但引用未解析，会议备注里写明了这一点。

[对话优先界面那篇 Agent Note](../feature/2026-09-21-research-workbench-conversation-first-surface.zh.md) 描述的阶段脊线已经不存在：项目的进度就是上次检查报告的该模式各阶段状态。
