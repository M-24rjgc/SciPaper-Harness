/** Per-session Conversation store shared by the shell body and header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationStoreState } from './contract/views.ts'

const CONVERSATION_STORE_KEY = 'dsh.conversation'

/** Declared write set for the Conversation shell. */
type ConversationActions = {
  setDraft: (draft: ConversationStoreState, text: string) => void
  setView: (draft: ConversationStoreState, view: string) => void
  openView: (draft: ConversationStoreState, view: string, focus: string) => void
  completeViewRequest: (draft: ConversationStoreState) => void
}

/**
 * Declare per-session draft persistence and View selection.
 * @returns the store handle.
 */
export function createConversationStore(): EngineStoreHandle<ConversationStoreState, ConversationActions> {
  return defineStore({
    init: (): ConversationStoreState => ({ draft: '', view: null, viewRequest: null }),
    persist: CONVERSATION_STORE_KEY,
    actions: {
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      openView: (d, view: string, focus: string) => {
        d.view = view
        d.viewRequest = { view, focus }
      },
      completeViewRequest: (d) => { d.viewRequest = null },
    },
  })
}

/**
 * Read the persisted View preference before the Slot store is materialized.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the preferred View id, or null when storage has no usable value.
 */
export function readConversationViewPreference(sessionId: SessionId): string | null {
  return readPersistedString(sessionId, 'view')
}

/**
 * Read a saved draft before its Conversation view mounts and seeds the editor.
 * @param sessionId - Session-scoped persistence suffix.
 * @returns the saved text, or an empty draft when storage has no usable value.
 */
export function readConversationDraft(sessionId: SessionId): string {
  return readPersistedString(sessionId, 'draft') ?? ''
}

function readPersistedString(sessionId: SessionId, key: 'view' | 'draft'): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(`${CONVERSATION_STORE_KEY}.${sessionId}`)
    if (raw === null) return null
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null || !(key in stored)) return null
    const value: unknown = (stored as Record<string, unknown>)[key]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
