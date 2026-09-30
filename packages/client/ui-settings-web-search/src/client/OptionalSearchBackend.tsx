/** Credential setup and readiness for optional search bundles in the existing Plugins page. */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button, SettingsSecretField, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { WebSearchSettingsLocaleKey } from './locales.ts'

export interface CredentialStatus {
  readonly configured: boolean
  readonly writable: boolean
}

export interface SearchCredentialFace {
  readCredential(this: void, ref: string): Promise<CredentialStatus | undefined>
  writeCredential(this: void, ref: string, value: string): Promise<void>
  onCredentialChanged(this: void, listener: (ref: string) => void): () => void
}

export interface SearchBackend {
  readonly bundle: string
  readonly ref: string
  readonly nameKey: WebSearchSettingsLocaleKey
}

export const SEARCH_BACKENDS: readonly SearchBackend[] = [
  { bundle: '@deepseek-ai/dsh-web-search-exa-bundle', ref: 'EXA_API_KEY', nameKey: 'providerExa' },
  { bundle: '@deepseek-ai/dsh-web-search-perplexity-bundle', ref: 'PERPLEXITY_API_KEY', nameKey: 'providerPerplexity' },
]

export function searchBackend(bundle: string): SearchBackend | undefined {
  return SEARCH_BACKENDS.find(candidate => candidate.bundle === bundle)
}

type Status = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; value: CredentialStatus }

function useCredential(ref: string, io: SearchCredentialFace): readonly [Status, () => Promise<void>] {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const { readCredential, onCredentialChanged } = io
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const value = await readCredential(ref)
      setStatus(value === undefined ? { kind: 'error' } : { kind: 'ready', value })
    } catch {
      setStatus({ kind: 'error' })
    }
  }, [readCredential, ref])
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      try {
        const value = await readCredential(ref)
        if (active) setStatus(value === undefined ? { kind: 'error' } : { kind: 'ready', value })
      } catch {
        if (active) setStatus({ kind: 'error' })
      }
    }
    void read()
    const unsubscribe = onCredentialChanged((changed) => { if (changed === ref) void read() })
    return () => { active = false; unsubscribe() }
  }, [onCredentialChanged, readCredential, ref])
  return [status, refresh]
}

export type SearchBackendConfigProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<SearchCredentialFace & { backend: SearchBackend }>

/** The optional bundle's key is stored through the credential domain, never its YAML patch. */
export function SearchBackendConfig(props: SearchBackendConfigProps): ReactNode {
  const { backend, t } = props
  const [status, refresh] = useCredential(backend.ref, props)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const save = async (): Promise<void> => {
    if (draft.length === 0 || saving) return
    setSaving(true)
    setFailed(false)
    try {
      await props.writeCredential(backend.ref, draft)
      setDraft('')
      await refresh()
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  const configured = status.kind === 'ready' && status.value.configured
  const writable = status.kind === 'ready' && status.value.writable
  return (
    <div data-search-backend-config={backend.bundle}>
      <p>{t('backendDescription', { name: t(backend.nameKey) })}</p>
      <SettingsSecretField
        id={`plugin-config-${backend.ref.toLowerCase()}`}
        label={t('apiKey')}
        hint={t('apiKeyHint')}
        text={draft}
        configured={configured}
        stateLabel={status.kind === 'error' ? t('backendUnknown') : status.kind === 'loading'
          ? t('backendChecking') : configured ? t('backendReady') : t('backendPending')}
        disabled={!writable || saving}
        onEdit={setDraft}
      />
      <Button variant="primary" size="sm" disabled={!writable || draft.length === 0 || saving} onClick={() => { void save() }}>
        {t(saving ? 'saving' : 'save')}
      </Button>
      {failed && <p role="alert">{t('saveFailed')}</p>}
      <p>{t('backendSelection')}</p>
    </div>
  )
}

export type SearchBackendBadgeProps = PropsRuntime<'plugins.detail.badge'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<SearchCredentialFace>

/** A configured key is distinct from a switched-on bundle or a successful network search. */
export function SearchBackendBadge(props: SearchBackendBadgeProps): ReactNode {
  const backend = props.subject.kind === 'bundle' ? searchBackend(props.subject.pkg.name) : undefined
  if (backend === undefined) return null
  return <SearchBackendBadgeBody {...props} backend={backend} />
}

function SearchBackendBadgeBody(props: SearchBackendBadgeProps & { backend: SearchBackend }): ReactNode {
  const [status] = useCredential(props.backend.ref, props)
  const configured = status.kind === 'ready' && status.value.configured
  const enabled = props.subject.kind === 'bundle' && props.subject.pkg.enabled
  const label = status.kind === 'error' ? props.t('backendUnknown') : status.kind === 'loading'
    ? props.t('backendChecking') : configured ? props.t('backendReady')
      : props.t(enabled ? 'backendEnabledPending' : 'backendPending')
  return <Tag tone={configured ? 'success' : 'warning'}>{label}</Tag>
}
