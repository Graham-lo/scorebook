// The backend returns an internal identifier in both `code` and `message`.
// Traders never see those. Every code is translated here into a sentence that
// says what happened and what can be done next; unknown codes fall back to a
// neutral sentence rather than leaking the identifier.

/**
 * The server's own hint about whether resending helps. `never` means the
 * request was refused on its merits and repeating it changes nothing;
 * `after`/`at` carry a time; `await_capability` and `await_input` mean the
 * wait is on something else entirely, so no automatic retry loop should run.
 */
export type RetryHint =
  | { kind: 'never' }
  | { kind: 'backoff' }
  | { kind: 'after'; value: number }
  | { kind: 'at'; value: string }
  | { kind: 'await_capability' }
  | { kind: 'await_input' }

export interface WireError {
  code: string
  message: string
  field: string | null
  retryable: boolean
  retry?: RetryHint
  request_id: string
}

const TEXT: Record<string, string> = {
  unauthorized: '这台机器的开发凭证没有通过，先确认后端服务在运行。',
  origin_not_allowed: '本机后端不接受从这个地址打开的页面。按启动说明里的地址打开，或让它认下这个地址再重启。',
  read_only_token: '现在这台机器只能看，不能写。',
  not_found: '找不到这条内容，可能已经被删除。',
  revision_conflict: '这条记录刚刚被改过，请重新读取后再提交。',
  already_exists: '这条内容已经存在。',
  empty_call: '至少要写一句话或者放一张图。',
  input_too_large: '内容太长了，请精简后再保存。',
  invalid_path_or_stance: '方向的取值不合法。',
  invalid_confidence: '把握程度要在 0 到 100 之间。',
  invalid_market: '只支持币安 USDⓈ-M 与 COIN-M 合约。',
  invalid_attachment_reference: '这张图不在，或者它只是用来搜索的图，不能当成记录里的截图。',
  invalid_attachment_kind: '这张图的用途填得不对。',
  future_capture_time: '截图时间不能晚于现在。',
  unknown_rule_version: '标准版本和后端不一致，刷新一下页面。',
  idempotency_key_required: '这次提交少了一个标记，重试一次就好。',
  invalid_multipart: '这次上传的内容读不出来，换一张图再试。',
  invalid_upload: '图片读取失败，请重试。',
  file_required: '请先选择一张图片。',
  image_decode_failed: '这张图解不开，请确认是 PNG、JPEG 或 WebP。',
  unknown_model: '这种比法现在用不了。',
  visual_model_not_configured: '本机的视觉模型没有启动。可以改成按走势形状比，或者先把它开起来。',
  unsupported_interval: '这个 K 线周期暂不支持。',
  invalid_contract: '合约代码不合法，请从合约目录里选。',
  invalid_models: '选的比法不对。',
  'history_request_exceeds_bounded_range;max_50000_bars_1000_windows':
    '一次只能准备有限的范围：最多 5 万条源 K 线、1000 个窗口。请把时间段改小，或者放大步长。',
  not_a_search_result: '这条不在本次检索结果里。',
  incompatible_episode: '这条记录和那段行情的品种不是同一个。',
  invalid_link_status: '这条记录和那段行情的关系写得不对。',
  invalid_review_action: '复盘里那一项选得不对。',
  invalid_review_draft: '这次复盘草稿的内容存不下来，改短一点再试。',
  review_action_required: '发布之前先选一下这次和上次的关系。',
  review_content_required_or_too_large: '「这次看到了什么」和「下次怎么做」至少写一项，也不要写得太长。',
  draft_revision_conflict: '这条复盘已在另一处更新。你写的内容都还在，看一下两边的差别再决定留哪份。',
  review_outcomes_changed: '这条记录刚有了新的结果。文字都留着，看过新结果之后再确认发布。',
  review_preference_conflict: '这条记录的提醒刚被改过，重新读一下再设。',
  invalid_review_reminder_time: '提醒时间要在将来，且不超过一年。',
  invalid_review_bucket: '这个分组不存在，回到「待复盘」再看。',
  invalid_history_kind: '这类历史读不出来，刷新一下页面。',
  playbook_details_required: '做法要写清楚名字和改了什么。',
  invalid_tag: '标签的名字不能这么写。',
  reason_required: '请写一句原因。',
  invalid_cursor: '翻页的位置过期了，重新搜一次。',
  adapter_unavailable: '行情或模型服务暂时连不上，请稍后重试。',
  database_error: '本机后端存数据时出了问题，稍后再试一次。',
  storage_error: '本机后端存图片时出了问题，稍后再试一次。',
  export_not_ready: '导出还没做完。',
  lease_lost: '这项准备工作换了一次手，刷新一下看最新进度。',
  contract_market_required: '只能在币安 USDⓈ-M 或 COIN-M 合约上取行情。',
  interactive_market_limit_2000_bars: '这个时间段太长了，一次最多看 2000 根 K 线，请缩短范围或换大周期。',
  chart_requires_1_to_2000_bars: '这段时间里没有足够的 K 线可以画图。',
  invalid_chart_price: '行情数据里的价格不正常，画不出图。',
  invalid_ohlc: '行情数据自相矛盾，画不出图。',
  invalid_bars: '行情数据读不出来。',
  chart_render_failed: '这张图没有画出来，请重试。',
  invalid_provider_bars: '行情源返回的数据读不出来。',
  invalid_region: '框超出这张图了，重新框一次。',
  hybrid_requires_both_models: '两种一起比需要视觉模型在运行。先把它开起来，或者只按走势形状比。',
  image_queue_busy: '图片处理正在排队，请稍等一下再试。',
  vision_stopped: '视觉模型服务中断了，请确认它还在运行。',
  invalid_model_response: '视觉模型返回的结果不正常，请重试。',
  image_processing_failed: '这张图处理失败了，请换一张试试。',
  image_batch_too_large: '一次处理的图片太多了。',
  unknown_embedding_model: '这种比法现在用不了。',
  shared_index_build_in_progress: '同样的范围正在准备中，稍等一会儿再看。',
  invalid_feature_block: '准备这段历史时出了问题，重新发起一次。',
  feature_block_too_large: '这一批数据太大了，请把范围改小。',
  invalid_job: '这项准备工作的内容不完整。',
  invalid_search_result: '这次搜索的结果读不出来，再搜一次。',
  invalid_request: '这次请求本身有问题，换个填法再试。',
  // 后台任务：暂停、继续、重试
  job_generation_conflict: '这项任务刚被别处动过，刷新一下再操作。',
  job_not_retryable_in_current_state: '这项任务现在不能重试，先看它停在哪一步。',
  job_identity_conflict: '这项任务和请求对不上，刷新一下页面。',
  unknown_job_kind: '这类任务本机后端不认识。',
  not_due: '还没到时间，等一会儿再看。',
  // 准备大范围历史
  invalid_history_plan: '这份准备范围填得不对：品种、周期、时间或每段长度有一项超出了允许的范围。',
  history_plan_range_too_short: '这段时间比一段的长度还短，先把结束时间往后放。',
  history_plan_paused: '这段历史的准备已经暂停，继续之后才会往下走。',
  history_child_requires_attention: '这段历史里有一小段没准备成功，处理完才能接着往下。',
  history_chunk_in_progress: '正在准备其中一段，稍等一会儿。',
  history_capacity_budget_exceeded: '一次要准备的量超出了本机的上限，把范围改小一些。',
  invalid_plan_action: '这个操作不合法。',
  plan_revision_conflict: '这份准备计划刚被改过，刷新一下再操作。',
  plan_state_conflict: '它现在的状态做不了这个操作。',
  plan_state_changed: '它的状态刚变过，刷新一下再看。',
  too_many_symbols: '一次选的品种太多了。',
  market_range_too_large: '这个时间段太长了，分几次准备。',
  market_not_supported: '这个市场暂不支持。',
  invalid_symbol: '合约代码不合法。',
  instrument_required: '先选一个合约。',
  invalid_date: '日期填得不对。',
  // 导出
  export_in_progress: '上一次导出还在进行，等它结束再来。',
  export_expired_create_new_export: '这份导出已经过期，重新导一次。',
  export_lease_lost: '这次导出换了一次手，刷新一下看最新进度。',
  export_integrity_failure: '导出的文件对不上校验，重新导一次。',
  export_serialization_failed: '导出时有一份内容写不出来，重新导一次。',
  export_destination_exists: '导出的目标已经存在。',
  export_destination_identity_mismatch: '导出的目标不是这一次的，重新导一次。',
  // 图片与识图
  image_too_large: '这张图太大了，换一张小一点的。',
  invalid_image: '这张图读不出来。',
  unsupported_image: '只支持 PNG、JPEG 和 WebP。',
  invalid_or_oversize_image: '这张图读不出来或者太大了。',
  upload_expired: '这张图等太久了，重新传一次。',
  invalid_capture_time: '截图时间填得不对。',
  chart_region_too_small: '框得太小了，框大一点再搜。',
  chart_too_complex_select_region: '这张图内容太多，框出你要比的那一块再搜。',
  chart_obstructed_or_unsupported: '这张图里的 K 线被挡住了，或者不是常见的画法。换一张干净的截图。',
  chart_analysis_interrupted: '这张图看到一半中断了，重试一次。',
  structure_not_detected: '这张图里没认出 K 线结构。',
  flat_chart_geometry: '这张图里的 K 线几乎没有起伏，比不出结构。',
  nonstandard_candles_not_supported: '这张图的 K 线画法不常见，暂时认不出来。',
  ocr_not_configured: '本机没有开识字服务。',
  ocr_failed: '这张图上的字没认出来。',
  // 更正与结果
  outcome_head_conflict: '这条结果刚被重算过，刷新一下再提交。',
  revision_head_required: '要先指明改的是哪一条结果。',
  revision_reason_required: '请写一句为什么要改。',
  conflicting_related_call: '关联的记录填得不对。',
  invalid_evidence_reference: '引用的图不在这条记录里。',
  idempotency_content_conflict: '同一个标记下换了内容，换个新的再提交。',
  invalid_idempotency_key: '这次提交的标记不合法，重试一次。',
}

/** Turns a backend code into a sentence; used for job failures too. */
export function explain(code: string | null | undefined): string {
  if (!code) return ''
  return TEXT[code] ?? '这一步没有成功，请稍后重试。'
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly field: string | null
  readonly retryable: boolean
  readonly retry: RetryHint | null
  readonly requestId: string | null

  constructor(status: number, wire: Partial<WireError> & { code: string }) {
    super(TEXT[wire.code] ?? fallback(status))
    this.name = 'ApiError'
    this.status = status
    this.code = wire.code
    this.field = wire.field ?? null
    this.retryable = wire.retryable ?? status >= 500
    this.retry = wire.retry ?? null
    this.requestId = wire.request_id ?? null
  }

  get isConflict(): boolean {
    return this.status === 409
  }

  /** True when the same request, with the same idempotency key, is worth resending. */
  get canRetry(): boolean {
    if (this.retry) return this.retry.kind === 'backoff' || this.retry.kind === 'after' || this.retry.kind === 'at'
    return this.retryable || this.status === 502 || this.status === 503 || this.status === 504
  }

  /** Milliseconds the server asked us to wait, when it named one. */
  get retryAfterMs(): number | null {
    if (this.retry?.kind === 'after') return this.retry.value * 1000
    if (this.retry?.kind === 'at') return Math.max(0, Date.parse(this.retry.value) - Date.now())
    return null
  }
}

function fallback(status: number): string {
  if (status === 0) return '连不上本机后端服务，请确认它还在运行。'
  if (status === 404) return '找不到这条内容。'
  if (status === 409) return '内容刚刚被改过，请重新读取。'
  if (status >= 500) return '后端暂时出了问题，请稍后重试。'
  return '这次请求没有被接受。'
}

export class NetworkError extends ApiError {
  constructor(cause?: unknown) {
    super(0, { code: 'network_unreachable', retryable: true })
    this.name = 'NetworkError'
    if (cause instanceof Error) this.stack = cause.stack
  }
}
