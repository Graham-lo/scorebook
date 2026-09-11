#!/usr/bin/env python3
"""「按图找历史走势」的截图质量盲测。

要回答的问题只有一个：**给一张真实感的行情截图，系统能不能把它对应的那一段历史
找回来**。docs/history-search.md 末尾那句「真实截图质量盲测……仍未完成」说的就是
这件事，这个脚本是那半句的答案。

怎么才算有真值：随机挑一条已发布的 `public_market.features` 行，它自己的 id 就是
答案。按它的 `(market, symbol, timeframe, start_at, end_at)` 去币安月档取回那一段
真实 K 线，画成一张截图，再从 HTTP 正门推进去检索。返回的候选里出现那条 id 就是
命中，名次就是排名。**不是**拿后端画的图喂给后端自己——那样测的是一次往返。

两个数分开报，永远不混：
  - 精确命中：真值那一行的 id 出现在结果里。
  - 近似命中：同品种同周期、且与真值窗口有 ≥90% 的 bar 重叠。索引里同一段行情
    被 STRIDE=4 切成好几个起点几乎一样的窗口，人看到的是「对的那段走势」，
    但 id 不是刚才那一条。对用户来说这是对的，对检索评测来说这是另一回事。

Track A 是用户自己那几张真实截图。它们**没有真值**，所以给不出命中率，只能出
并排图给人看。两条 track 的结论不许互相借用。

隔离见 ops/blindtest/isolation.py：整场实验在一套独立的 PostgreSQL 容器
（blindtest-pg，55533 端口）加一对 target/debug 进程里，跑完连容器一起删。

渲染要 Pillow，系统 python3 里没有。用仓库里现成那个：

    vision/.venv/bin/python ops/blind_test.py --help
"""

from __future__ import annotations

import argparse
import json
import os
import random
import statistics
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from blindtest import isolation, render as R
from blindtest.archive import INTERVAL_SECONDS, Archive, ArchiveMissing
from blindtest.client import ApiError, Client

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(REPO, "data", "local-token")


def real_shots_dir() -> str:
    """本机那些真实截图的落盘目录：data/attachments/<owner_id>/。

    owner_id 是本机独有的，不写死在仓库里。默认取 data/attachments 底下唯一那个
    目录；本机不止一个 owner 时用 SCOREBOOK_OWNER_ID 指名道姓。
    """
    root = os.path.join(REPO, "data", "attachments")
    named = os.environ.get("SCOREBOOK_OWNER_ID")
    if named:
        return os.path.join(root, named)
    owners = sorted(
        d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))
    )
    if len(owners) != 1:
        raise SystemExit(
            f"{root} 底下有 {len(owners)} 个 owner 目录，用 SCOREBOOK_OWNER_ID 指定一个"
        )
    return os.path.join(root, owners[0])

# 一轮里各周期分多少次试验。快照里 1d 有 187 个品种、4h 有 17 个，这两个才撑得起
# 分桶；1h 只有 4 个品种、30m 只有 1 个，它们的命中率天然偏高——语料里几乎没有
# 同周期的干扰项——所以单独列、报告里明确标注「不可外推」。
# 3d 留三次，纯粹是为了把「它根本检索不到」这件事用实验钉死，见 draw_truth 的注释。
DEFAULT_MIX = {"1d": 0.55, "4h": 0.27, "1h": 0.13, "30m": 0.05}

# 周期是**必填**的，不是我选的：`chart_match::require_interval`（chart_match.rs:13）
# 在编码之前就把没有 interval 的请求打回 `chart_interval_required`。所以每一次
# 检索都是「在这个周期内部找」，而 `public_candidates` 里
# `($5::text IS NULL OR timeframe=$5)` 是硬过滤。
#
# 这件事必须在读数字时记住：1h 语料里只有 4 个品种、30m 只有 1 个，给定周期之后
# 它们的搜索空间小得可笑，命中率天然虚高，**不能外推**。真正有意义的只有 1d
# （185 个品种）和 4h（17 个）。
INTERVAL_FILTER = True

# 只抽「结束时间早于本月一号」的窗口：Binance Vision 的月档要等一个月过完才发布，
# 本月的窗口我根本画不出来（`bars()` 会拿到 0 根，整次试验作废）。不设这道线的话，
# 30m/1h 这两个几乎全是近端 REST 索引出来的周期会被成片跳过——那不是系统的问题，
# 是取数的问题，混进失败率里就是污染。
ARCHIVE_CUTOFF = datetime.now(timezone.utc).replace(
    day=1, hour=0, minute=0, second=0, microsecond=0)

_print_lock = threading.Lock()


def log(*a):
    with _print_lock:
        print(*a, flush=True)


def parse_ts(v: str) -> datetime:
    v = v.strip().replace(" ", "T")
    if v.endswith("+00"):
        v = v[:-3] + "+00:00"
    return datetime.fromisoformat(v)


# ---------------------------------------------------------------- 抽真值

def snapshot_strata():
    rows = isolation.query(
        "SELECT timeframe, bars_count, count(*), count(DISTINCT symbol) "
        "FROM public_market.features WHERE published AND model_id='candle-geometry-v2' "
        "GROUP BY 1,2 ORDER BY 1,2"
    )
    out = {}
    for tf, bc, n, syms in rows:
        out.setdefault(tf, {})[int(bc)] = {"rows": int(n), "symbols": int(syms)}
    return out


def draw_truth(timeframe: str, bars_count: int | None, n: int, seed: int):
    """从快照里随机抽 n 条真值行。

    按 `(symbol)` 先散开再抽，是为了别让 BTCUSDT 这种窗口密的品种把样本吃掉——
    它一个品种就有上千个窗口，纯 random() 抽出来的样本会向它严重倾斜，而结论
    「系统能不能找回任意品种」恰恰要求样本是散在品种上的。
    """
    cond = (f"timeframe='{timeframe}' AND bars_count IN (64,128,256) "
            f"AND end_at < '{ARCHIVE_CUTOFF.isoformat()}'")
    if bars_count:
        cond += f" AND bars_count={bars_count}"
    rows = isolation.query(
        f"SELECT id,market,symbol,timeframe,start_at,end_at,bars_count "
        f"FROM (SELECT *, row_number() OVER (PARTITION BY symbol ORDER BY md5(id::text||'{seed}')) rn "
        f"      FROM public_market.features WHERE published AND model_id='candle-geometry-v2' AND {cond}) t "
        f"ORDER BY rn, md5(id::text||'{seed}') LIMIT {n}"
    )
    return [
        {
            "id": r[0], "market": r[1], "symbol": r[2], "timeframe": r[3],
            "start_at": r[4], "end_at": r[5], "bars_count": int(r[6]),
        }
        for r in rows
    ]


# ---------------------------------------------------------------- 单次试验

def overlap_fraction(a_start, a_end, b_start, b_end) -> float:
    lo = max(a_start, b_start)
    hi = min(a_end, b_end)
    if hi <= lo:
        return 0.0
    return (hi - lo).total_seconds() / (a_end - a_start).total_seconds()


def run_trial(ctx, truth, index: int):
    """画一张图、推进去、把发生的一切记下来。异常也记下来，不往上抛。"""
    rec = {"kind": "truth", "index": index, "truth": dict(truth)}
    t_begin = time.time()
    try:
        start = parse_ts(truth["start_at"])
        end = parse_ts(truth["end_at"])
        bars = ctx["archive"].bars(truth["market"], truth["symbol"], truth["timeframe"], start, end)
        rec["bars_fetched"] = len(bars)
        if len(bars) != truth["bars_count"]:
            # 月档和索引对不上就直接弃掉这次：拿一段不一样的 K 线去画图，
            # 「找不回来」就成了我自己造的假阴性。
            rec["outcome"] = "skipped_bars_mismatch"
            return rec

        rng = random.Random(ctx["seed"] * 1_000_003 + index)
        style = R.sample_style(rng, len(bars))
        png = R.render(bars, style, truth["symbol"], truth["timeframe"], seed=rng.randrange(1 << 30))
        rec["style"] = style.to_json()
        rec["image_bytes"] = len(png)

        if ctx["keep_images"]:
            ext = "jpg" if style.jpeg else "png"
            p = os.path.join(ctx["out"], "renders", f"{index:04d}_{truth['symbol']}_{truth['timeframe']}.{ext}")
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(png)
            rec["image_path"] = p

        c = ctx["client"]
        t0 = time.time()
        aid = c.upload(png, f"blind_{index}.{'jpg' if style.jpeg else 'png'}",
                       "image/jpeg" if style.jpeg else "image/png")
        rec["attachment_id"] = aid
        rec["upload_seconds"] = round(time.time() - t0, 3)

        t0 = time.time()
        try:
            analysis = c.analyze(aid)
            q = analysis.get("geometry", {})
            rec["geometry"] = {
                "detected_candles": q.get("detected_candles"),
                "spacing_consistency": q.get("spacing_consistency"),
                "region": q.get("region"),
                "red_up": q.get("red_up"),
            }
            rec["analyze_seconds"] = round(time.time() - t0, 3)
        except ApiError as e:
            rec["outcome"] = "analysis_failed"
            rec["error_code"] = e.code or f"http_{e.status}"
            rec["analyze_seconds"] = round(time.time() - t0, 3)
            return rec

        t0 = time.time()
        policy = ctx.get("interval_policy", "same_interval")
        rec["interval_policy"] = policy
        run = c.search(aid, interval=truth["timeframe"], limit=30, interval_policy=policy)
        result = c.poll(run["search_run_id"], timeout=600)
        rec["search_seconds"] = round(time.time() - t0, 3)
        rec["search_run_id"] = run["search_run_id"]
        rec["status"] = result.get("status")
        if result.get("status") != "succeeded":
            # 「作业自己报错」和「我等腻了」是两回事：后者说明队列没在动（worker
            # 那两条 interactive 循环 panic 掉了就会这样），不是检索质量的问题，
            # 统计的时候必须分开，不然会把一次运维事故算成一次漏检。
            rec["outcome"] = ("search_timeout" if result.get("_timeout")
                              else "search_failed")
            rec["error_code"] = result.get("error_code") or (
                f"harness_gave_up_status={result.get('status')}"
                if result.get("_timeout") else None)
            return rec

        items = (result.get("result") or {}).get("items") or []
        rec["returned"] = len(items)
        cands = []
        rank_exact = None
        rank_near = None
        rank_symbol = None
        for i, it in enumerate(items):
            same = it.get("symbol") == truth["symbol"] and it.get("interval") == truth["timeframe"]
            ov = 0.0
            if same:
                ov = overlap_fraction(start, end, parse_ts(it["start_at"]), parse_ts(it["end_at"]))
            cands.append({
                "rank": i + 1,
                "id": it.get("id"),
                "symbol": it.get("symbol"),
                "interval": it.get("interval"),
                "bars_count": it.get("bars_count"),
                "start_at": it.get("start_at"),
                "end_at": it.get("end_at"),
                "score": (it.get("match") or {}).get("score"),
                "overlap": round(ov, 4),
            })
            if it.get("id") == truth["id"] and rank_exact is None:
                rank_exact = i + 1
            if same and ov >= 0.90 and rank_near is None:
                rank_near = i + 1
            if same and rank_symbol is None:
                rank_symbol = i + 1
        rec["candidates"] = cands
        rec["rank_exact"] = rank_exact
        rec["rank_near"] = rank_near
        rec["rank_symbol"] = rank_symbol
        rec["best_overlap"] = max((c["overlap"] for c in cands), default=0.0)
        rec["top_score"] = cands[0]["score"] if cands else None
        rec["truth_score"] = next((c["score"] for c in cands if c["id"] == truth["id"]), None)
        rec["outcome"] = "ok"
        return rec
    except ArchiveMissing as e:
        rec["outcome"] = "archive_missing"
        rec["error_code"] = str(e)
        return rec
    except Exception as e:
        rec["outcome"] = "harness_error"
        rec["error_code"] = f"{type(e).__name__}: {e}"
        rec["traceback"] = traceback.format_exc()[-1500:]
        return rec
    finally:
        rec["total_seconds"] = round(time.time() - t_begin, 3)


# ---------------------------------------------------------------- 负对照

def random_walk(n: int, rng: random.Random, interval: str):
    """一段没有对应任何索引窗口的合成走势。

    负对照要回答的是：**分数能不能当阈值用**。如果一张根本不存在于库里的图也能拿到
    和真命中差不多的最高分，那这个分数就只是「最像的那个有多像」，不能用来判断
    「库里到底有没有」。所以这里的走势必须和真行情统计上接近——用对数随机游走、
    带日内波幅和成交量——否则它会因为「看起来不像行情」而被轻松拒绝，
    那样得到的是一个太好看的假结论。
    """
    step = INTERVAL_SECONDS[interval] * 1000
    t0 = int(datetime(2019, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    price = math_exp = 100.0 * (2 ** rng.uniform(-6, 6))
    sigma = rng.uniform(0.012, 0.055)
    bars = []
    for i in range(n):
        o = price
        drift = rng.gauss(0, sigma)
        c = max(1e-8, o * (1 + drift))
        hi = max(o, c) * (1 + abs(rng.gauss(0, sigma * 0.6)))
        lo = min(o, c) * (1 - abs(rng.gauss(0, sigma * 0.6)))
        bars.append({
            "start_ms": t0 + i * step,
            "end_ms": t0 + (i + 1) * step,
            "open": o, "high": hi, "low": lo, "close": c,
            "volume": abs(rng.gauss(1000, 400)) + 1,
        })
        price = c
    return bars


def run_negative(ctx, index: int, interval: str, bars_count: int):
    rec = {"kind": "negative", "index": index, "interval": interval, "bars_count": bars_count}
    t_begin = time.time()
    try:
        rng = random.Random(ctx["seed"] * 7_777_777 + index)
        bars = random_walk(bars_count, rng, interval)
        style = R.sample_style(rng, len(bars))
        png = R.render(bars, style, "SYNTHUSDT", interval, seed=rng.randrange(1 << 30))
        rec["style"] = style.to_json()
        c = ctx["client"]
        aid = c.upload(png, f"neg_{index}.{'jpg' if style.jpeg else 'png'}",
                       "image/jpeg" if style.jpeg else "image/png")
        try:
            q = c.analyze(aid).get("geometry", {})
            rec["geometry"] = {"detected_candles": q.get("detected_candles"),
                               "spacing_consistency": q.get("spacing_consistency")}
        except ApiError as e:
            rec["outcome"] = "analysis_failed"
            rec["error_code"] = e.code or f"http_{e.status}"
            return rec
        t0 = time.time()
        run = c.search(aid, interval=interval, limit=30,
                       interval_policy=ctx.get("interval_policy", "same_interval"))
        result = c.poll(run["search_run_id"], timeout=600)
        rec["search_seconds"] = round(time.time() - t0, 3)
        rec["status"] = result.get("status")
        if result.get("status") != "succeeded":
            rec["outcome"] = "search_failed"
            rec["error_code"] = result.get("error_code")
            return rec
        items = (result.get("result") or {}).get("items") or []
        rec["returned"] = len(items)
        rec["scores"] = [(it.get("match") or {}).get("score") for it in items]
        rec["top_score"] = rec["scores"][0] if rec["scores"] else None
        rec["outcome"] = "ok"
        return rec
    except Exception as e:
        rec["outcome"] = "harness_error"
        rec["error_code"] = f"{type(e).__name__}: {e}"
        rec["traceback"] = traceback.format_exc()[-1500:]
        return rec
    finally:
        rec["total_seconds"] = round(time.time() - t_begin, 3)


# ---------------------------------------------------------------- Track A

def run_track_a(ctx):
    """用户自己那几张真实截图。

    这里**没有真值**：没人知道那几张图拍的是哪一段行情，所以这一节给不出任何
    命中率，只能把「系统认为最像的那一段」画出来放在原图旁边，让人自己看。
    正因为它给不出数，Track B 才必须存在。
    """
    out = os.path.join(ctx["out"], "trackA")
    os.makedirs(out, exist_ok=True)
    shots = real_shots_dir()
    files = sorted(
        os.path.join(shots, f) for f in os.listdir(shots) if not f.startswith(".")
    )
    rows = []
    for i, path in enumerate(files):
        rec = {"kind": "track_a", "index": i, "file": path, "size": os.path.getsize(path)}
        try:
            data = open(path, "rb").read()
            aid = ctx["client"].upload(data, f"real_{i}.png", "image/png")
            rec["attachment_id"] = aid
            try:
                q = ctx["client"].analyze(aid).get("geometry", {})
                rec["geometry"] = {"detected_candles": q.get("detected_candles"),
                                   "spacing_consistency": q.get("spacing_consistency"),
                                   "region": q.get("region")}
            except ApiError as e:
                rec["outcome"] = "analysis_failed"
                rec["error_code"] = e.code or f"http_{e.status}"
                rows.append(rec); log(f"[A{i}] {os.path.basename(path)} analyze -> {rec['error_code']}")
                continue
            # 这些图的周期没人知道（只有那张 1320x2868 的用户说过是 30 分钟），
            # 所以这一轨故意走 `any_interval`：不猜周期，只比形状，让系统自己说
            # 它认为这是哪个币的哪一段、什么周期。猜一个周期传进去，等于我替系统
            # 把一半的题做了，然后拿它答对剩下一半来夸它。
            rec["interval_policy"] = "any_interval"
            run = ctx["client"].search(aid, interval=None, limit=10,
                                       interval_policy="any_interval")
            result = ctx["client"].poll(run["search_run_id"], timeout=600)
            rec["status"] = result.get("status")
            if result.get("status") != "succeeded":
                rec["outcome"] = "search_failed"
                rec["error_code"] = result.get("error_code")
                rows.append(rec); log(f"[A{i}] search -> {rec['error_code']}")
                continue
            items = (result.get("result") or {}).get("items") or []
            rec["items"] = [
                {"id": it["id"], "symbol": it["symbol"], "interval": it["interval"],
                 "start_at": it["start_at"], "end_at": it["end_at"],
                 "bars_count": it["bars_count"], "score": (it.get("match") or {}).get("score")}
                for it in items
            ]
            rec["outcome"] = "ok"
            if items:
                top = items[0]
                try:
                    bars = ctx["archive"].bars(
                        top["market"], top["symbol"], top["interval"],
                        parse_ts(top["start_at"]), parse_ts(top["end_at"]),
                    )
                except ArchiveMissing as e:
                    # 候选落在本月（月档还没发布）就画不出对照图。检索结果照样有效，
                    # 不能因为画不出图就把这一条当失败丢掉。
                    bars = []
                    rec["reference_unavailable"] = str(e)
                pair = side_by_side(path, bars, top, ctx)
                p = os.path.join(out, f"{i:02d}_{top['symbol']}_{top['interval']}.png")
                pair.save(p)
                rec["side_by_side"] = p
            log(f"[A{i}] {os.path.basename(path)[:12]} any -> "
                f"{items[0]['symbol']+' '+items[0]['interval'] if items else 'none'} "
                f"{round(items[0]['match']['score'],3) if items else ''}")
        except Exception as e:
            rec["outcome"] = "harness_error"
            rec["error_code"] = f"{type(e).__name__}: {e}"
            log(f"[A{i}] error {e}")
        rows.append(rec)
    contact_sheet(rows, os.path.join(out, "contact_sheet.png"))
    return rows


def side_by_side(real_path: str, bars, top, ctx):
    from PIL import Image, ImageDraw

    left = Image.open(real_path).convert("RGB")
    h = 900
    left = left.resize((max(1, int(left.width * h / left.height)), h))
    right = R.render_reference(bars, top["symbol"], top["interval"], width=1100, height=h) if bars \
        else Image.new("RGB", (1100, h), (250, 250, 250))
    canvas = Image.new("RGB", (left.width + right.width + 30, h + 42), (255, 255, 255))
    canvas.paste(left, (10, 32))
    canvas.paste(right, (left.width + 20, 32))
    d = ImageDraw.Draw(canvas)
    f = R._font_cjk(18)
    d.text((10, 8), "用户原图（真值未知）", font=f, fill=(20, 20, 20))
    d.text((left.width + 20, 8),
           f"系统最佳候选 {top['symbol']} {top['interval']} "
           f"score={round((top.get('match') or {}).get('score', 0), 3)}",
           font=f, fill=(20, 20, 20))
    return canvas


def contact_sheet(rows, path):
    from PIL import Image

    pairs = [r["side_by_side"] for r in rows if r.get("side_by_side")]
    if not pairs:
        return
    thumbs = []
    for p in pairs:
        im = Image.open(p)
        im.thumbnail((900, 300))
        thumbs.append(im)
    w = max(t.width for t in thumbs)
    h = sum(t.height + 8 for t in thumbs)
    sheet = Image.new("RGB", (w, h), (255, 255, 255))
    y = 0
    for t in thumbs:
        sheet.paste(t, (0, y))
        y += t.height + 8
    sheet.save(path)


# ---------------------------------------------------------------- 汇总

# 少于这个数就不报比率，只报命中数。一个 n=6 的 83% 和一个 n=6 的 67% 之间
# 没有任何可读的差别，但印成百分比就会被当成结论引用。
MIN_N = 10


def pct(a, b):
    return round(100.0 * a / b, 1) if b else None


def summarise(report):
    trials = [r for r in report["trials"] if r["kind"] == "truth"]
    ok = [r for r in trials if r.get("outcome") == "ok"]
    lines = []
    W = lines.append

    W("# 截图盲测结果\n")
    W(f"生成于 {report['finished_at']}；快照取自 {report['snapshot_taken_at']}。\n")
    iso = report.get("isolation") or {}
    W(f"隔离实例 {report['base_url']}，连的是 "
      f"`{iso.get('host')}:{iso.get('port')}/{iso.get('database')}`"
      f"（容器 `{iso.get('container')}`，二进制 `{iso.get('binary')}`）。\n")

    W("\n## 语料（快照，固定不动）\n")
    W("| 周期 | 64 根 | 128 根 | 256 根 | 32 根 | 品种数 |")
    W("|---|---|---|---|---|---|")
    for tf, d in sorted(report["strata"].items()):
        # report.json 转一圈回来之后 bars_count 变成了字符串键，直接 d.get(64) 全是空。
        d = {int(k): v for k, v in d.items()}
        syms = max(v["symbols"] for v in d.values())
        W(f"| {tf} | {d.get(64,{}).get('rows','-')} | {d.get(128,{}).get('rows','-')} | "
          f"{d.get(256,{}).get('rows','-')} | {d.get(32,{}).get('rows','-')} | {syms} |")

    W("\n## 总体\n")
    W(f"- 发起试验 {len(trials)}，有效完成 {len(ok)}。")
    for reason in sorted({r.get("outcome") for r in trials} - {"ok"}):
        n = sum(1 for r in trials if r.get("outcome") == reason)
        codes = {}
        for r in trials:
            if r.get("outcome") == reason:
                codes[r.get("error_code")] = codes.get(r.get("error_code"), 0) + 1
        W(f"- `{reason}` {n} 次 {codes}")

    def block(rows, title):
        if not rows:
            return
        W(f"\n### {title}（n={len(rows)}）\n")
        W("| 指标 | top-1 | top-3 | top-10 | top-30 |")
        W("|---|---|---|---|---|")
        for label, key in (("精确 id", "rank_exact"),
                           ("近似（同品种同周期 ≥90% 重叠）", "rank_near"),
                           ("同品种（任意重叠）", "rank_symbol")):
            cells = []
            for k in (1, 3, 10, 30):
                hit = sum(1 for r in rows if r.get(key) and r[key] <= k)
                # n 太小就只给分子分母，不给百分比：一个 4/7 写成 57.1% 会被人当成
                # 可外推的数字读，而它的置信区间几乎覆盖整个 0–100%。
                cells.append(f"{pct(hit, len(rows))}% ({hit})" if len(rows) >= MIN_N
                             else f"{hit}/{len(rows)}")
            W(f"| {label} | " + " | ".join(cells) + " |")
        if len(rows) < MIN_N:
            W(f"\n> n={len(rows)} < {MIN_N}，只列命中数不列比率；这一档不构成结论。")
        miss = sum(1 for r in rows if not r.get("rank_symbol"))
        W(f"\n漏检（三十个候选里连同品种都没有）{miss}/{len(rows)}"
          + (f" = {pct(miss,len(rows))}%" if len(rows) >= MIN_N else ""))
        # 没有这一行，上面那张表就没法读：`best_matches` 每个品种只留一条，所以
        # 三十个候选最多覆盖三十个品种。在只有 17 个品种的 4h 语料里，随手返回
        # 三十条就已经把全部品种都包含了——那样的 89% 不代表任何检索能力。
        tf_here = rows[0]["truth"]["timeframe"]
        d = {int(k): v for k, v in (report["strata"].get(tf_here) or {}).items()}
        pool = max((v["symbols"] for v in d.values()), default=0)
        if pool:
            chance = min(1.0, 30.0 / pool)
            W(f"\n对照：这一周期语料里共 {pool} 个品种，`best_matches` 每品种只留一条，"
              f"所以随机返回三十条的「同品种命中」期望是 {round(100*chance,1)}%。")
        ranks = [r["rank_exact"] for r in rows if r.get("rank_exact")]
        if ranks:
            W(f"\n命中时的名次中位数 {statistics.median(ranks)}，"
              f"平均 {round(statistics.mean(ranks),1)}。")
        lat = sorted(r["search_seconds"] for r in rows if r.get("search_seconds"))
        if lat:
            W(f"检索耗时（含排队）p50 {lat[len(lat)//2]:.1f}s，"
              f"p95 {lat[min(len(lat)-1, int(len(lat)*0.95))]:.1f}s，最大 {lat[-1]:.1f}s。")

    block([r for r in ok if r["truth"]["timeframe"] == "1d"],
          "1d（正文：185 个品种，唯一有广度的语料）")
    for tf in ("4h", "1h", "30m"):
        rows = [r for r in ok if r["truth"]["timeframe"] == tf]
        d = report["strata"].get(tf, {})
        syms = max((v["symbols"] for v in d.values()), default=0)
        block(rows, f"{tf}（仅 {syms} 个品种，命中率天然偏高，不进正文）")

    W("\n## 按 bars_count 分\n")
    W(f"n < {MIN_N} 的档同样只给命中数。最后一列是漏检：三十个候选里连同品种都没出现。\n")
    W("| 周期 | 根数 | n | top-1 精确 | top-30 精确 | top-1 近似 | top-30 近似 | 漏检 |")
    W("|---|---|---|---|---|---|---|---|")
    for tf in ("1d", "4h", "1h", "30m"):
        for bc in (64, 128, 256):
            rows = [r for r in ok if r["truth"]["timeframe"] == tf and r["truth"]["bars_count"] == bc]
            if not rows:
                continue
            n = len(rows)
            def c(f):
                k = sum(1 for r in rows if f(r))
                return f"{pct(k,n)}%" if n >= MIN_N else f"{k}/{n} (n小)"
            W(f"| {tf} | {bc} | {n} | "
              + " | ".join([c(lambda r: r.get("rank_exact") == 1),
                            c(lambda r: r.get("rank_exact")),
                            c(lambda r: r.get("rank_near") == 1),
                            c(lambda r: r.get("rank_near")),
                            c(lambda r: not r.get("rank_symbol"))]) + " |")

    W("\n## 渲染条件对命中的影响\n")
    W("这里报的是**近似命中**（同品种同周期 ≥90% 重叠），不是精确 id——理由见上。\n")
    W(f"n < {MIN_N} 的档只给「命中数/样本数」，不给比率。\n")
    W("| 条件 | 取值 | n | top-30 近似 | top-1 近似 | 检出蜡烛/真值 |")
    W("|---|---|---|---|---|---|")
    base = [r for r in ok if r["truth"]["timeframe"] == "1d"]

    def cond(name, fn, values):
        for v in values:
            rows = [r for r in base if fn(r) == v]
            if not rows:
                continue
            n30 = sum(1 for r in rows if r.get("rank_near"))
            n1 = sum(1 for r in rows if r.get("rank_near") == 1)
            det = [r["geometry"]["detected_candles"] / r["truth"]["bars_count"]
                   for r in rows if r.get("geometry", {}).get("detected_candles")]
            cell30 = f"{pct(n30,len(rows))}%" if len(rows) >= MIN_N else f"{n30}/{len(rows)} (n小)"
            cell1 = f"{pct(n1,len(rows))}%" if len(rows) >= MIN_N else f"{n1}/{len(rows)}"
            W(f"| {name} | {v} | {len(rows)} | {cell30} | {cell1} | "
              f"{round(statistics.mean(det),3) if det else '-'} |")

    cond("主题", lambda r: r["style"]["theme"], ["light", "dark"])
    cond("机身", lambda r: r["style"]["frame"], sorted(R.FRAMES))
    cond("均线配色", lambda r: r["style"]["ma_palette"], sorted(R.MA_PALETTES))
    cond("均线条数", lambda r: r["style"]["ma_count"], [0, 2, 3])
    cond("成交量副图", lambda r: r["style"]["volume_pane"], [True, False])
    cond("指标副图", lambda r: r["style"]["indicator_pane"], [True, False])
    cond("JPEG 重压", lambda r: r["style"]["jpeg"], [True, False])
    cond("抗锯齿(超采样)", lambda r: r["style"]["supersample"] == 2, [True, False])
    cond("App 外壳", lambda r: r["style"]["chrome"], [True, False])
    cond("水印", lambda r: r["style"]["watermark"], [True, False])
    cond("悬浮按钮", lambda r: r["style"]["floating_button"], [True, False])
    cond("对数坐标", lambda r: r["style"]["log_scale"], [True, False])
    cond("挤(硬塞竖屏)", lambda r: r["style"]["cramped"], [True, False])
    cond("蜡烛实心宽", lambda r: min(24, max(2, r["style"]["body_w"])) // 4 * 4, [0, 4, 8, 12, 16, 20, 24])
    cond("缩放后宽度", lambda r: r["style"]["final_w"] // 400 * 400, list(range(400, 3600, 400)))

    for inc in report.get("incidents") or []:
        W(f"\n## 运行期事故：{inc['title']}\n")
        W(inc["body"])

    W("\n## 连解析都没过的那一批\n")
    bad = [r for r in trials if r.get("outcome") == "analysis_failed"]
    W(f"{len(bad)}/{len(trials)} 张图在 `/v1/chart-analyses` 这一步就被拒了，"
      "全是 `chart_obstructed_or_unsupported`（蜡烛间距一致性低于 0.75 的那道闸）。"
      "它们没有进入上面任何一张命中率表——换句话说，上面的命中率是"
      "**在「图能被解析」这个条件下**的命中率，不是端到端的。\n")
    if bad:
        W("| 条件 | 取值 | 被拒/该取值总数 |")
        W("|---|---|---|")
        pool = [r for r in trials if r.get("style")]
        for name, fn, values in (
            ("机身", lambda r: r["style"]["frame"], sorted(R.FRAMES)),
            ("周期", lambda r: r["truth"]["timeframe"], ["1d", "4h", "1h", "30m"]),
            ("根数", lambda r: r["truth"]["bars_count"], [64, 128, 256]),
            ("成交量副图", lambda r: r["style"]["volume_pane"], [True, False]),
            ("挤(硬塞竖屏)", lambda r: r["style"]["cramped"], [True, False]),
        ):
            for v in values:
                tot = [r for r in pool if fn(r) == v]
                if not tot:
                    continue
                nb = sum(1 for r in tot if r.get("outcome") == "analysis_failed")
                if nb:
                    W(f"| {name} | {v} | {nb}/{len(tot)} |")

    W("\n## 负对照：库里根本没有的图\n")
    neg = [r for r in report["trials"] if r["kind"] == "negative" and r.get("outcome") == "ok"]
    if neg:
        ns = sorted(r["top_score"] for r in neg if r.get("top_score") is not None)
        ts = sorted(r["truth_score"] for r in ok if r.get("truth_score") is not None)
        tops = sorted(r["top_score"] for r in ok if r.get("top_score") is not None)

        def q(v, p):
            return round(v[min(len(v) - 1, int(len(v) * p))], 4) if v else None

        W(f"- 合成随机游走 n={len(neg)}，最高分 p5/p50/p95 = {q(ns,0.05)} / {q(ns,0.5)} / {q(ns,0.95)}，"
          f"最大 {round(ns[-1],4) if ns else '-'}")
        W(f"- 真值被找到时它自己的分 p5/p50/p95 = {q(ts,0.05)} / {q(ts,0.5)} / {q(ts,0.95)}（n={len(ts)}）")
        W(f"- 真值试验的第一名分数 p5/p50/p95 = {q(tops,0.05)} / {q(tops,0.5)} / {q(tops,0.95)}")
        if ns and ts:
            fp = sum(1 for v in ns if v >= statistics.median(ts))
            W(f"- 用真值分中位数 {round(statistics.median(ts),4)} 当阈值：负对照里有 "
              f"{fp}/{len(ns)}（{pct(fp,len(ns))}%）也过线。")

        # 真正要回答的问题不是「真值分比噪声高吗」，而是「拿到一条 top-1，看它的
        # 分能不能决定信不信」。所以把 top-1 按它自己对不对切成两堆，再跟负对照
        # 放在同一根阈值上比——三条线分不开，这个分就不能当置信度用。
        good = sorted(r["top_score"] for r in ok
                      if r.get("rank_near") == 1 and r.get("top_score") is not None)
        bad = sorted(r["top_score"] for r in ok
                     if r.get("rank_near") != 1 and r.get("top_score") is not None)
        W("\n| 阈值 | 第一名正确且过线 | 第一名错误但过线 | 负对照过线 |")
        W("|---|---|---|---|")
        for th in (0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80):
            a1 = sum(1 for v in good if v >= th)
            b1 = sum(1 for v in bad if v >= th)
            c1 = sum(1 for v in ns if v >= th)
            W(f"| {th:.2f} | {a1}/{len(good)} | {b1}/{len(bad)} | {c1}/{len(ns)} |")
        W("\n第二列是「该留下的」，第三、四列是「该挡掉的」。三列在同一行同时接近"
          "满或同时接近零，就说明这个分数没有区分力。")
    else:
        W("负对照没有跑成。")

    a = [r for r in report["trials"] if r["kind"] == "track_a"]
    W(f"\n## Track A：用户的 {len(a)} 张真实截图（无真值）\n")
    if a:
        okA = [r for r in a if r.get("outcome") == "ok"]
        W(f"- {len(a)} 张，解析并检索成功 {len(okA)}。")
        for r in a:
            if r.get("outcome") == "ok" and r.get("items"):
                t = r["items"][0]
                W(f"  - `{os.path.basename(r['file'])[:12]}` "
                  f"策略 {r.get('interval_policy', r.get('interval_assumed', '-'))}，"
                  f"最佳 {t['symbol']} {t['interval']} {t['start_at'][:10]} "
                  f"score={round(t['score'],3) if t.get('score') is not None else '-'}"
                  + ("（本月档未发布，画不出对照图）" if r.get("reference_unavailable") else ""))
            else:
                W(f"  - `{os.path.basename(r['file'])[:12]}` {r.get('outcome')} "
                  f"{r.get('error_code','')}")
        W("\n这一节**不产生命中率**：没人知道这些图拍的是哪一段行情。它只说明真图能不能"
          "被解析、检索会不会崩，以及系统认为最像的是什么样子。")
    return "\n".join(lines)


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=150)
    ap.add_argument("--track", choices=["a", "b", "both"], default="both")
    ap.add_argument("--negative", type=int, default=20)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--seed", type=int, default=20260911)
    ap.add_argument("--out", default=os.environ.get("BLIND_OUT", "/tmp/blind"))
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--reuse-instance", action="store_true",
                    help="接管一个已经起好的隔离实例，不重新建库、不重新拉进程")
    ap.add_argument("--keep", action="store_true", help="跑完不 DROP 库、不杀进程")
    ap.add_argument("--keep-images", action="store_true", default=True)
    ap.add_argument("--snapshot-taken-at", default=None)
    # `same_interval`（服务端默认）把周期当硬过滤；`any_interval` 只比形状，
    # interval 必须为空，要在全部十五万九千个窗口里挑。后者是更难也更诚实的一问：
    # 光凭 192 维描述子，能不能认出这是哪个币的哪一段。
    ap.add_argument("--interval-policy", choices=["same_interval", "any_interval"],
                    default="same_interval")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    token = open(TOKEN_PATH).read().strip()
    instance = isolation.Instance(args.out, args.port)
    taken = args.snapshot_taken_at
    started_here = False

    try:
        repaired = None
        if not args.reuse_instance:
            log("起盲测集群……")
            isolation.start_container()
            log("灌线上快照（只读 pg_dump，线上不受影响）……")
            taken = isolation.load_snapshot()
            log(f"快照完成 {taken}")
            repaired = isolation.repair_orphan_provenance()
            log(f"补了 {repaired} 条孤儿来源（只在副本里）")
            instance.start()
            started_here = True
            log(f"隔离实例已就绪 {instance.base}")

        client = Client(instance.base, token)
        client.health()

        ctx = {
            "client": client,
            "archive": Archive(os.path.join(args.out, "cache")),
            "out": args.out,
            "seed": args.seed,
            "keep_images": args.keep_images,
            "interval_policy": args.interval_policy,
            "intervals": {},
            "default_interval": "30m",
        }

        report = {
            "started_at": datetime.now(timezone.utc).isoformat(),
            "snapshot_taken_at": taken,
            "base_url": instance.base,
            "isolation": instance.target(),
            "orphan_links_repaired_in_copy": repaired,
            "seed": args.seed,
            "interval_policy": args.interval_policy,
            "strata": snapshot_strata(),
            "trials": [],
        }

        trials = []
        if args.track in ("b", "both"):
            rng = random.Random(args.seed)
            plan = []
            for tf, share in DEFAULT_MIX.items():
                n = max(1, round(args.trials * share))
                counts = [bc for bc in (64, 128, 256)
                          if report["strata"].get(tf, {}).get(bc)]
                per = max(1, n // max(1, len(counts)))
                for bc in counts:
                    plan.append((tf, bc, per))
            for tf, bc, n in plan:
                trials.extend(draw_truth(tf, bc, n, args.seed))
            rng.shuffle(trials)
            log(f"Track B：抽到 {len(trials)} 条真值窗口")

        results = []
        lock = threading.Lock()

        def work(pair):
            i, truth = pair
            r = run_trial(ctx, truth, i)
            with lock:
                results.append(r)
                done = len(results)
            log(f"[{done}/{len(trials)}] {truth['symbol']:>14} {truth['timeframe']:>3} "
                f"{truth['bars_count']:>3}根 -> {r.get('outcome')} "
                f"exact={r.get('rank_exact')} near={r.get('rank_near')} "
                f"{r.get('total_seconds')}s")
            return r

        if trials:
            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                list(ex.map(work, enumerate(trials)))
            report["trials"].extend(results)
            _flush(report, args.out)

        if args.negative:
            log(f"负对照 {args.negative} 次……")
            negs = []
            spec = [("1d", 64), ("1d", 128), ("1d", 256), ("4h", 64), ("1h", 128)]
            jobs = [(i, spec[i % len(spec)]) for i in range(args.negative)]

            def negwork(pair):
                i, (iv, bc) = pair
                r = run_negative(ctx, i, iv, bc)
                with lock:
                    negs.append(r)
                log(f"[neg {len(negs)}/{args.negative}] {iv} {bc} -> {r.get('outcome')} "
                    f"top={r.get('top_score')}")
                return r

            with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
                list(ex.map(negwork, jobs))
            report["trials"].extend(negs)
            _flush(report, args.out)

        if args.track in ("a", "both"):
            log("Track A：用户的真实截图……")
            report["trials"].extend(run_track_a(ctx))

        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        report["archive"] = {"downloads": ctx["archive"].downloads,
                             "cache_hits": ctx["archive"].cache_hits}
        _flush(report, args.out)
        with open(os.path.join(args.out, "summary.md"), "w") as f:
            f.write(summarise(report))
        log(f"写完 {args.out}/report.json 和 summary.md")
    finally:
        if not args.keep:
            if started_here:
                instance.stop()
            else:
                isolation.Instance.stop_by_port(args.port)
            isolation.teardown_container()
            isolation.discard_storage(args.out)
            log("隔离实例已停、盲测容器与卷已删")


def _flush(report, out):
    tmp = os.path.join(out, "report.json.part")
    with open(tmp, "w") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, default=str)
    os.replace(tmp, os.path.join(out, "report.json"))


if __name__ == "__main__":
    main()
