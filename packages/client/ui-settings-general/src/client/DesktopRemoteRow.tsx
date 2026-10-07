/** Desktop-owned mobile pairing controls rendered in General settings. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopRemoteView } from './desktop-remote-source.ts'
import css from './DesktopRemoteRow.module.css'

/** The isolated carrier is injected only on desktop. */
export interface DesktopRemoteInjected {
  hooks: { remoteAccess: ObservableSnapshot<DesktopRemoteView> }
  run(action: 'start' | 'refresh' | 'stop'): void
}

/** QR and invitation are visible only inside the owned desktop document. */
export function DesktopRemoteRow({ useRemoteAccess, run, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & InjectFace<DesktopRemoteInjected>) {
  const { presentation, failed, refreshing } = useRemoteAccess(value => value)
  const [now, setNow] = useState(Date.now)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    setCopied(false)
    setCopyFailed(false)
    setNow(Date.now())
    if (presentation.expiresAt === undefined) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [presentation.expiresAt, presentation.pairingUrl])
  const active = ['preparing', 'connecting', 'ready', 'stopping'].includes(presentation.phase)
  const valid = presentation.phase === 'ready' && presentation.expiresAt !== undefined && now < presentation.expiresAt
  return <div className={css.row}>
    <div className={css.title}>{t('remote.title')}</div>
    <div className={css.description}>{t('remote.description')}</div>
    <div aria-live="polite" className={css.status}>
      {presentation.phase === 'idle' ? t('remote.idle')
        : presentation.phase === 'error' ? t(`remote.error.${presentation.failure ?? 'connection'}`)
          : t(`remote.${presentation.phase}`)}
    </div>
    {presentation.phase === 'ready' && <>
      <div className={css.origin}>{presentation.origin}</div>
      {valid && presentation.qrCode !== undefined && <img className={css.qr} src={presentation.qrCode} alt={t('remote.qr')} />}
      <div className={css.description}>{valid ? t('remote.invitation') : t('remote.expired')}</div>
      <div className={css.description}>{t('remote.temporary')}</div>
    </>}
    <div className={css.actions}>
      {!active && <Button variant="primary" onClick={() => { run('start') }}>{t('remote.start')}</Button>}
      {presentation.phase === 'ready' && <>
        <Button variant="outline" disabled={!valid || refreshing} onClick={() => {
          const url = presentation.pairingUrl
          if (url === undefined) return
          setCopyFailed(false)
          void navigator.clipboard.writeText(url).then(() => { setCopied(true) }, () => { setCopyFailed(true) })
        }}>{copied ? t('remote.copied') : t('remote.copy')}</Button>
        <Button variant="outline" disabled={refreshing} onClick={() => { run('refresh') }}>{t('remote.refresh')}</Button>
      </>}
      {active && <Button variant="outline" disabled={presentation.phase === 'stopping'} onClick={() => { run('stop') }}>{t('remote.stop')}</Button>}
    </div>
    {(failed || copyFailed) && <div role="alert">{t(copyFailed ? 'remote.copyFailed' : 'remote.failed')}</div>}
  </div>
}
