/** Consumer-owned navigation for Markdown links. */
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'

/**
 * Handle one sanitized absolute HTTP(S) URL selected from Markdown.
 * @param href - destination URL.
 */
export type MarkdownExternalLinkHandler = (href: string) => void

/**
 * A link whose destination uses a scheme the renderer never turns into an anchor, offered to the owner of the
 * Markdown scope so that a feature can draw its own inline element.
 */
export interface MarkdownSchemeLink {
  /** The destination's scheme in lower case, without the colon (`kg` for `kg:ai:paper:42`). */
  readonly scheme: string
  /** The destination exactly as the author wrote it, after Markdown escapes were resolved. */
  readonly destination: string
  /** The plain text of the link's content, without formatting. */
  readonly label: string
}

/** Navigation capabilities supplied by the nearest Markdown owner. */
export interface MarkdownDelegate {
  /** Image previews for decoded local paths in this owner's workspace. */
  readonly fileImages?: {
    resolve: (path: string) => string | undefined
    labels: ImageLightboxLabels & { open: string; loading: string; failed: string }
  } | undefined
  /** Ordinary HTTP(S) activation; absent handlers retain native anchor behavior. */
  readonly openExternalLink?: MarkdownExternalLinkHandler | undefined
  /**
   * Open a decoded local destination from settled Markdown; absent handlers leave plain text.
   * @param path - Absolute or workspace-relative file path.
   * @param options - First line to reveal when the destination specifies a line or range.
   */
  readonly openFile?: ((path: string, options?: { line?: number }) => void) | undefined
  /** Resolve an authored plain-text path only when its owner knows that exact file. */
  readonly knownFilePath?: ((path: string) => boolean) | undefined
  /**
   * Draw a link whose scheme the renderer drops (anything but HTTP(S), mailto and local file destinations) in
   * settled content. The result replaces the dropped link's text and is never an anchor made by the renderer;
   * an owner that claims no scheme returns `fallback`. Absent handlers leave the link's text, as before.
   * @param link - the scheme, destination and plain text of the link.
   * @param fallback - the link's content as the renderer draws it without a handler.
   * @returns the node to draw in place of the link's content.
   */
  readonly renderSchemeLink?: ((link: MarkdownSchemeLink, fallback: ReactNode) => ReactNode) | undefined
}

const MarkdownDelegateContext = createContext<MarkdownDelegate>({})

/** Props for one Markdown navigation scope. */
export interface MarkdownDelegateProviderProps extends MarkdownDelegate {
  readonly children: ReactNode
}

/**
 * Scope Markdown navigation without threading callbacks through renderers.
 * Nested providers replace the enclosing capabilities. Handler changes reach cached links.
 * @param props - Child tree and its file, HTTP(S) and scheme-link handlers.
 * @returns the scoped child tree.
 */
export function MarkdownDelegateProvider({
  children,
  openExternalLink,
  openFile,
  fileImages,
  knownFilePath,
  renderSchemeLink,
}: MarkdownDelegateProviderProps): ReactNode {
  const delegate = useMemo(
    () => ({ openExternalLink, openFile, fileImages, knownFilePath, renderSchemeLink }),
    [openExternalLink, openFile, fileImages, knownFilePath, renderSchemeLink],
  )
  return (
    <MarkdownDelegateContext.Provider value={delegate}>
      {children}
    </MarkdownDelegateContext.Provider>
  )
}

/**
 * Read the nearest Markdown navigation capabilities.
 * @returns Owner callbacks, or an empty delegate outside a provider.
 */
export function useMarkdownDelegate(): MarkdownDelegate {
  return useContext(MarkdownDelegateContext)
}
