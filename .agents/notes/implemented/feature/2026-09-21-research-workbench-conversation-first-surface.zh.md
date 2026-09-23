# Agent Note: 科研工作台改为以对话为主的界面

Status: implemented

[English](2026-09-21-research-workbench-conversation-first-surface.md) | 中文

## 问题

科研工作台此前是与对话并列的第二个应用：一个由六个标签页组成的 `main` 面板，在侧栏里与对话平起平坐，里面装着证据导入、产物编辑、环境绑定和实验提交的表单。两个界面都不说明彼此是什么关系，而且提交实验要求研究者把内部 UUID 复制进输入框。

这种布局与它底层的系统相矛盾。`dsh-research-workbench` 的每个阶段都会生成一段提示词投进一个普通会话，模型用科研工具干活，真正属于用户的决策只有三次：研究问题、方法、实验方案及其预算。填表式的界面恰恰遮住了研究者唯一需要看见的东西——研究停在哪里，又在等什么。

设计需要的两个事实在记录里也不存在。`ResearchStage` 不带任何时间戳，因此「你在 18 日确认」无从说起。`ExperimentRecord` 不带开始时间，因为 `experiments.ts` 里的 `stateSchema` 是非严格 Zod 对象，把 Python 监督进程每半秒写进 `state.json` 的 `startedAt`/`finishedAt` 静默丢弃了。

## 决策

科研通过插槽把界面贡献进既有的对话，自己不再拥有任何应用。

- 空会话：烧瓶标志、三个教人怎么开口的入口、三条恒定承诺。沿用上一轮的成果。
- 进行中的会话：阶段位置进对话标题栏（`conversation.session.header.actions`），项目文件夹与暂停放在它旁边（`.utilities`），待决策的卡片位于输入框上方（`conversation.input.dock`），已提交的实验组位于其下（同一插槽，order 更大）。
- 记录只读地汇报在右侧栏：带逐阶段说明的阶段轴、各自带例外标记的计数（待更新的证据、待验证的论点、在跑的实验）、已批准的实验预算及其消耗，以及运行所固定的环境。
- 论点的原文从侧栏经 `shell.overlay` 与 `Modal` 基础组件覆盖整个界面打开。客户端没有对话框服务，`shell.overlay` 是唯一的全局浮层座位。
- 所有可配置项都在设置面板里，工作台界面上一个都不留。
- 项目文件仍然可达，保留为 `main` 面板，但 `sidebar.panellist` 那一行被删除，因此不再有任何地方把它呈现为对话的同级应用。标题栏的「项目文件夹」成为唯一入口。
- 输入框的工具行上有唯一一条不必先对模型说话就能开始研究的路。它只在当前对话还没有项目时出现，经 `remote.directoryPicker` 选目录，在那里创建项目并把输入框草稿作为 brief，然后启动资料阶段——正是这次启动把流水线绑定到本会话，否则对话始终无主，也就没有任何东西会汇报它。只删掉侧栏那一行而不加这个控件，会让全新安装根本无法创建第一个项目。

每个会话作用域的座位都以 `project.sessionId === sessionId` 选定项目，绝不按快照里的位置来取。`snapshot()` 返回域表中所有工作区的全部项目，而 `dispatchStage` 会把项目绑定到它流水线所在的那个会话，因此会话 id 是唯一能说明「这个对话讲的是哪一份研究」的依据。其中两个座位会写入——标题栏的暂停与决策卡片的确认——按位置取就可能暂停或确认一份与当前对话毫无关系的研究。没有任何项目被派发进来的对话什么都不显示，这是对的：它本就不是那个项目的对话。空会话的「接着上次做」卡片仍然刻意跨项目，因为走回另一个项目正是它的用途。

为了让界面陈述事实而不是估算，记录新增两组字段。`ResearchStage.confirmedAt` 由 `confirmStage` 写入，并在每一处删除 `confirmedRevision` 的地方一并删除。`ExperimentRecord.startedAt`/`finishedAt` 来自放宽 `stateSchema` 以保留监督进程的 epoch 秒，再由 `launchExperiment` 与 `observeExperiment` 共用的 `applyState` 统一转成 ISO。

## 考虑过的替代方案

**按设计稿把实验方案决策画成六格表（数据集、基线、指标、消融、种子、硬件）。** 只有后两项在记录里，其余存在 `ResearchStage.summary` 的自由文本和方案产物中。要结构化就需要新的命令字段、schema 改动、工具 schema 改动以及提示词改动让模型去填——这超出本次界面改动的范围。卡片展示摘要、环境、预算，以及方案全文的链接。

**在运行中的实验卡片上显示实时指标。** `experiment_runner.py` 只在 `child.wait()` 之后才写 `metrics.json`，而 `observeExperiment` 取 `state.metrics ?? run.metrics`，空对象并非 nullish，于是运行中的轮询反而会用 `{}` 覆盖。因此运行中的卡片只显示已用时长与已批准的上限，不显示无法佐证的数字。

**把「管理环境」做成跳转设置面板的按钮。** `ui-settings` 只向引导流程暴露 `openSection`，没有面向插件的打开接口。侧栏因此只说明去哪里改，而不提供一个点不动的控件。

**直接删掉文件工作台。** 设计移除的是「并列的第二个应用」，不是这项能力；产品里没有别的地方能编辑产物或驱动 draw.io。把它从导航中摘掉即可达成前者，而不必丢弃后者。

## 后果

`ctx.layout.selectPanel` 在其 `main` 键未注册时会抛错，因此 `main` 注册与 `ResearchInjected.expand` 必须同进退；标题栏的控件现在是它们唯一的调用者。移除 `ResearchCompanion` 同时去掉了重复的侧面板和该包的两处 lint 违规。

`t` 支持 `{name}` 占位替换，因此带数字和日期的句子是完整的词条，而不是在渲染处拼接的碎片；`decisionBudgetMath` 由两个键加粘连文本合并为一个。日期走词典模板与 `pad2`，不走 `Intl`，因为 `toLocaleString` 跟随浏览器语言而非界面语言。

该包的样式表现在满足此前就已失败的主题门禁：每个圆形圆角都带 `corner-shape: round`，纯色中性边框一律 0.5px 发丝线，每个位于着色表面上的滚动容器都重绑定 l2 滚动条配色。

`publicProject` 仍然清空 `EvidenceRecord.chunks`，因此论点面板展示 `EvidenceLink.quote`——宿主在写入时已针对原文校验过的那段文本——并且只在 `source.revision === link.revision && !source.stale` 时展示摘要哈希，因为存储的哈希属于当前版本，而不是链接所引用的那一版。
