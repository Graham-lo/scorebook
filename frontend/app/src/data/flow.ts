// 一条记录走到哪儿了 —— 全站唯一的判断处。
//
// 五段：判断 → 走势 → 结果 → 复盘 → 打法。它是一条路，不是审批链：随手记的一条
// 可以跳过「结果」直接写复盘，观察期里也能先写一段阶段性的复盘。
//
// 所有依据都来自后端已有的公开接口，前端不另算分、不另定分母、不猜。哪一段该亮、
// 下一步是什么，只在这一个文件里决定；页面只负责把它画出来。
//
// 两个来源报的不是同一件事：复盘队列的一行报的是判分任务跑到哪一步，记录详情报
// 的是结果版本本身。两边各自折算成下面的 Answer，后面的规则就只有一套。

import type {
  AssessmentState,
  CallDetail,
  Instant,
  OutcomeState,
  QueueItem,
  ReviewDraftState,
  Uuid,
} from '../api/types'
import { relative } from './time'

export type StageId = 'record' | 'observe' | 'outcome' | 'review' | 'distill'

export interface Stage {
  id: StageId
  /** 术语表 §4 的段名。 */
  title: string
}

export const STAGES: Stage[] = [
  { id: 'record', title: '判断' },
  { id: 'observe', title: '走势' },
  { id: 'outcome', title: '结果' },
  { id: 'review', title: '复盘' },
  { id: 'distill', title: '打法' },
]

export type StepMark = 'done' | 'now' | 'todo' | 'skipped'

export type NextKind = 'observe' | 'result' | 'write' | 'continue' | 'recheck' | 'distill' | 'rest'

export interface NextStep {
  kind: NextKind
  /** 按钮上的话，写成一个动作。 */
  label: string
  /** 有的下一步只是「不用做什么」，那就没有按钮。 */
  href?: string
  iconName: string
}

export interface Flow {
  stage: StageId
  marks: Record<StageId, StepMark>
  /** 进度条的宽度，0–100。走到哪儿画到哪儿。 */
  percent: number
  next: NextStep
  /** 一句话说清现在的情况，列表行里用。 */
  summary: string
}

/**
 * 市场那一边的答案到没到。这是两个来源唯一需要对齐的东西。
 * `unknown` 是老老实实的「读不出来」，不是「没有」。
 */
export type Answer = 'waiting' | 'ready' | 'short' | 'attention' | 'none' | 'unknown'

/** 判断一条记录状态所需要的全部输入。 */
export interface FlowInput {
  id: Uuid
  /** 记录时写没写算对错的标准。null 表示这个来源读不到，就不下这个结论。 */
  hasCriteria: boolean | null
  answer: Answer
  /** 观察期什么时候结束，用来说“什么时候有答案”。 */
  dueAt: Instant | null
  /** 有没有写到一半的复盘。null 表示这次没去问——列表里不为一行草稿状态再发一次请求。 */
  hasDraft: boolean | null
  draftSavedAt: Instant | null
  hasReview: boolean
  reviewedAt: Instant | null
  /** 复盘发布之后结果又更新过：要提示重新核对，旧复盘不动。 */
  outcomeChangedSinceReview: boolean
  /** 关联过情境或打法版本。可选，不做不算没走完。 */
  distilled: boolean
  snoozedUntil: Instant | null
}

const ORDER: StageId[] = ['record', 'observe', 'outcome', 'review', 'distill']

function marksFor(stage: StageId, skip: StageId[]): Record<StageId, StepMark> {
  const at = ORDER.indexOf(stage)
  const out = {} as Record<StageId, StepMark>
  ORDER.forEach((id, i) => {
    if (skip.includes(id)) out[id] = 'skipped'
    else if (i < at) out[id] = 'done'
    else if (i === at) out[id] = 'now'
    else out[id] = 'todo'
  })
  return out
}

/** 进度条画到当前那个点上，最后一环走完才铺满。 */
function percentFor(stage: StageId): number {
  const at = ORDER.indexOf(stage)
  return Math.round((at / (ORDER.length - 1)) * 100)
}

export function flowOf(input: FlowInput): Flow {
  const skip: StageId[] = []
  // 明确知道没写标准，这一环节就是跳过的，不是没做完。读不到就不说。
  if (input.hasCriteria === false || input.answer === 'none') skip.push('outcome')

  let stage: StageId
  let next: NextStep
  let summary: string

  if (input.hasReview && input.outcomeChangedSinceReview) {
    // 结果版本变了。旧复盘一个字不动，只是请人再看一眼新的那版。
    stage = 'outcome'
    summary = '结果更新过'
    next = {
      kind: 'recheck',
      label: '看结果',
      href: `#/call/${input.id}`,
      iconName: 'info',
    }
  } else if (input.hasReview && !input.hasDraft) {
    stage = 'distill'
    summary = input.reviewedAt ? `${relative(input.reviewedAt)}写完复盘` : '复盘写完了'
    next = input.distilled
      ? {
          kind: 'rest',
          label: '',
          iconName: 'check',
        }
      : {
          kind: 'distill',
          label: '归到一类局面',
          href: `#/call/${input.id}`,
          iconName: 'play',
        }
  } else if (input.hasDraft === true) {
    stage = 'review'
    summary = input.draftSavedAt ? `复盘草稿 ${relative(input.draftSavedAt)}` : '复盘草稿'
    next = {
      kind: 'continue',
      label: '写复盘',
      href: `#/review/${input.id}`,
      iconName: 'review',
    }
  } else if (input.answer === 'none') {
    // 随手记的一条：没有标准可判，但随时可以直接写复盘。
    stage = 'review'
    summary = '没写怎么算对'
    next = {
      kind: 'write',
      label: '写复盘',
      href: `#/review/${input.id}`,
      iconName: 'review',
    }
  } else if (input.answer === 'attention') {
    stage = 'outcome'
    summary = '结果算不出来'
    next = {
      kind: 'result',
      label: '看结果',
      href: `#/call/${input.id}`,
      iconName: 'info',
    }
  } else if (input.answer === 'short') {
    stage = 'outcome'
    summary = '行情数据不够'
    next = {
      kind: 'result',
      label: '看结果',
      href: `#/call/${input.id}`,
      iconName: 'info',
    }
  } else if (input.answer === 'ready') {
    stage = 'outcome'
    summary = '市场的答案到了'
    next = {
      kind: 'write',
      label: '写复盘',
      href: `#/review/${input.id}`,
      iconName: 'review',
    }
  } else {
    // waiting，或者后端还没算过：都还在观察期这一环节里。
    stage = 'observe'
    summary = input.dueAt ? `${relative(input.dueAt)}出结果` : '还在等'
    next = {
      kind: 'observe',
      label: '看走势',
      href: `#/call/${input.id}`,
      iconName: 'wave',
    }
  }

  return { stage, marks: marksFor(stage, skip), percent: percentFor(stage), next, summary }
}

/** 判分任务的六个状态，折算成「答案到没到」。 */
function answerFromAssessments(states: AssessmentState[]): Answer {
  if (!states.length) return 'unknown'
  if (states.some((s) => s === 'awaiting_input' || s === 'needs_attention')) return 'attention'
  if (states.some((s) => s === 'queued' || s === 'running' || s === 'waiting_due')) return 'waiting'
  return 'ready'
}

/** 结果版本的状态，折算成同一件事。 */
function answerFromOutcomes(states: OutcomeState[]): Answer {
  if (!states.length) return 'unknown'
  if (states.every((s) => s === 'no_criteria')) return 'none'
  if (states.some((s) => s === 'pending')) return 'waiting'
  if (states.some((s) => s === 'realized' || s === 'unrealized' || s === 'not_triggered')) {
    return 'ready'
  }
  if (states.some((s) => s === 'insufficient_data')) return 'short'
  return 'unknown'
}

/**
 * 复盘队列的一行折算成流程输入。
 *
 * 队列行不带原始标准，也不带判分结果，所以这里只回答「算没算完」，
 * `hasCriteria` 老实写成 null——首页据此不会说「跳过了查看结果」，
 * 那句话要等详情页读到真的标准之后才说。
 */
export function fromQueueItem(item: QueueItem): FlowInput {
  const dues = item.assessments
    .map((a) => a.due_at)
    .filter((d): d is Instant => Boolean(d))
    .sort()
  return {
    id: item.id,
    hasCriteria: null,
    answer: answerFromAssessments(item.assessments.map((a) => a.state)),
    dueAt: dues[0] ?? null,
    hasDraft: item.draft_revision !== null && item.bucket === 'in_progress',
    draftSavedAt: item.draft_saved_at,
    hasReview: Boolean(item.latest_review_id),
    reviewedAt: item.reviewed_at,
    outcomeChangedSinceReview: Boolean(item.latest_review_id) && item.reason === 'new_outcome',
    // 队列里读不到打法关联，按「还没沉淀」处理，详情页会给出准确的一版。
    distilled: false,
    snoozedUntil: item.snoozed_until,
  }
}

/**
 * 记录详情折算成同一个形状。这里比队列那一版知道得更多：读得到原始标准、结果
 * 版本的编号、已发布复盘绑定的是哪一版结果，也读得到有没有接到打法上。唯一不
 * 知道的是有没有草稿——那要另外读一次 /v1/reviews/{id}/draft。
 *
 * 「复盘之后结果又更新了」按后端的口径判断：已发布的复盘会记下它当时看到的
 * 那几版结果，只要现在的当前版里有一版不在里面，就说明结果换过了。前端不重算
 * 任何结论，只做集合比较。
 */
export function fromCallDetail(
  d: CallDetail,
  draft: ReviewDraftState | null | undefined,
): FlowInput {
  const states = d.current_outcomes.map((o) => o.result.state)
  const latest = d.reviews.length ? d.reviews[d.reviews.length - 1] : null
  const seen = new Set(latest?.outcome_ids ?? [])
  const changed = Boolean(latest) && d.current_outcomes.some((o) => !seen.has(o.id))
  // 没绑过结果版本的旧复盘不当成「结果换过了」——那是不知道，不是变了。
  const knowable = Boolean(latest?.outcome_ids?.length)
  const ends = d.current_outcomes
    .filter((o) => o.result.state === 'pending')
    .map((o) => o.result.end_at)
    .filter((t): t is Instant => Boolean(t))
    .sort()
  const hasCriteria = d.body.criteria.length > 0
  const answer = hasCriteria ? answerFromOutcomes(states) : 'none'
  return {
    id: d.id,
    hasCriteria,
    answer,
    dueAt: ends[0] ?? null,
    // 记录详情本身不报有没有草稿（后端契约缺口，见 README）。调用方问过了就给
    // 结论，没问过传 undefined，这里如实记成「不知道」，不写成「没有」。
    hasDraft: draft === undefined ? null : Boolean(draft?.draft),
    draftSavedAt: draft?.draft?.updated_at ?? null,
    hasReview: d.reviews.length > 0,
    reviewedAt: latest?.created_at ?? null,
    outcomeChangedSinceReview: knowable && changed,
    distilled: d.adoptions.length > 0 || d.episode_links.some((l) => l.status !== 'rejected'),
    snoozedUntil: null,
  }
}
