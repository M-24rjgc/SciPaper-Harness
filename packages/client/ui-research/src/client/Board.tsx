/**
 * The experiment board. Its fixed part is the same for every project: where
 * the reads stand, the runs in flight, each experiment machine and every run.
 * The sections between are the agent's layout. The page asks the service for
 * the board every fifteen seconds while it is open; the service's scripts do
 * the reading, so watching an experiment never costs a model call.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { BoardAlert, BoardMachine, BoardSnapshot, BoardStat, ExperimentRecord, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ACTIVE_RUN_STATUS, PROBLEM_RUN_STATUS, fieldPoints, gigabytes, mergedSections, numberText, shownValue, watchedKeys, xKey } from './boardValues.ts'
import { Mark, Meter, SectionView, StatTile } from './BoardBlocks.tsx'
import { durationText, elapsedOf, momentText, type Translate } from './format.ts'
import { LineChart } from './LineChart.tsx'
import type { ResearchKey } from './locales.ts'
import { MetricsGrid } from './MetricsGrid.tsx'
import styles from './Board.module.css'

type BoardProps = WorkbenchProps & { project: ResearchProject }

/** How often an open board asks again, and how soon while a read is under way. */
const AUTO_MS = 15_000
const READING_MS = 2_000
const MS_PER_SECOND = 1000
/** Fields drawn per run in flight, and per run opened in the list. */
const LIVE_FIELDS = 4
const DETAIL_FIELDS = 6
/** Runs listed before the rest wait behind a button. */
const LISTED_RUNS = 30
/** A fraction below this gives no useful time estimate yet. */
const ESTIMATE_FLOOR = 0.02
/** Memory or disk use from which the meter turns amber. */
const NEARLY_FULL = 0.9
/** Metrics the run list shows beside each run. */
const LISTED_METRICS = 3
const FILTERS = ['all', 'active', 'done', 'problem'] as const
type Filter = typeof FILTERS[number]
const FILTER_KEYS: Record<Filter, ResearchKey> = { all: 'boardFilterAll', active: 'boardFilterActive', done: 'boardFilterDone', problem: 'boardFilterProblem' }
const ALERT_CLASSES: Record<BoardAlert['level'], string | undefined> = { info: styles.alertInfo, warning: styles.alertWarning, error: styles.alertError }

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const pad2 = (value: number): string => value < 10 ? `0${value}` : String(value)
/** A moment of today as hours and minutes, for the machine history's axis. */
const clockText = (ms: number, t: Translate): string => {
  const at = new Date(ms)
  return t('boardClock', { h: pad2(at.getHours()), min: pad2(at.getMinutes()) })
}
const newestFirst = (runs: ExperimentRecord[]): ExperimentRecord[] => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

export function Board(props: BoardProps): ReactNode {
  const { project, t } = props
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null)
  const [error, setError] = useState('')
  const [auto, setAuto] = useState(true)
  const [asked, setAsked] = useState(0)
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (refresh: boolean): void => {
      props.board({ action: 'board-view', projectId: project.id, refresh }).then((next) => {
        if (!active) return
        setSnapshot(next)
        setError('')
        if (next.refreshing) timer = setTimeout(() => { load(false) }, READING_MS)
        else if (auto) timer = setTimeout(() => { load(true) }, AUTO_MS)
      }, (reason: unknown) => {
        if (!active) return
        setError(errorText(reason))
        if (auto) timer = setTimeout(() => { load(true) }, AUTO_MS)
      })
    }
    load(true)
    return () => { active = false; clearTimeout(timer) }
  }, [project.id, auto, asked])
  const runs = project.experiments
  const inFlight = newestFirst(runs.filter(run => ACTIVE_RUN_STATUS.includes(run.status)))
  const sections = snapshot ? mergedSections(snapshot.spec, snapshot.collected) : []
  const collected = snapshot ? Object.entries(snapshot.collected) : []
  const alerts: BoardAlert[] = [
    ...snapshot?.alerts ?? [],
    ...collected.flatMap(([, output]) => output.alerts),
    ...runs.filter(run => run.status === 'unknown').map(run => ({ level: 'warning' as const, text: t('boardUnknownRun', { name: run.spec.name }) })),
  ]
  const state = error ? 'offline' : snapshot?.refreshing ? 'reading' : snapshot?.capturedAt ? 'live' : 'stale'
  const stateKeys: Record<typeof state, ResearchKey> = { offline: 'boardOffline', reading: 'boardReading', live: 'boardLive', stale: 'boardStale' }
  const empty = runs.length === 0 && sections.length === 0
  return <section className={styles.root} aria-label={t('boardTitle')}>
    <header className={styles.head}>
      <div className={styles.heading}>
        <h2>{snapshot?.spec.title ?? t('boardTitle')}</h2>
        {snapshot?.spec.summary !== undefined && <p>{snapshot.spec.summary}</p>}
      </div>
      <div className={styles.sync}>
        <span className={styles.live} data-state={state} role="status"><i />{t(stateKeys[state])}</span>
        {snapshot?.capturedAt !== undefined && <span className={styles.muted}>{t('boardReadAt', { time: momentText(snapshot.capturedAt, t) })}</span>}
        <label className={styles.toggle}><input type="checkbox" checked={auto} onChange={(event) => { setAuto(event.target.checked) }} />{t('boardAuto')}</label>
        <button type="button" onClick={() => { setAsked(asked + 1) }}>{t('boardSyncNow')}</button>
      </div>
    </header>
    {snapshot?.spec.tags !== undefined && <div className={styles.tags}>{snapshot.spec.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
    {error && <div className={styles.alertError} role="alert">{error}</div>}
    {alerts.length > 0 && <ul className={styles.alerts}>
      {alerts.map((alert, index) => <li key={index} className={ALERT_CLASSES[alert.level]}>{alert.text}</li>)}
    </ul>}
    <Overview {...props} stats={collected.flatMap(([, output]) => output.stats)} />
    {empty && <p className={styles.empty}>{t('boardEmpty')}</p>}
    {inFlight.length > 0 && <section className={styles.panel}>
      <h3>{t('boardActive')}</h3>
      <div className={styles.liveRuns}>
        {inFlight.map(run => <LiveRun key={run.id} {...props} record={run} rows={snapshot?.series[run.id] ?? []} />)}
      </div>
    </section>}
    {snapshot && snapshot.machines.length > 0 && <section className={styles.panel}>
      <h3>{t('boardMachines')}</h3>
      <div className={styles.machines}>{snapshot.machines.map(machine => <MachineCard key={machine.key} t={t} machine={machine} />)}</div>
    </section>}
    {snapshot && sections.map(section => <SectionView key={section.id} t={t} project={project} snapshot={snapshot} section={section} />)}
    {runs.length > 0 && snapshot && <RunList {...props} snapshot={snapshot} />}
    <footer className={styles.footer}>
      <p>{t('boardFootnote')}</p>
      {collected.map(([id, output]) => <p key={id} className={output.error === undefined ? undefined : styles.warning}>
        {output.error === undefined
          ? t('boardCollectorOk', { id, time: momentText(output.at, t), ms: output.ms })
          : t('boardCollectorError', { id, error: output.error })}
      </p>)}
    </footer>
  </section>
}

/** The row of counts that opens the board, then the numbers collectors report. */
function Overview(props: BoardProps & { stats: BoardStat[] }): ReactNode {
  const { project, t } = props
  const count = (statuses: readonly string[]): number => project.experiments.filter(run => statuses.includes(run.status)).length
  const tiles: [ResearchKey, number][] = [
    ['boardRunning', count(['running'])], ['boardQueued', count(['queued'])], ['boardDone', count(['completed'])], ['boardAttention', count(PROBLEM_RUN_STATUS)],
  ]
  return <div className={styles.tiles}>
    {tiles.map(([key, n]) => <StatTile key={key} label={t(key)} shown={{ text: String(n), state: 'value', tone: key === 'boardAttention' && n > 0 ? 'warning' : undefined }} />)}
    {props.stats.map((stat, index) => <StatTile
      key={index} label={stat.label} shown={shownValue(project, stat, t)} progress={stat.progress}
    />)}
  </div>
}

/** How far a run has got: its own progress fraction when it reports one, else its time against its limit. */
function runFraction(run: ExperimentRecord): number {
  const fraction = run.progress?.fraction
  if (fraction !== undefined) return fraction
  return (elapsedOf(run) ?? 0) / (run.spec.maxSeconds * MS_PER_SECOND)
}

/** Stop a run, or read its logs: the two things a person does to a run in flight. */
function RunActions(props: BoardProps & { record: ExperimentRecord }): ReactNode {
  const { project, record: run, t } = props
  const [logs, setLogs] = useState('')
  const showLogs = (): void => {
    void props.run({ action: 'experiment-logs', projectId: project.id, runId: run.id })
      .then((response) => { setLogs(response.content ?? response.message) }, (reason: unknown) => { setLogs(errorText(reason)) })
  }
  return <>
    <div className={styles.actions}>
      <button type="button" onClick={showLogs}>{t('logs')}</button>
      {ACTIVE_RUN_STATUS.includes(run.status) && run.status !== 'unknown' && <button
        type="button" className={styles.stop}
        onClick={() => { void props.run({ action: 'experiment-cancel', projectId: project.id, runId: run.id }).catch(() => {}) }}
      >{t('runStop')}</button>}
    </div>
    {logs !== '' && <pre className={styles.log}>{logs}</pre>}
  </>
}

/** One run in flight: how far it is, what it is doing, and the numbers it reports, each as a small curve. */
function LiveRun(props: BoardProps & { record: ExperimentRecord; rows: Record<string, number>[] }): ReactNode {
  const { project, record: run, rows, t } = props
  const environment = project.environments.find(item => item.id === run.spec.environmentId)
  const elapsed = elapsedOf(run)
  const fraction = run.progress?.fraction
  const remaining = fraction !== undefined && fraction >= ESTIMATE_FLOOR && elapsed !== undefined ? elapsed / fraction - elapsed : undefined
  const x = xKey(rows)
  const keys = watchedKeys(rows, x, LIVE_FIELDS)
  return <article className={styles.liveRun}>
    <div className={styles.runHead}>
      <Mark status={run.status} />
      <span className={styles.runName}>{run.spec.name} · {t('runSeed')} {run.spec.seed}</span>
      <span className={styles.muted}>{t(run.status === 'unknown' ? 'unknown' : run.status === 'queued' ? 'queued' : 'running')}</span>
      {environment && <span className={styles.runEnvironment}>{environment.name} · {t(environment.target)}</span>}
    </div>
    <Meter value={runFraction(run)} />
    <div className={styles.runMeta}>
      <span>{fraction === undefined
        ? `${t('runElapsed')} ${durationText(elapsed ?? 0, t)} · ${t('runLimit')} ${durationText(run.spec.maxSeconds * MS_PER_SECOND, t)}`
        : `${t('boardPercent', { n: Math.round(fraction * 100) })} · ${t('runElapsed')} ${durationText(elapsed ?? 0, t)}`}</span>
      {remaining !== undefined && <span>{t('boardEta', { time: durationText(remaining, t) })}</span>}
      {run.progress?.note !== undefined && <span>{run.progress.note}</span>}
    </div>
    {keys.length > 0
      ? <div className={styles.sparks}>{keys.map((key) => {
        const points = fieldPoints(rows, key, x)
        return <div key={key} className={styles.sparkTile}>
          <span className={styles.tileLabel}>{key}</span>
          <span className={styles.sparkValue}>{numberText((points.at(-1) as [number, number])[1])}</span>
          <LineChart t={t} lines={[{ label: key, points }]} name={key} compact />
        </div>
      })}</div>
      : run.progress && <MetricsGrid metrics={run.progress.values} />}
    <RunActions {...props} record={run} />
  </article>
}

/** One experiment machine: its GPUs, processors, memory and disk now, and their use over the last hours. */
function MachineCard(props: { t: Translate; machine: BoardMachine }): ReactNode {
  const { machine, t } = props
  const caption = [machine.host, machine.os, ...machine.environments].filter(Boolean).join(' · ')
  const history = ([['gpu', 'boardGpu'], ['gpuMemory', 'boardGpuMemory'], ['cpu', 'boardCpu'], ['memory', 'boardMemory']] as const)
    .map(([field, key]) => ({
      label: t(key),
      points: machine.history.flatMap((item): [number, number][] => item[field] === undefined ? [] : [[item.t, item[field]]]),
    }))
    .filter(line => line.points.length > 1)
  return <article className={styles.machine}>
    <div className={styles.machineHead}>
      <strong>{machine.key === 'local' ? t('boardThisMachine') : machine.key}</strong>
      <span className={styles.muted}>{caption}</span>
    </div>
    {machine.error !== undefined && <p className={styles.warning}>{machine.error}</p>}
    {machine.gpus.length === 0 && machine.error === undefined && <p className={styles.muted}>{t('boardNoGpu')}</p>}
    {machine.gpus.map((gpu, index) => <div key={index} className={styles.resource}>
      <div className={styles.resourceHead}>
        <span>{gpu.name}</span>
        <span>{gpu.util === undefined ? '—' : t('boardPercent', { n: Math.round(gpu.util) })}</span>
      </div>
      <Meter value={(gpu.util ?? 0) / 100} />
      <span className={styles.resourceSub}>{[
        gpu.memoryUsed !== undefined && gpu.memoryTotal !== undefined
          ? `${t('boardGpuMemory')} ${t('boardOfTotal', { used: gigabytes(gpu.memoryUsed * 1024 ** 2), total: gigabytes(gpu.memoryTotal * 1024 ** 2) })}` : '',
        gpu.temperature === undefined ? '' : t('boardTemperature', { n: Math.round(gpu.temperature) }),
        gpu.power === undefined ? '' : t('boardPower', { n: Math.round(gpu.power) }),
      ].filter(Boolean).join(' · ')}</span>
    </div>)}
    {machine.cpu?.util !== undefined && <div className={styles.resource}>
      <div className={styles.resourceHead}>
        <span>{t('boardCpu')}{machine.cpu.cores === undefined ? '' : ` · ${t('boardCores', { n: numberText(machine.cpu.cores, 0) })}`}</span>
        <span>{t('boardPercent', { n: Math.round(machine.cpu.util * 100) })}</span>
      </div>
      <Meter value={machine.cpu.util} />
    </div>}
    {machine.memory !== undefined && <div className={styles.resource}>
      <div className={styles.resourceHead}>
        <span>{t('boardMemory')}</span>
        <span>{t('boardOfTotal', { used: gigabytes(machine.memory.used), total: gigabytes(machine.memory.total) })}</span>
      </div>
      <Meter value={machine.memory.used / machine.memory.total} warn={machine.memory.used / machine.memory.total >= NEARLY_FULL} />
    </div>}
    {machine.disk !== undefined && <div className={styles.resource}>
      <div className={styles.resourceHead}>
        <span>{t('boardDisk')}</span>
        <span>{t('boardFree', { free: gigabytes(machine.disk.free), total: gigabytes(machine.disk.total) })}</span>
      </div>
      <Meter value={machine.disk.used / machine.disk.total} warn={machine.disk.used / machine.disk.total >= NEARLY_FULL} />
    </div>}
    {history.length > 0 && <LineChart
      t={t} lines={history} name={t('boardHistory')} percent min={0} max={1} formatX={ms => clockText(ms, t)} narrow
    />}
  </article>
}

/** Every run, newest first, filtered and searchable; opening one shows its command, numbers, curves and logs. */
function RunList(props: BoardProps & { snapshot: BoardSnapshot }): ReactNode {
  const { project, t } = props
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState('')
  const [all, setAll] = useState(false)
  const needle = query.trim().toLowerCase()
  const matching = newestFirst(project.experiments).filter(run => (filter === 'all'
    || (filter === 'active' && ACTIVE_RUN_STATUS.includes(run.status))
    || (filter === 'done' && run.status === 'completed')
    || (filter === 'problem' && PROBLEM_RUN_STATUS.includes(run.status)))
    && (needle === '' || run.spec.name.toLowerCase().includes(needle)))
  const listed = all ? matching : matching.slice(0, LISTED_RUNS)
  return <section className={styles.panel}>
    <div className={styles.listTools}>
      <h3>{t('boardAllRuns')}</h3>
      <div className={styles.filters} role="group" aria-label={t('boardAllRuns')}>
        {FILTERS.map(item => <button key={item} type="button" aria-pressed={filter === item} onClick={() => { setFilter(item) }}>{t(FILTER_KEYS[item])}</button>)}
      </div>
      <input type="search" className={styles.search} aria-label={t('boardSearch')} placeholder={t('boardSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
    </div>
    {listed.length === 0
      ? <p className={styles.muted}>{t('boardNoRuns')}</p>
      : <div className={styles.tableWrap}><table className={styles.table}>
        <thead><tr>
          <th>{t('boardColumnRun')}</th><th>{t('boardColumnStatus')}</th><th>{t('boardColumnEnvironment')}</th>
          <th className={styles.right}>{t('boardColumnTime')}</th><th>{t('boardColumnMetrics')}</th><th className={styles.right}>{t('boardColumnStarted')}</th>
        </tr></thead>
        <tbody>{listed.map((run) => {
          const environment = project.environments.find(item => item.id === run.spec.environmentId)
          const elapsed = elapsedOf(run)
          const metrics = Object.entries(run.metrics).slice(0, LISTED_METRICS)
          return [
            <tr key={run.id}>
              <td>
                <button type="button" className={styles.runLink} aria-expanded={open === run.id} onClick={() => { setOpen(open === run.id ? '' : run.id) }}>
                  <Mark status={run.status} /> {run.spec.name}
                </button>
                <span className={styles.muted}> · {t('runSeed')} {run.spec.seed}</span>
              </td>
              <td>{t(run.status)}{run.progress?.fraction !== undefined && ACTIVE_RUN_STATUS.includes(run.status) ? ` · ${t('boardPercent', { n: Math.round(run.progress.fraction * 100) })}` : ''}</td>
              <td className={styles.muted}>{environment ? `${environment.name} · ${t(environment.target)}` : '—'}</td>
              <td className={styles.right}>{elapsed === undefined ? '—' : durationText(elapsed, t)}</td>
              <td className={styles.muted}>{metrics.map(([name, value]) => `${name} ${numberText(value)}`).join(' · ') || '—'}</td>
              <td className={styles.right}>{momentText(run.createdAt, t)}</td>
            </tr>,
            open === run.id && <tr key={`${run.id}-detail`} className={styles.detailRow}><td colSpan={6}><RunDetail {...props} record={run} /></td></tr>,
          ]
        })}</tbody>
      </table></div>}
    {!all && matching.length > listed.length && <button type="button" className={styles.more} onClick={() => { setAll(true) }}>{t('boardShowAll', { n: matching.length })}</button>}
  </section>
}

/** One run opened in the list: what ran, what it reported, and its curves, read on demand. */
function RunDetail(props: BoardProps & { snapshot: BoardSnapshot; record: ExperimentRecord }): ReactNode {
  const { project, record: run, snapshot, t } = props
  const carried: Record<string, number>[] | undefined = snapshot.series[run.id]
  const [rows, setRows] = useState<Record<string, number>[]>(carried ?? [])
  useEffect(() => {
    if (carried !== undefined) { setRows(carried); return }
    let active = true
    props.board({ action: 'board-view', projectId: project.id, runs: [run.id] })
      .then((next) => { if (active) setRows(next.series[run.id] ?? []) }, () => {})
    return () => { active = false }
  }, [run.id, carried])
  const x = xKey(rows)
  const keys = watchedKeys(rows, x, DETAIL_FIELDS)
  return <div className={styles.detail}>
    {run.message !== '' && <p>{run.message}</p>}
    <p className={styles.muted}>{t('boardCommand')}</p>
    <code className={styles.command}>{run.spec.argv.join(' ')}</code>
    <MetricsGrid metrics={run.metrics} />
    {keys.length > 0 && <div className={styles.curves}>{keys.map(key => <div key={key}>
      <span className={styles.tileLabel}>{key}</span>
      <LineChart t={t} lines={[{ label: key, points: fieldPoints(rows, key, x) }]} name={key} xLabel={x} narrow />
    </div>)}</div>}
    <RunActions {...props} record={run} />
  </div>
}
