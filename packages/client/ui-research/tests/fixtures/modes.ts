/** Installed modes as a snapshot carries them: the general mode and a pack with routes, phases and a checkpoint. */
import type { ModeSummary } from '@deepseek-ai/dsh-research-workbench/types'

export const MODES: ModeSummary[] = [
  {
    id: 'general', order: 0, name: { en: 'General', zh: '通用' }, summary: { en: 'Every tool, no pipeline', zh: '全部工具，不走流水线' },
    preload: [], routes: [], phases: [],
  },
  {
    id: 'spark-to-paper', order: 10, name: { en: 'spark-to-paper', zh: 'spark-to-paper' },
    summary: { en: 'An idea in, a paper out', zh: '想法进，论文出' }, entry: 'ts-paper', preload: [],
    routes: [
      { id: 'proposal', name: { en: 'From a proposal', zh: '从提案开始' }, summary: { en: 'Results stay "--"', zh: '结果先留空' } },
      { id: 'data', name: { en: 'From measured results', zh: '从实测结果开始' }, summary: { en: 'Numbers trace to data', zh: '数字追溯到数据' } },
    ],
    defaultRoute: 'proposal',
    phases: [
      { id: 'data', label: { en: 'Data', zh: '数据' }, routes: ['data'], checkpoint: false, skills: [] },
      { id: 'plan', label: { en: 'Plan', zh: '规划' }, checkpoint: false, skills: ['paper-plan'] },
      { id: 'cite', label: { en: 'Citations', zh: '引用' }, checkpoint: false, skills: [] },
      { id: 'experiments', label: { en: 'Experiments', zh: '实验' }, routes: ['proposal'], checkpoint: true, skills: [] },
    ],
  },
]
