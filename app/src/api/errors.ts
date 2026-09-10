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
  replay_needs_instrument: '这条记录没写品种，取不到它那一段行情。',
  replay_interval_unsupported: '这条记录的周期没有对应的行情周期，取不到它那一段行情。',
  invalid_contract: '合约代码不合法，请从合约目录里选。',
  invalid_models: '选的比法不对。',
  'history_request_exceeds_bounded_range;max_50000_bars_1000_windows':
    '一次只能准备有限的范围：最多 5 万条源 K 线、1000 个窗口。请把时间段改小，或者放大步长。',
  not_a_search_result: '这条不在本次检索结果里。',
  incompatible_episode: '这条记录和那段行情的品种不是同一个。',
  invalid_link_status: '这条记录和那段行情的关系写得不对。',
  invalid_review_trade: '仓位信息格式不正确，请检查方向和保证金模式。',
  invalid_review_trade_number: '仓位数量、价格和杠杆应填写大于零的数字，盈亏可为负数。',
  review_trade_time_order: '平仓时间不能早于开仓时间。',
  review_trade_details_required: '请补齐手动仓位的品种、方向、开仓时间、数量和单位。',
  review_trade_position_unavailable: '所选历史仓位不可用，请重新查找并选择。',
  too_many_review_trades: '一条复盘最多添加 20 笔仓位。',
  invalid_cycle_filter: '仓位筛选条件不正确，请检查时间范围。',
  invalid_review_images: '一条复盘最多 20 张截图，请勿重复添加。',
  review_supplement_required: '这张复盘截图不可用，请重新上传。',
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
  chart_interval_required: '请先确认截图的 K 线周期；搜索只比较同周期。',
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
  invalid_instrument_query: '合约代码太长了，请缩短后再搜。',
  instrument_ranking_changed: '热门品种的排序更新了，请重新打开列表。',
  invalid_match_boundary: '匹配片段的时间范围不正确，请重新搜索。',
  match_boundary_not_in_chart: '这段行情没有覆盖匹配结束的位置，暂时画不出分界线。',
  chart_followthrough_has_gaps: '这段历史行情有缺口，暂时无法连续展示后续走势。',
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

  // ——— v4：真实成交、导入与对账 ———
  invalid_exchange_connection: '这个账户的名字、标签或市场填得不对。',
  connection_revision_conflict: '这个账户的设置刚被改过，重新读一下再操作。',
  invalid_connection_action: '这个操作对这个账户不适用。',
  owner_scoped_exchange_keychain_reference_required:
    '只能填本机 Keychain 里的引用，密钥本身不经过这里。',
  invalid_keychain_reference: '这个 Keychain 引用不合法，密钥本身不要填进来。',
  invalid_exchange_credentials: '本机存的这把只读密钥没有通过交易所验证，重新放一次。',
  invalid_trade_import_bounds: '这次导入的时间范围填得不对。',
  invalid_trade_range: '开始时间要早于结束时间。',
  invalid_trade_payload: '这批成交里有读不出来的内容。',
  invalid_import_row: '这批数据里有一行读不出来。',
  invalid_trade_id: '成交编号不合法。',
  invalid_trade_price: '成交价读不出来。',
  invalid_trade_amount: '数量或金额读不出来。',
  invalid_trade_asset: '币种填得不对。',
  invalid_trade_time: '成交时间填得不对。',
  invalid_trade_identity: '这笔成交的身份对不上，可能来自另一个账户。',
  trade_id_gap: '这段成交中间是断的，先把缺的那一段补齐再对账。',
  trade_order_not_strict: '这批成交的先后顺序对不上，同一时刻的两笔要能分先后。',
  trade_source_conflict: '同一笔成交在两次导入里内容不一样，先确认哪一份是对的。',
  ledger_source_conflict: '同一条资金流水在两次导入里内容不一样，先确认哪一份是对的。',
  import_dataset_conflict: '这次导入的类别和上一次对不上。',
  fill_outside_declared_coverage: '这批成交里有落在你声明范围之外的，先把范围改对。',
  incompatible_trade_book: '这笔成交不属于这个品种或方向的持仓。',
  settlement_asset_change_requires_separate_book: '这个品种换过结算币种，要分开成两本账。',
  opening_position_evidence_required: '填期初持仓要写清楚依据。',
  opening_seed_must_cover_first_imported_fill: '期初时间要早于这个品种的第一笔成交。',
  opening_seed_does_not_cover_imported_history: '这段成交比你填的期初还早，先把期初时间往前放。',
  opening_position_conflicts_with_exchange_pnl: '填的期初和交易所给的已实现盈亏对不上，核对之后再填。',
  hedge_seed_quantity_must_be_nonnegative: '双向持仓的期初数量不能是负数，方向用多空来表示。',
  hedge_fill_exceeds_known_position: '这笔平仓比已知的持仓还多，期初可能不完整。',
  invalid_contract_multiplier: '合约乘数填得不对。',
  invalid_opening_cost: '期初成本价填得不对。',
  invalid_position_seed: '这条期初持仓读不出来。',
  invalid_position_side: '持仓方向填得不对。',
  projection_open_cycle_missing: '这一轮持仓还没有算完，稍后再看。',
  projection_book_budget_exceeded: '这个账户的品种太多，先按品种分批处理。',
  connection_filter_required: '账户太多了，先选一个账户再看。',
  cycle_cursor_filter_mismatch: '翻页的条件变了，回到第一页重新看。',
  invalid_cycle_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_ledger_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_trade_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_page_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_reconciliation: '这次对账填得不对：时间范围或者每个币种的口径有问题。',
  duplicate_statement_asset: '同一个币种在对账单里填了两次。',
  negative_tolerance: '容差不能是负数。',
  invalid_execution_link: '这次关联填得不对：至少要指到一条判断、一段行情或一个打法，并写清依据。',
  fill_not_in_connection: '选中的成交不属于这个账户。',
  execution_link_not_in_connection: '要替换的那条关联不属于这个账户。',
  execution_link_head_conflict: '这条关联已经被另一条替换过了，重新读一下再改。',
  // CSV 与账单导入
  unsupported_csv_schema_or_size: '这份 CSV 的格式或大小不支持。',
  invalid_explicit_csv_mapping: '列的对应关系要一列一列指明，不能靠猜。',
  csv_timestamp_mapping_required: '要指明哪一列是时间，以及它的格式。',
  invalid_timestamp_format: '时间格式写得不对。',
  csv_invalid_timestamp: '有一行的时间读不出来。',
  csv_row_width_mismatch: '有一行的列数和表头对不上。',
  csv_row_limit_exceeded: '这份 CSV 行数太多，分几次导入。',
  csv_fill_fields_incomplete: '成交需要的列没有指全。',
  csv_ledger_fields_incomplete: '资金流水需要的列没有指全。',
  csv_invalid_liquidation_boolean: '强平那一列的取值读不出来。',
  invalid_csv_row: '有一行读不出来。',
  invalid_export_definition: '这次账单导出的范围或格式填得不对。',
  explicit_trade_export_format_required: '要明确选一种账单格式。',
  trade_export_requires_exactly_one_csv: '这个压缩包里应该只有一份 CSV。',
  invalid_trade_export_zip: '这个压缩包读不出来。',
  export_mapping_revision_conflict: '列的对应关系刚被改过，重新读一下再改。',
  export_resolution_conflict: '这次账单刚被处理过，刷新一下再看。',
  export_download_id_missing: '还没有拿到下载编号，等交易所把账单准备好。',
  verified_export_download_id_required: '要填交易所给的那个下载编号。',
  export_download_identity_mismatch: '这个下载编号不是这次账单的。',
  account_export_download_budget_exceeded: '这份账单太大了，把时间范围分小一点。',
  invalid_account_time_window: '账户接口一次只能读有限的一段时间，把范围改小。',
  exchange_trade_outside_window: '交易所返回了范围之外的成交，这次同步不采用。',
  exchange_income_outside_window: '交易所返回了范围之外的资金流水，这次同步不采用。',
  exchange_symbol_mismatch: '交易所返回的品种和请求的对不上。',
  provider_pagination_stalled: '交易所翻页没有往前走，稍后再同步一次。',
  provider_pagination_overlap: '交易所返回的分页有重叠，稍后再同步一次。',
  provider_source_requires_connector: '这一步要先配好账户连接。',

  // ——— v4：按图索骥 ———
  invalid_chart_search: '这次搜图的条件填得不对。',
  invalid_candidate: '这条候选读不出来，重新搜一次。',
  invalid_candle_geometry: '这张图里的 K 线结构读不出来。',
  geometry_processing_failed: '结构比对没有做完，重试一次。',
  ordinary_candles_not_resolved: '这张图里的 K 线没有认出来，框出要比的那一块再试。',
  indexed_window_source_unproven: '这一段历史的来源核验没有通过，已经从结果里排除。',
  contract_missing_from_verified_catalog: '这个合约不在已核验的目录里。',
  search_generation_conflict: '这次检索刚被别处动过，刷新一下再看。',
  invalid_search_job: '这次搜图任务的内容不完整。',
  image_processing_interrupted: '图片处理中断了，重试一次。',
  image_encoding_failed: '这张图编码失败了，换一张试试。',
  invalid_image_batch_size: '一次处理的图片数量不对。',
  ocr_model_version_mismatch: '识字服务的版本和后端对不上。',
  ocr_response_too_large: '这张图上的字太多了，框小一点再试。',
  invalid_ocr_response: '识字服务返回的内容读不出来。',
  invalid_visual_response: '视觉模型返回的内容读不出来。',
  invalid_chart_response: '这张图没有画出来，重试一次。',
  market_source_lookup_budget: '这次要查的行情来源太多，把范围改小。',
  attachment_integrity_failure: '这张图和它存下来的校验对不上，重新传一次。',
  invalid_window_identity: '这一段历史的编号读不出来，重新搜一次。',

  // ——— v4：历史范围 ———
  invalid_history_scope: '这个历史范围填得不对。',
  invalid_history_budget: '容量上限填得不对。',
  invalid_subscription_definition: '这次订阅的品种、周期或起点填得不对。',
  invalid_subscription_symbols: '订阅的品种填得不对。',
  invalid_subscription_action: '这个操作对这条订阅不适用。',
  invalid_subscription_end: '订阅的结束时间填得不对。',
  subscription_revision_conflict: '这条订阅刚被改过，刷新一下再操作。',
  subscription_revision_or_state_conflict: '这条订阅刚变过，刷新一下再操作。',
  subscription_state_changed: '这条订阅的状态刚变过，刷新一下再看。',
  invalid_archive_range: '这段归档范围填得不对。',
  invalid_archive_period: '这个归档周期不支持。',
  archive_plan_exceeds_120_months: '一次最多准备 120 个月，分几次来。',
  invalid_archive_checksum: '这份月档和它的校验值对不上，来源可能变过。',
  archive_size_mismatch: '这份月档的大小和目录对不上，来源可能变过。',
  invalid_archive_catalog: '归档目录读不出来。',
  invalid_archive_cursor: '翻页的位置读不出来，回到第一页。',
  archive_catalog_page_budget_exceeded: '这一页太大了，把范围改小。',
  archive_bar_budget_exceeded: '这一段 K 线太多了，把范围改小。',
  estimate_overflow: '这个范围太大，估不出来，先改小一点。',
  invalid_estimate_range: '要估算的范围填得不对。',
  catalog_refresh_required: '还没有核对过币安的合约目录，先核对一次再准备历史。',
  delisted_contract_requires_explicit_archive_plan:
    '这个合约已经退市或者不在当前目录里了，它的历史只在官方月度归档里。要准备它，得明说走归档。',
  source_coverage_gaps: '这一轮取回来的行情中间有缺口，没有整段发布出去。缺口那几段要单独重来。',
  subscription_not_active: '这条跟进现在没在往前走，先继续它。',
  subscription_child_requires_attention: '这一轮里有一段停下来等人处理，跟进要等它。',
  subscription_plan_scheduled: '这一轮的下一段已经排上了，等它做完。',
  subscription_plan_in_progress: '这一轮的这一段还在做。',
  subscription_no_new_closed_window: '这一段还没有走完一个完整的窗口，暂时没有新东西可准备。',
  archive_boundary_listing_budget_exceeded:
    '这个合约的归档文件太多，一次列不完，先把范围缩到具体的年份或周期。',
  archive_first_boundary_unproven: '归档里最早那个月的起点核不出来，这一段的边界还不能确定。',
  archive_last_boundary_unproven: '归档里最后那个月的终点核不出来，这一段的边界还不能确定。',
  invalid_subscription_job: '这条跟进的后台任务读不出来。',
  invalid_subscription_cycle: '这条跟进的轮次读不出来。',
  invalid_subscription_child: '这条跟进正在做的那一段读不出来。',
  invalid_child_plan: '这一段的编号读不出来。',
  invalid_plan_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_child_range: '这一小段的范围填得不对。',

  // ——— v4：正式统计、参照与裁决 ———
  invalid_statistics_definition: '这次统计的口径填得不对。',
  unsupported_statistics_policy: '这个统计口径暂不支持。',
  statistics_snapshot_not_ready: '这次统计还没有算完，算完了才能看组成。',
  invalid_member: '这条成员读不出来。',
  invalid_member_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_group_cursor: '翻页的位置读不出来，回到第一页。',
  invalid_sample_filter: '这个筛选条件不对。',
  baseline_only_t1: '参照基准只对这一类标准有意义。',
  baseline_symbol_missing: '先选一个品种再算参照。',
  baseline_market_missing: '先选一个市场再算参照。',
  baseline_snapshot_not_ready: '参照还没有算完，稍后再看。',
  unsupported_baseline_source_or_calendar: '这个来源或交易日历暂不支持。',
  invalid_baseline_rule: '参照的规则填得不对。',
  invalid_baseline_bars: '参照用的 K 线读不出来。',
  invalid_verdict: '这次裁决填得不对。',
  verdict_request_changed: '这条待裁决刚变过，重新读一下再提交。',
  invalid_playbook_transition: '打法的状态变更填得不对。',
  playbook_transition_requires_new_version: '要先提一个新版本，才能做这次变更。',
  playbook_state_changed: '这个打法的状态刚变过，刷新一下再操作。',
  invalid_episode_review: '这段行情的复盘内容填得不对。',
  episode_evidence_changed: '这段行情的依据刚变过，看过之后再提交。',
  episode_evidence_budget_exceeded: '这段行情引用的内容太多了。',
  assessment_source_not_changeable: '这项跟踪现在不能换来源。',
  invalid_assessment_source_plan: '这个来源方式不支持。',
  completed_assessment_requires_revision: '这条已经有正式结果了，要改就走数据订正。',
  candidate_source_plan_missing: '这条候选没有配套的行情来源，画不出它那一段。',
  monitor_checkpoint_conflict: '这项跟踪刚被别处推进过，刷新一下再看。',

  // ——— v4：知识检索与问答 ———
  invalid_knowledge_query: '这次检索的问法读不出来，换个说法再试。',
  text_encoder_not_configured: '本机负责读文字的模型没有启动，所以现在搜不了。把它开起来之后再搜，别的地方照常用。',
  text_encoder_unavailable: '本机的文字模型连不上，确认它还在运行。',
  text_encoder_request_failed: '本机的文字模型这次没答上来，稍后再搜一次。',
  text_encoder_read_failed: '读本机文字模型的回应时断了，再搜一次。',
  text_encoder_response_too_large: '本机文字模型这次回了一份太大的结果，换个短一点的说法再试。',
  source_encoding_failed: '这份来源读不成文本，看不了全文。',
  invalid_knowledge_cursor: '翻页的位置读不出来，重新检索一次。',
  knowledge_document_too_large: '这份资料太长了，分开再存。',
  invalid_source_slice: '要读的这一段位置不对，回到片段开头重新读。',
  source_version_changed: '这份来源已经变了，重新取一次证。',
  citation_source_changed: '引用的来源已经变了，重新取一次证。',
  citation_source_removed: '引用的来源已经不在了。',
  citation_not_observed_by_tool: '这条引用不在这次实际查到的资料里。',
  citation_budget_exceeded: '这次引用的内容太多了。',
  invalid_citation_identity: '这条引用对不上原文。',
  chat_model_not_configured: '还没有选定问答用的模型，所以现在问不了。这不是网络问题，也不会给你一个编出来的答案。',
  chat_run_inactive: '这次问答已经结束了。',
  chat_run_changed: '这次问答的状态刚变过，重新读一下。',
  invalid_chat_input: '这次提问读不出来，换个说法再试。',
  invalid_chat_run: '这次问答的内容不完整。',
  invalid_chat_attachment: '带上的这张图不能用在问答里。',
  chat_original_image_removed: '你传的那张截图已经不在了，这次回答不能引用它。',
  chat_original_image_integrity_failure: '你传的那张截图和它的校验对不上，先不引用它。',
  chat_original_image_budget_exceeded: '这次带的图太多了。',
  unknown_chat_tool: '这个工具本机后端不认识。',
  unknown_or_write_tool_forbidden: '这一步要你确认之后才能做。',
  invalid_tool_arguments: '这一步的参数不对。',
  tool_evidence_missing: '这一步缺少可以引用的依据。',
  tool_state_changed: '要改的内容刚变过，看过新的再确认。',
  model_tool_identity_reused: '这一步重复了，重新问一次。',
  invalid_or_expired_confirmation: '这次确认已经过期，重新看一遍再确认。',
  model_version_mismatch: '模型版本和后端对不上。',
  invalid_model_reply: '模型返回的内容读不出来。',
  invalid_event_cursor: '续读的位置不对，重新连一次。',
  credential_revoked_or_expired: '这台机器的凭证失效了，确认后端还在运行。',
  chat_model_identity_changed_create_new_run:
    '这台机器换过问答用的模型了。这次问答不会接着用新模型跑下去，重新问一次。',
  turn_or_time_budget_exhausted: '这次问答走到了后端定的步数或时间上限，已经查到的东西都留着了。',
  model_time_budget_exhausted: '模型这次想得太久，超过了后端定的时间上限。',
  model_context_budget_exhausted: '这次要看的材料超过了一次能带的量，把问题问得更具体一点。',
  chat_time_budget_exhausted: '这次问答的时间用完了。',
  tool_time_budget_exhausted: '这一步查得太久，超时了。已经做完的部分留着，没做完的不算它做过。',
  invalid_saved_model_turn: '这次问答存下来的一步读不出来。',
  invalid_model_tool_call: '模型这一步的调用不合规矩，后端没有执行它。',

  // ——— v4：加密备份 ———
  invalid_backup_configuration: '备份配置填得不对。',
  invalid_backup_repository: '备份仓库的位置填得不对。',
  absolute_backup_repository_required: '备份仓库要填绝对路径。',
  https_backup_repository_required: '远端备份仓库要用 HTTPS。',
  backup_repository_must_be_outside_live_storage: '备份不能放在正在用的存储目录里。',
  unsupported_backup_storage_kind: '这种备份存放方式不支持。',
  backup_credentials_must_use_keychain: '备份密码只能放本机 Keychain，不填在这里。',
  backup_not_initialized: '备份仓库还没有初始化。',
  backup_initialize_mode_must_be_create_or_open: '初始化方式只能是新建或打开已有仓库。',
  backup_copy_in_progress: '上一次备份还在进行，等它结束。',
  backup_source_verification_failed: '备份写完之后读回来对不上，这一次不算成功。',
  external_mount_required: '要先接上那个外部存储。',
  unexpected_external_mount: '接上的外部存储不是配置里的那一个。',
  restore_destination_must_not_exist: '恢复只能往一个空的位置做。',
  restored_archive_verification_failed: '这份归档的校验没有通过。',
  restored_owner_mismatch: '这份归档不是这个账户的。',
}

/** Turns a backend code into a sentence; used for job failures too. */
/**
 * 这个码我们认不认得。认不得的时候不要用那句通用的话盖过去——后端原样说了什么，
 * 得让人看见，不然「不知道」会被显示成「稍后重试」。
 */
export function known(code: string | null | undefined): boolean {
  return !!code && code in TEXT
}

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
