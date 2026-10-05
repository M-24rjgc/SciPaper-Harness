/**
 * The research's autonomy in the composer, in the seat of the shell's access
 * chip (`conversation.input.permission`). Autonomy is the person's and holds
 * for every conversation of the research: choosing one sends `set-autonomy`,
 * and the host applies the matching access preset to each of them. The chip
 * reads this conversation's preset from the `permissions` projection, so a
 * preset typed by hand with `/permission` shows here until the next choice
 * applies the autonomy again. An example reads as read-only. A conversation
 * outside every research changes its own access preset through the session
 * command, without creating a project or changing another conversation.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Autonomy } from '@deepseek-ai/dsh-research-workbench/types'
// Type-only: the `permissions` projection key comes with the Remote assembly's type exports.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { useSessionProject, type WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { autonomyName, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import styles from './AutonomyChip.module.css'

/** The access preset the host applies to every conversation of a research with this autonomy. */
const AUTONOMY_PRESET: Record<Autonomy, string> = { checkpoints: 'workspace-write', automatic: 'research-auto' }
/** What each choice promises, under its name in the menu. */
const AUTONOMY_DETAIL: Record<Autonomy, ResearchKey> = { checkpoints: 'autonomyCheckpointsDetail', automatic: 'autonomyAutomaticDetail' }
const AUTONOMIES: readonly Autonomy[] = ['checkpoints', 'automatic']
/**
 * The names of the presets a conversation can be switched to by hand. The two
 * an autonomy applies go by the autonomy's name; a preset the host was
 * configured with beyond these shows as the host spells it.
 */
const PRESET_NAMES = new Map<string, ResearchKey>([
  ['workspace-write', 'autonomyShortCheckpoints'],
  ['research-auto', 'autonomyShortAutomatic'],
  ['read-only', 'presetReadOnly'],
  ['danger-full-access', 'presetFullAccess'],
  ['auto', 'presetAutoReview'],
  ['custom', 'presetCustom'],
])

/** Composed props of the composer's access seat: the seat's own values, the dictionary and the research face. */
export type AutonomyChipProps = PropsRuntime<'conversation.input.permission'> & WorkbenchProps

/** One access preset by the name this product gives it. */
function presetName(preset: string, t: Translate): string {
  const key = PRESET_NAMES.get(preset)
  return key === undefined ? preset : t(key)
}

/** One menu row: the autonomy's name over what it promises. */
function option(autonomy: Autonomy, t: Translate): MenuEntry {
  return {
    id: autonomy,
    label: <span className={styles.option}>
      <span className={styles.optionName}>{autonomyName(autonomy, t)}</span>
      <span className={styles.optionDetail}>{t(AUTONOMY_DETAIL[autonomy])}</span>
    </span>,
  }
}

/**
 * The composer chip for the research's autonomy: `检查点 ▾` or `全自动 ▾`,
 * `本对话：<preset>` while this conversation runs under another preset, and
 * `示例 · 只读` in an example.
 */
export function AutonomyChip(props: AutonomyChipProps): ReactNode {
  const { t, locked } = props
  const project = useSessionProject(props)
  const preset = props.useProjection('permissions', selection => selection?.currentValue)
  const change = useAction()
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<Autonomy>('checkpoints')
  useEffect(() => { if (locked) setOpen(false) }, [locked])
  if (project === undefined && preset === undefined) return null
  if (project?.example === true) return <span className={styles.example} title={t('exampleBanner')}>{t('autonomyExample')}</span>
  // While a choice is being saved the chip already names it; the host moves every conversation's preset with it.
  const savedAutonomy = project?.autonomy ?? (preset === 'research-auto' ? 'automatic' : 'checkpoints')
  const autonomy = change.pending ? choice : savedAutonomy
  const name = autonomyName(autonomy, t)
  const handSet = !change.pending && preset !== undefined && preset !== AUTONOMY_PRESET[savedAutonomy]
    ? presetName(preset, t)
    : undefined
  const choose = (id: string): void => {
    setOpen(false)
    const next = id as Autonomy
    // Choosing the autonomy already in force changes nothing, unless this conversation left it by hand.
    if (next === savedAutonomy && handSet === undefined) return
    setChoice(next)
    change.start(() => project === undefined
      ? props.setConversationAutonomy(props.sessionId, next)
      : props.run({ action: 'set-autonomy', projectId: project.id, autonomy: next }))
  }
  const items: MenuEntry[] = [{ type: 'label', id: 'heading', text: t(project === undefined ? 'autonomyConversationHeading' : 'autonomyMenuHeading') }, ...AUTONOMIES.map(value => option(value, t))]
  return <div className={styles.root}>
    <Menu
      open={open}
      items={items}
      selectedId={autonomy}
      onSelect={choose}
      onClose={() => { setOpen(false) }}
      side="top"
      portal
      autoFocus
      anchor={<button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={handSet === undefined ? t('autonomyChip', { name }) : t('autonomyChipDiverged', { name, preset: handSet })}
        title={handSet === undefined ? t(AUTONOMY_DETAIL[autonomy]) : t('autonomyDivergedHint')}
        disabled={locked || change.pending}
        onClick={() => { setOpen(!open) }}
      >
        <span className={handSet === undefined ? styles.label : `${styles.label} ${styles.handSet}`}>
          {handSet === undefined ? name : t('autonomyThisConversation', { preset: handSet })}
        </span>
        <span className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron} aria-hidden>
          <IconChevronDownOutlineRegular />
        </span>
      </button>}
    />
    <ActionError t={t} error={change.error} className={styles.error} />
  </div>
}
