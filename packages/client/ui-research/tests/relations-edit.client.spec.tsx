// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { RelationMergeSuggestionView, ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { RelationsView } from '../src/client/RelationsView.tsx'
import { zh } from '../src/client/locales.ts'
import { anyId, harness, record, t, type Handlers } from './fixtures/relations.tsx'

afterEach(cleanup)
async function settle(): Promise<void> { await act(async () => { for (let at = 0; at < 8; at++) await Promise.resolve() }) }
type Options = Parameters<typeof harness>[1]
async function mount(handlers: Partial<Handlers> = {}, options: Options = {}) {
  const h = harness(handlers, options)
  const view = render(<RelationsView {...h.props} />)
  await settle()
  return { ...h, view }
}
type View = ReturnType<typeof render>
const card = (view: View, hook: string): HTMLElement => view.container.querySelector(`[${hook}]`) as HTMLElement
const asked = (commands: readonly ResearchCommand[], action: ResearchCommand['action']): ResearchCommand[] => commands.filter(command => command.action === action)
const field = (form: HTMLElement, end: string, what: string): HTMLInputElement | HTMLSelectElement =>
  within(form).getByLabelText(`${end} · ${what}`) as HTMLInputElement | HTMLSelectElement

/** Fill the whole form: a new method, an existing task, the literature record and a sentence. */
function fill(form: HTMLElement, quote = 'Our method applies block-sparse attention to long documents.'): void {
  fireEvent.change(within(form).getByLabelText(zh.relationsFormKind), { target: { value: 'applied-to' } })
  fireEvent.change(field(form, zh.relationsFrom, zh.relationsFormName), { target: { value: 'Sliding window' } })
  fireEvent.change(field(form, zh.relationsTo, zh.relationsFormName), { target: { value: '长上下文建模' } })
  fireEvent.change(within(form).getByLabelText(zh.relationsFormSource), { target: { value: 'e-lf' } })
  fireEvent.change(within(form).getByLabelText(zh.relationsFormQuote), { target: { value: quote } })
}
const submit = (form: HTMLElement): HTMLButtonElement => within(form).getByRole('button', { name: zh.relationsFormSubmit }) as HTMLButtonElement

it('records the person\'s relation with a quotation of a source at its current revision, creating the entity it names', async () => {
  const { view, commands } = await mount()
  const form = card(view, 'data-relations-propose') as HTMLDetailsElement
  expect(form.open).toBe(false)
  fireEvent.click(form.querySelector('summary') as HTMLElement)
  expect(within(form).getByText(zh.relationsProposeHint)).toBeTruthy()
  expect(submit(form).disabled).toBe(true)
  const source = within(form).getByLabelText(zh.relationsFormSource) as HTMLSelectElement
  expect([...source.options].map(option => option.textContent)).toEqual([
    zh.relationsFormSourceNone, 'Longformer: The Long-Document Transformer · Literature · 第 2 版'.replace('Literature', zh.egKindLiterature),
    `notes.md · ${zh.egKindFile} · 第 5 版`,
  ])
  fill(form)
  expect(submit(form).disabled).toBe(false)
  const before = asked(commands, 'relations-graph').length
  fireEvent.click(submit(form)); await settle()
  expect(asked(commands, 'relations-propose')).toEqual([{
    action: 'relations-propose', projectId: anyId,
    proposals: [{
      kind: 'applied-to', from: { kind: 'method', name: 'Sliding window' }, to: { id: 'context' },
      ground: { type: 'quote', evidenceId: 'e-lf', revision: 2, quote: 'Our method applies block-sparse attention to long documents.' },
    }],
  }])
  expect(within(form).getByRole('status').textContent).toBe(zh.relationsAdded)
  expect(within(form).getByLabelText<HTMLTextAreaElement>(zh.relationsFormQuote).value).toBe('')
  expect(asked(commands, 'relations-graph').length).toBe(before + 1)
})

it('keeps the form\'s open state in step with the details element', async () => {
  const { view } = await mount()
  const form = card(view, 'data-relations-propose') as HTMLDetailsElement
  form.open = true
  fireEvent(form, new Event('toggle'))
  expect(form.open).toBe(true)
  form.open = false
  fireEvent(form, new Event('toggle'))
  expect(form.open).toBe(false)
})

it('names a paper by the title of a literature record, and refuses a paper that was never imported before asking the host', async () => {
  const { view, commands } = await mount()
  const form = card(view, 'data-relations-propose')
  fireEvent.click(form.querySelector('summary') as HTMLElement)
  fill(form)
  fireEvent.change(field(form, zh.relationsFrom, zh.relationsFormType), { target: { value: 'paper' } })
  fireEvent.change(field(form, zh.relationsFrom, zh.relationsFormName), { target: { value: 'An unimported paper' } })
  fireEvent.click(submit(form))
  expect(within(form).getByRole('alert').textContent).toBe(t('relationsPaperUnknown', { name: 'An unimported paper' }))
  expect(asked(commands, 'relations-propose')).toHaveLength(0)
  fireEvent.change(field(form, zh.relationsFrom, zh.relationsFormName), { target: { value: 'Longformer: The Long-Document Transformer' } })
  fireEvent.change(field(form, zh.relationsTo, zh.relationsFormType), { target: { value: 'paper' } })
  fireEvent.change(field(form, zh.relationsTo, zh.relationsFormName), { target: { value: 'Another paper' } })
  fireEvent.click(submit(form))
  expect(within(form).getByRole('alert').textContent).toBe(t('relationsPaperUnknown', { name: 'Another paper' }))
  fireEvent.change(field(form, zh.relationsTo, zh.relationsFormName), { target: { value: 'e-lf' } })
  fireEvent.click(submit(form)); await settle()
  expect(asked(commands, 'relations-propose')[0]).toMatchObject({
    proposals: [{ from: { kind: 'paper', evidenceId: 'e-lf' }, to: { kind: 'paper', evidenceId: 'e-lf' } }],
  })
  expect(within(form).queryByRole('alert')).toBeNull()
})

it('shows the host\'s message when it refuses a quotation, and says what else came with an accepted one', async () => {
  const refusal = 'The quotation departs from the source after "block-sparse"; quote the sentence word for word.'
  const refusing = await mount({ propose: () => ({ message: 'Refused', relationOutcomes: [{ status: 'refused', code: 'quote-not-found', message: refusal }] }) })
  let form = card(refusing.view, 'data-relations-propose')
  fireEvent.click(form.querySelector('summary') as HTMLElement)
  fill(form)
  fireEvent.click(submit(form)); await settle()
  expect(within(form).getByRole('alert').textContent).toBe(t('relationsRefused', { message: refusal }))
  // What was typed stays for the person to correct.
  expect(within(form).getByLabelText<HTMLTextAreaElement>(zh.relationsFormQuote).value).toContain('block-sparse')
  refusing.view.unmount()

  const busy = await mount({
    propose: () => ({
      message: 'Proposed',
      relationOutcomes: [{ status: 'added', relation: 'r', ground: 'g', created: ['sliding-window'], locatorCorrected: true, warnings: ['The quotation is short.'], restored: true }],
    }),
  })
  form = card(busy.view, 'data-relations-propose')
  fireEvent.click(form.querySelector('summary') as HTMLElement)
  fill(form)
  fireEvent.click(submit(form)); await settle()
  expect(within(form).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    zh.relationsAdded, zh.relationsLocatorFixed, zh.relationsWasRejected, '新建的实体：1 个', 'The quotation is short.',
  ])
})

it('says when the host recorded nothing, answered nothing or failed', async () => {
  for (const [handler, text] of [
    [() => ({ message: 'Proposed', relationOutcomes: [{ status: 'unchanged', relation: 'r', ground: 'g', created: [], locatorCorrected: false, warnings: [], restored: false }] }), zh.relationsAlready],
    [() => ({ message: 'Proposed', relationOutcomes: [{ status: 'regrounded', relation: 'r', ground: 'g', created: [], locatorCorrected: false, warnings: [], restored: false }] }), zh.relationsMoved],
    [() => ({ message: 'Proposed' }), zh.kgNoResponse],
    [() => { throw new Error('Relation graph plugin is disabled.') }, 'Relation graph plugin is disabled.'],
  ] as [() => ResearchResponse, string][]) {
    const { view } = await mount({ propose: handler })
    const form = card(view, 'data-relations-propose')
    fireEvent.click(form.querySelector('summary') as HTMLElement)
    fill(form)
    fireEvent.click(submit(form)); await settle()
    expect(form.textContent).toContain(text)
    view.unmount()
  }
})

it('has nothing to fill in until the research holds a source, and changes nothing in an example', async () => {
  const bare = await mount({}, { evidence: [record('e-run', { kind: 'experiment' })] })
  const form = card(bare.view, 'data-relations-propose')
  fireEvent.click(form.querySelector('summary') as HTMLElement)
  expect(within(form).getByText(zh.relationsFormNoSource)).toBeTruthy()
  expect(form.querySelector('form')).toBeNull()
  bare.view.unmount()
  const example = await mount({}, { example: true })
  const frozen = card(example.view, 'data-relations-propose')
  fireEvent.click(frozen.querySelector('summary') as HTMLElement)
  expect(within(frozen).getByLabelText<HTMLSelectElement>(zh.relationsFormKind).disabled).toBe(true)
  expect(within(frozen).getByLabelText<HTMLTextAreaElement>(zh.relationsFormQuote).disabled).toBe(true)
  expect(within(frozen).getByLabelText<HTMLSelectElement>(zh.relationsFormSource).disabled).toBe(true)
  expect(submit(frozen).disabled).toBe(true)
  expect(submit(frozen).getAttribute('title')).toBe(zh.relationsExampleReadOnly)
})

it('starts from a relation kind a quotation can ground, never from a citation', async () => {
  const { view } = await mount()
  fireEvent.click(view.getByRole('button', { name: new RegExp(`^${t('relationsEdgeLabel', { from: 'BigBird', kind: '引用', to: 'Longformer' })}`) }))
  fireEvent.click(within(card(view, 'data-relations-selected')).getByRole('button', { name: zh.relationsAddOne }))
  const form = card(view, 'data-relations-propose')
  expect(within(form).getByLabelText<HTMLSelectElement>(zh.relationsFormKind).value).toBe('applied-to')
  expect([...within(form).getByLabelText<HTMLSelectElement>(zh.relationsFormKind).options].map(option => option.value)).not.toContain('cites')
})

const SUGGESTION: RelationMergeSuggestionView = { a: 'moe', b: 'mixture-of-experts', reason: 'acronym', names: ['MoE', 'Mixture of experts'] }
const SPELLING: RelationMergeSuggestionView = { a: 'sparse-attention', b: 'sparse-attentoin', reason: 'spelling', names: ['sparse attention', 'sparse attentoin'] }

it('lists entities that may be one and merges them only after saying that it cannot be undone and asking which name stays', async () => {
  let left: RelationMergeSuggestionView[] = [SUGGESTION, SPELLING]
  const { view, commands } = await mount({
    suggestions: () => ({ message: 'Suggestions', relationSuggestions: left }),
    merge: (request) => {
      left = left.filter(item => ![item.a, item.b].includes(request.from))
      return { message: 'Merged', relationMerge: { status: 'merged', entity: { id: request.into, kind: 'method', name: 'Mixture of experts', aliases: ['MoE'] }, dropped: request.from === 'moe' ? ['r1', 'r2'] : [] } }
    },
  })
  const suggestions = card(view, 'data-relations-suggestions')
  expect(within(suggestions).getByRole('heading', { name: zh.relationsSuggestHead })).toBeTruthy()
  expect(within(suggestions).getByText('MoE / Mixture of experts')).toBeTruthy()
  expect(within(suggestions).getByText(zh.relationsSuggestAcronym)).toBeTruthy()
  expect(within(suggestions).getByText(zh.relationsSuggestSpelling)).toBeTruthy()
  expect(asked(commands, 'relations-merge')).toHaveLength(0)
  fireEvent.click(within(suggestions).getAllByRole('button', { name: zh.relationsMerge })[0] as HTMLElement)
  expect(within(suggestions).getByText(zh.relationsMergeConfirm)).toBeTruthy()
  fireEvent.click(within(suggestions).getByRole('button', { name: zh.cancel }))
  expect(within(suggestions).queryByText(zh.relationsMergeConfirm)).toBeNull()
  fireEvent.click(within(suggestions).getAllByRole('button', { name: zh.relationsMerge })[0] as HTMLElement)
  fireEvent.click(within(suggestions).getByRole('button', { name: t('relationsMergeKeep', { name: 'Mixture of experts' }) })); await settle()
  expect(asked(commands, 'relations-merge')).toEqual([{ action: 'relations-merge', projectId: anyId, from: 'moe', into: 'mixture-of-experts' }])
  expect(within(suggestions).getByRole('status').textContent).toBe(`${zh.relationsMerged} ${t('relationsMergedDropped', { n: 2 })}`)
  expect(within(suggestions).queryByText('MoE / Mixture of experts')).toBeNull()
  // The other pair is merged the other way round.
  fireEvent.click(within(suggestions).getByRole('button', { name: zh.relationsMerge }))
  fireEvent.click(within(suggestions).getByRole('button', { name: t('relationsMergeKeep', { name: 'sparse attention' }) })); await settle()
  expect(asked(commands, 'relations-merge').at(-1)).toMatchObject({ from: 'sparse-attentoin', into: 'sparse-attention' })
  expect(within(suggestions).getByRole('status').textContent).toBe(zh.relationsMerged)
})

it('shows nothing when nothing looks alike, and says why a merge or a read of suggestions failed', async () => {
  const quiet = await mount()
  expect(quiet.view.container.querySelector('[data-relations-suggestions]')).toBeNull()
  quiet.view.unmount()
  const failing = await mount({ suggestions: () => { throw new Error('Plugin disabled') } })
  expect(within(card(failing.view, 'data-relations-suggestions')).getByRole('alert').textContent).toContain('Plugin disabled')
  failing.view.unmount()
  const empty = await mount({ suggestions: () => ({ message: 'Suggestions' }) })
  expect(within(card(empty.view, 'data-relations-suggestions')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
  empty.view.unmount()

  const refusing = await mount({
    suggestions: () => ({ message: 'Suggestions', relationSuggestions: [SUGGESTION] }),
    merge: () => ({ message: 'Refused', relationMerge: { status: 'refused', code: 'different-kinds', message: 'Entities of two kinds cannot be merged.' } }),
  })
  const merge = async (view: View, keep: string): Promise<void> => {
    const suggestions = card(view, 'data-relations-suggestions')
    fireEvent.click(within(suggestions).getByRole('button', { name: zh.relationsMerge }))
    fireEvent.click(within(suggestions).getByRole('button', { name: t('relationsMergeKeep', { name: keep }) })); await settle()
  }
  await merge(refusing.view, 'MoE')
  expect(within(card(refusing.view, 'data-relations-suggestions')).getByRole('alert').textContent).toBe(t('relationsRefused', { message: 'Entities of two kinds cannot be merged.' }))
  refusing.view.unmount()
  const none = await mount({ suggestions: () => ({ message: 'Suggestions', relationSuggestions: [SUGGESTION] }), merge: () => ({ message: 'Merged' }) })
  await merge(none.view, 'MoE')
  expect(within(card(none.view, 'data-relations-suggestions')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
  none.view.unmount()
  const example = await mount({ suggestions: () => ({ message: 'Suggestions', relationSuggestions: [SUGGESTION] }) }, { example: true })
  const button = within(card(example.view, 'data-relations-suggestions')).getByRole('button', { name: zh.relationsMerge }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('title')).toBe(zh.relationsExampleReadOnly)
})

it('drops a suggestion list that a later read has overtaken', async () => {
  const slow = Promise.withResolvers<ResearchResponse>()
  const failing = Promise.withResolvers<ResearchResponse>()
  const queue = [slow, failing]
  const h = harness({ suggestions: () => (queue.shift() as typeof slow).promise })
  const view = render(<RelationsView {...h.props} />)
  await settle()
  view.rerender(<RelationsView {...h.props} project={{ ...h.props.project, revision: 9 }} />)
  await settle()
  failing.resolve({ message: 'Suggestions', relationSuggestions: [] }); await settle()
  slow.resolve({ message: 'Suggestions', relationSuggestions: [SUGGESTION] }); await settle()
  expect(view.container.querySelector('[data-relations-suggestions]')).toBeNull()
  const lateFailure = Promise.withResolvers<ResearchResponse>()
  const later = Promise.withResolvers<ResearchResponse>()
  const pair = [lateFailure, later]
  const other = harness({ suggestions: () => (pair.shift() as typeof lateFailure).promise })
  const second = render(<RelationsView {...other.props} />)
  await settle()
  second.rerender(<RelationsView {...other.props} project={{ ...other.props.project, revision: 9 }} />)
  await settle()
  later.resolve({ message: 'Suggestions', relationSuggestions: [] }); await settle()
  lateFailure.reject(new Error('Overtaken failure')); await settle()
  expect(second.queryByText(/Overtaken failure/)).toBeNull()
})

it('fetches the reference lists as a job, shows that it is waiting and then what it recorded and what failed', async () => {
  const job = Promise.withResolvers<ResearchResponse>()
  const { view, commands } = await mount({ citations: () => job.promise })
  const citations = card(view, 'data-relations-citations')
  expect(within(citations).getByText(zh.relationsCitationsHint)).toBeTruthy()
  const before = asked(commands, 'relations-graph').length
  fireEvent.click(within(citations).getByRole('button', { name: zh.relationsCitations }))
  await settle()
  expect(within(citations).getByRole('status').textContent).toBe(zh.relationsCitationsPending)
  expect(within(citations).getByRole<HTMLButtonElement>('button', { name: zh.relationsCitations }).disabled).toBe(true)
  job.resolve({ message: 'Citations', relationCitations: { asked: 3, works: 2, added: 4, unchanged: 1, rejected: 1, failures: ['OpenAlex answered 429 for W1', 'Crossref timed out'] } }); await settle()
  expect(asked(commands, 'relations-citations')).toEqual([{ action: 'relations-citations', projectId: anyId }])
  const done = within(citations).getByRole('status')
  expect(done.textContent).toContain(t('relationsCitationsDone', { asked: 3, works: 2, added: 4, unchanged: 1, rejected: 1 }))
  expect(within(done).getByText(t('relationsCitationsFailed', { n: 2 }))).toBeTruthy()
  expect(within(done).getAllByRole('listitem').map(item => item.textContent)).toEqual(['OpenAlex answered 429 for W1', 'Crossref timed out'])
  expect(asked(commands, 'relations-graph').length).toBe(before + 1)
})

it('says what the citation lists gave when nothing failed, and when the job failed or answered nothing', async () => {
  const clean = await mount()
  fireEvent.click(within(card(clean.view, 'data-relations-citations')).getByRole('button', { name: zh.relationsCitations })); await settle()
  expect(within(card(clean.view, 'data-relations-citations')).queryByText(/个请求失败/)).toBeNull()
  expect(within(card(clean.view, 'data-relations-citations')).getByRole('status').textContent).toBe(t('relationsCitationsDone', { asked: 3, works: 3, added: 2, unchanged: 1, rejected: 0 }))
  clean.view.unmount()
  const failing = await mount({ citations: () => { throw new Error('The job was cancelled') } })
  fireEvent.click(within(card(failing.view, 'data-relations-citations')).getByRole('button', { name: zh.relationsCitations })); await settle()
  expect(within(card(failing.view, 'data-relations-citations')).getByRole('alert').textContent).toContain('The job was cancelled')
  failing.view.unmount()
  const empty = await mount({ citations: () => ({ message: 'Citations' }) })
  fireEvent.click(within(card(empty.view, 'data-relations-citations')).getByRole('button', { name: zh.relationsCitations })); await settle()
  expect(within(card(empty.view, 'data-relations-citations')).getByRole('alert').textContent).toContain(zh.kgNoResponse)
})
