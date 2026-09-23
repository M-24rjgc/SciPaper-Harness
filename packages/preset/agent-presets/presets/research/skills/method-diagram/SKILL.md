---
name: method-diagram
description: Use to draw the paper's architecture or method overview figure as an editable diagram — TikZ inside the paper, or a draw.io file the user can edit in the built-in editor — and check it visually.
---

# The architecture diagram

The overview figure is usually the first thing a reviewer reads. It must match the method section exactly: same components, same names (from `outline.md`), same data flow.

## Choose the medium

- **TikZ** (default when you work alone): a `figures/architecture.tex` holding one `tikzpicture`, `\input` into a `figure` environment. It is vector, compiles with the paper, keeps text editable, and needs nobody to export it.
- **draw.io** (when the user wants to edit visually, or asks for it): write `figures/architecture.drawio` as draw.io XML (`<mxfile><diagram name="Architecture"><mxGraphModel>…`). The user opens it in the workbench's built-in draw.io editor. The paper needs an exported file next to it (`figures/architecture.pdf` or `.png`): ask the user to export it from the editor (checkpoints), or, if you must finish alone, also draw the TikZ version and say the draw.io file is the one to refine visually.

Register the diagram with `research_artifact` register-artifact, kind `diagram`.

## Drawing it well

1. **List the components and edges first**: inputs → modules → outputs, with what flows along each edge (tensors, tokens, losses). Only what the method section describes.
2. **One reading direction** (left→right or top→bottom). Group a module's internals in a rounded box with a label.
3. **Few colours, used for meaning** (e.g. trainable vs frozen, data vs control), readable in grayscale; 8–10 pt text at final size; no text smaller than the caption.
4. **Label with the notation** of the paper (`$\mathbf{x}$`, `$f_\theta$`) where the text uses it.
5. **Caption** that says what the figure shows and the one thing to notice.

A TikZ skeleton:

```latex
\begin{tikzpicture}[node distance=12mm, box/.style={draw, rounded corners, minimum height=8mm, align=center}, >=latex]
  \node[box] (in) {Input $\mathbf{x}$};
  \node[box, right=of in] (enc) {Encoder $f_\theta$};
  \node[box, right=of enc] (head) {Head};
  \draw[->] (in) -- (enc);
  \draw[->] (enc) -- node[above]{$\mathbf{z}$} (head);
\end{tikzpicture}
```

## Check it

Compile, then `render-pages` and `read_image` the page with the figure: nothing clipped or overlapping, text legible at print size, names identical to the method section. Fix and look again.
