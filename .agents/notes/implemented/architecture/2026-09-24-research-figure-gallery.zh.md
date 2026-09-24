# Agent Note: A figure gallery of top-venue Figure 1s for every research mode

Status: implemented

[English](2026-09-24-research-figure-gallery.md) | 中文

## 问题

科研工作台的每个画图技能，都要先看看优秀论文怎么画同类的图：spark-to-paper 的配图阶段要求示意图以一张同领域顶会主图为参考，CCFA 的视觉编排技能有参考版式模式，通用模式的 method-diagram 技能也要在动笔前研究相近的论文。以前唯一的工具是 fetch-reference-figures：agent 要先自己找到 arXiv 编号，再由它根据 ar5iv 上的图注猜哪张是总览图，所以找参考常常失败，或者挑到一张结果图。

## 决定

平台内置 Top-Conf Figure Gallery 的索引，作为所有模式共用的能力。该配图库收录约 3,500 张 ICLR、ICML、NeurIPS、CVPR、ACL 与 AAAI 论文（2023 至 2026 年）的 Figure 1 与概览图，每张都经维护者人工复核。

- **只带索引。** `scripts/build_figure_gallery.py` 读取配图库固定版本的 `data/figures.json`，写出 `runtime/figure-gallery/index.json.gz`，并附上配图库的 MIT 许可证和一份说明。图片的版权归各自的论文，所以一张都不打包。
- **检索。** `research_media` 的 find-reference-figures 按会议、年份、视觉类型和等级筛选；有查询词时用 BM25 在标题、作者、会议和类型上排序，没有查询词时最受认可的图排在前面。配置了嵌入接口时，标题嵌入在后台计算一次，按模型和索引版本缓存；之后的查询把它与关键词排序融合。每页都注明排序依据。
- **按需取图。** fetch-reference-figures `{galleryIds, label}` 依次从配图库的仓库、CDN 镜像和它的网站取回选中的图，缓存在产品主目录下，并保存到 `figures/refs/`，旁边附一份写明论文及其版权的 `.source.json`。图片取自线上的配图库，所以它下架的图也就取不到了。ar5iv 的途径保留，用于这些会议之外的论文。
- **人和 agent 都能用。** 工作台的「配图灵感」标签页从对话标题栏打开，通过宿主路由 `/api/research/gallery/image` 浏览同一份索引，并用同一个动作保存图片。三个画图技能都先查配图库，查不到再找 arXiv 论文。

## 考虑过的其他方案

**把图片打进安装包。** 安装包会增加约 400 MB，而且等于再分发配图库本身只为教学参考而索引的图片，其中 AAAI 的图由作者和出版方保留版权。

**嵌入配图库自己的网页。** 它没法把选中的图交给项目，界面文字也不在产品的多语言词典里。原生的标签页使用产品自己的检索和保存动作。
