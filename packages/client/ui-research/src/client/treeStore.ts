/**
 * The research tree's viewing store: which rows the person opened or closed.
 * It outlives the tree's own mounts (the sidebar unmounts the tree while it is
 * collapsed), and a row without an explicit choice follows its default
 * (`treeValues.ts`). Nothing is persisted across reloads.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** The tree's viewing state. */
type TreeViewState = {
  /** The person's explicit open or closed choice by row key; a missing key follows the row's default. */
  expanded: Record<string, boolean>
}

/** Annotation twin of the actions literal below (the export needs a declared return type). */
type TreeViewActions = {
  setExpanded: (draft: TreeViewState, key: string, expanded: boolean) => void
}

/**
 * Create the research tree's viewing store handle.
 * @returns the store handle the tree's registration declares.
 */
export function createResearchTreeStore(): EngineStoreHandle<TreeViewState, TreeViewActions> {
  return defineStore({
    init: (): TreeViewState => ({ expanded: {} }),
    actions: {
      setExpanded: (d, key: string, expanded: boolean) => { d.expanded[key] = expanded },
    },
  })
}
