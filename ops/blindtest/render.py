"""一个和后端完全无关的截图渲染器。

为什么要自己写：如果用 `domain::chart::raster` 或者 `svg_with_match` 去画，那这
场盲测测的就是「后端画的图后端自己认不认得出来」——一次往返，两头共享同一套像素
约定，赢了也说明不了什么。这里的每一个像素都是另写的，参照物是用户自己那张
1320x2868 的币安 App 截图（data/attachments/.../2f635b4d-…），不是我们的画图代码。

渲染要求「像真的」，不是「像理想的」。所以这里刻意带上了真实截图上的那些脏东西：
顶部状态栏和标题栏、右侧价格轴、底部时间轴、三条均线、成交量副图、悬浮按钮、
水印、非整数缩放、JPEG 二次压缩。它们每一项都可能让解析器少认几根蜡烛，而那正是
要量的东西。

只用 PIL 的 Image/ImageDraw 当光栅器（画矩形、画线、写字、缩放、编码），没有用任何
K 线库：mplfinance 那类库会替你决定蜡烛宽度、留白和坐标轴，而这些恰恰是本测试要
自己控制的变量。
"""

from __future__ import annotations

import math
import os
import random
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone

from PIL import Image, ImageDraw, ImageFont

# 机身尺寸。第一项就是用户那张真实截图的分辨率。
FRAMES = {
    "phone_portrait": (1320, 2868),
    "phone_portrait_small": (1170, 2532),
    "phone_landscape": (2868, 1320),
    "tablet": (2048, 1536),
    "desktop_hd": (1920, 1080),
    "desktop_qhd": (2560, 1440),
    "desktop_wide": (3200, 1400),
}

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
]


# 图表里的文字全是 ASCII，所以主字体用 Arial 就够；但 Track A 的对照图上要写
# 「用户原图（真值未知）」这种中文标题，Arial 里没有汉字，画出来是一排豆腐块。
# 那张图是要交出去给人看的，所以单独留一条中文字体链给它。
_CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def _font_cjk(size: int):
    for path in _CJK_FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return _font(size)


def _font(size: int):
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


@dataclass
class Theme:
    name: str
    bg: tuple
    pane: tuple
    grid: tuple
    text: tuple
    dim: tuple
    up: tuple
    down: tuple


LIGHT = Theme(
    "light",
    bg=(255, 255, 255),
    pane=(250, 250, 252),
    grid=(238, 240, 244),
    text=(24, 26, 32),
    dim=(132, 142, 156),
    up=(14, 203, 129),
    down=(246, 70, 93),
)
DARK = Theme(
    "dark",
    bg=(24, 26, 32),
    pane=(30, 33, 41),
    grid=(43, 47, 57),
    text=(234, 236, 241),
    dim=(132, 142, 156),
    up=(46, 189, 133),
    down=(246, 70, 93),
)

# 均线配色。前三组是中性色（黄/紫/蓝），在 chart_match 的 `color()` 里都落到 0 类，
# 不会和蜡烛连成一块；最后一组是照着用户那张真实截图取的——它的 MA30 是粉红、
# MA120 是橙红，两条都会被判成「红」类，一旦碰到红蜡烛就会在连通域里跟蜡烛焊死，
# 整条线加上被它穿过的每一根红蜡烛变成一个超宽的连通块，然后被宽度上限一起扔掉。
# 这是真实截图上确实存在的坑，所以必须留一档去踩它。
MA_PALETTES = {
    "neutral": [(240, 185, 11), (155, 89, 182), (52, 152, 219)],
    "neutral_warm": [(240, 185, 11), (0, 188, 212), (149, 117, 205)],
    "binance_app": [(224, 64, 160), (214, 84, 64), (150, 60, 190)],
}


@dataclass
class Style:
    """一次 trial 的渲染条件。整份都会写进 report.json，好让人回头能对上是哪一档拖了后腿。"""

    theme: str = "light"
    frame: str = "desktop_qhd"
    frame_w: int = 0
    frame_h: int = 0
    pitch: float = 0.0           # 蜡烛中心间距（原始像素）
    body_w: int = 0              # 实心部分宽度
    wick_w: int = 1
    gap: float = 0.0
    price_axis: bool = True
    price_axis_w: int = 0
    time_axis: bool = True
    time_axis_h: int = 0
    volume_pane: bool = False
    indicator_pane: bool = False
    ma_palette: str = "neutral"
    ma_periods: tuple = (7, 25, 99)
    ma_count: int = 3
    watermark: bool = False
    floating_button: bool = False
    supersample: int = 1         # 2 = 先画两倍再缩，等价于开抗锯齿
    downscale: float = 1.0       # 非整数缩放
    jpeg: bool = False
    jpeg_quality: int = 90
    chrome: bool = True          # 顶部/底部的 App 外壳
    cramped: bool = False        # 故意把太多蜡烛塞进竖屏手机
    width_frac: float = 0.0      # 蜡烛区占画面宽度的比例
    side_panel: bool = False     # 右边那块留白是否填成盘口
    log_scale: bool = False
    final_w: int = 0
    final_h: int = 0
    chart_frac: float = 0.0      # 蜡烛区占整张图高度的比例，解释力很强的一个量

    def to_json(self):
        d = asdict(self)
        d["ma_periods"] = list(self.ma_periods)
        return d


def sample_style(rng: random.Random, bars: int, force: dict | None = None) -> Style:
    """随机抽一组渲染条件，并保证蜡烛画得下。

    「画得下」这件事和「手机竖屏」是有冲突的：256 根日线在 1320 宽的竖屏里，
    间距只有 4 像素出头，而解析器在 detect() 一开始会把整张图缩到 1600 以内，
    竖屏 1320x2868 缩完只剩 736 宽——4 像素的间距会变成 2.3 像素，相邻蜡烛在
    dedup 那一步直接被当成同一根合掉。所以默认按根数挑一个放得下的机身，另外
    留 `cramped` 一档故意不挑，专门去量这条上限。
    """
    s = Style()
    force = force or {}
    s.theme = force.get("theme") or rng.choice(["light", "dark"])
    s.cramped = force.get("cramped", rng.random() < 0.22)

    # 蜡烛区占画面宽度的比例。真实 App 从来不是画满的：左边留白、右边被价格轴吃掉，
    # 横屏还会被侧栏挤。这个比例同时也是让「实心宽度」真正有变化的唯一旋钮——
    # 间距 = 可用宽度 / 根数，根数由真值窗口定死，不动宽度就只能画出一种粗细。
    # 竖屏基本占满，横屏才可能让出右边一条给盘口。
    s.width_frac = round(rng.uniform(0.70, 0.98), 3)

    fitting = [
        n
        for n in FRAMES
        if 6.0 <= FRAMES[n][0] * s.width_frac / bars <= 28.0
    ]
    if s.cramped:
        chosen = rng.choice(["phone_portrait", "phone_portrait_small"])
    elif fitting:
        chosen = rng.choice(fitting)
    else:
        # 放不下就只能挑最宽的那块画布，然后如实记下这是一次「挤」的渲染。
        chosen = max(FRAMES, key=lambda n: FRAMES[n][0])
        s.cramped = True
    s.frame = force.get("frame", chosen)
    s.frame_w, s.frame_h = FRAMES[s.frame]
    # 竖屏画布上没有盘口可放，右边留一大条就只是空地——把比例收窄，让蜡烛几乎占满。
    if s.frame_h > s.frame_w:
        s.width_frac = round(min(0.99, max(s.width_frac, rng.uniform(0.86, 0.99))), 3)

    s.price_axis = rng.random() < 0.88
    s.price_axis_w = rng.randint(72, 128) if s.price_axis else 0
    s.time_axis = rng.random() < 0.92
    s.time_axis_h = rng.randint(30, 56) if s.time_axis else 0
    s.volume_pane = rng.random() < 0.55
    s.indicator_pane = s.volume_pane and rng.random() < 0.45
    s.chrome = rng.random() < 0.78
    s.ma_count = rng.choice([0, 2, 3, 3])
    s.ma_palette = rng.choice(["neutral", "neutral_warm", "binance_app"])
    s.ma_periods = rng.choice([(7, 25, 99), (5, 10, 30), (30, 120, 200)])
    s.watermark = rng.random() < 0.35
    s.floating_button = rng.random() < 0.45
    s.supersample = 2 if rng.random() < 0.5 else 1
    s.downscale = round(rng.uniform(0.62, 1.0), 3)
    s.jpeg = rng.random() < 0.5
    s.jpeg_quality = rng.randint(70, 92)
    s.log_scale = rng.random() < 0.18
    for k, v in force.items():
        setattr(s, k, v)
    if "frame" in force:
        s.frame_w, s.frame_h = FRAMES[s.frame]
    return s


def _ma(closes, period):
    out = []
    acc = 0.0
    for i, c in enumerate(closes):
        acc += c
        if i >= period:
            acc -= closes[i - period]
        out.append(acc / min(i + 1, period) if i + 1 >= period else None)
    return out


def _nice_prices(lo, hi, n=6):
    span = hi - lo
    if span <= 0:
        return [lo]
    step = span / (n - 1)
    mag = 10 ** math.floor(math.log10(step))
    for mult in (1, 2, 2.5, 5, 10):
        if step <= mag * mult:
            step = mag * mult
            break
    first = math.ceil(lo / step) * step
    out = []
    v = first
    while v <= hi + step * 0.01 and len(out) < 12:
        out.append(v)
        v += step
    return out


def _mix(a, b, t: float):
    """把 b 按 t 的比例掺进 a。盘口的深度条是浅色的，不是纯红纯绿。"""
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(bars, style: Style, symbol: str, interval: str, *, seed: int = 0) -> bytes:
    """把一段真实 bars 画成一张「像手机截图」的图，返回编码后的字节。"""
    rng = random.Random(seed)
    theme = DARK if style.theme == "dark" else LIGHT
    ss = style.supersample
    W, H = style.frame_w * ss, style.frame_h * ss

    im = Image.new("RGB", (W, H), theme.bg)
    d = ImageDraw.Draw(im)

    # ---- 外壳：顶部状态栏/标题/价格块/周期页签，底部导航条 ----
    portrait = style.frame_h > style.frame_w
    if style.chrome:
        head_h = int(H * (0.24 if portrait else 0.13))
        # 底部导航条只有竖屏手机才有。给一张 2560x1440 的桌面截图配一条
        # Markets/Trade/Futures/Wallet，那是我在造一个不存在的设备。
        foot_h = int(H * 0.075) if portrait else 0
    else:
        head_h = int(H * 0.035)
        foot_h = int(H * 0.01)

    # 字号跟着**短边**走，不跟着宽走：3200x1400 那种横屏按宽算出来的字号能有一百多
    # 像素高，顶栏几行字会糊成一团——那不是「真实的杂乱」，那是我画错了。
    base = max(12, int(min(style.frame_w, style.frame_h) / 46)) * ss
    f_big = _font(int(base * 1.7))
    f_mid = _font(base)
    f_small = _font(int(base * 0.78))

    if style.chrome:
        # 顶栏按「行」往下码，每行高度都从 base 推出来，最后让 head_h 至少容得下
        # 这些行。之前是按 head_h 的百分比定位的，横屏 head_h 一小就全糊在一起。
        pad = int(base * 0.5)
        y_status = pad
        y_pair = y_status + int(base * 1.5)
        y_price = y_pair + int(base * 2.4)
        y_tabs = y_price + int(base * 2.4)
        # 顶栏高度就等于内容高度，不再按画面比例硬撑。撑出来的那一条空白在竖屏上
        # 能占掉四分之一个屏幕，真截图里那块地方是买卖盘和下单按钮，不是白的。
        head_h = y_tabs + int(base * 2.6)
    d.rectangle([0, 0, W, head_h], fill=theme.bg)
    if style.chrome:
        d.text((int(W * 0.05), y_status), "09:41", font=f_small, fill=theme.text)
        d.text((int(W * 0.88), y_status), "100%", font=f_small, fill=theme.dim)
        pair = symbol.replace("USDT", "/USDT") if symbol.endswith("USDT") else symbol
        d.text((int(W * 0.05), y_pair), pair, font=f_big, fill=theme.text)
        last = bars[-1]["close"]
        rising = bars[-1]["close"] >= bars[0]["open"]
        d.text((int(W * 0.05), y_price), f"{last:,.4g}", font=f_big,
               fill=theme.up if rising else theme.down)
        # 涨跌幅跟最新价同一行、排在右边，不再压在它下面。
        d.text((int(W * 0.05) + int(base * 7.0), y_price + int(base * 0.5)),
               f"{'+' if rising else '-'}"
               f"{abs(last - bars[0]['open']) / bars[0]['open'] * 100:.2f}%",
               font=f_mid, fill=theme.up if rising else theme.down)
        # 周期页签一行，选中的那个高亮——OCR 认周期靠的就是这一行。
        tabs = ["15m", "30m", "1h", "4h", "1d", "1w"]
        if interval not in tabs:
            tabs[2] = interval
        x = int(W * 0.05)
        for t in tabs:
            selected = t == interval
            tw = int(base * 2.6)
            if selected:
                d.rounded_rectangle(
                    [x - base // 3, y_tabs - int(base * 0.35), x + tw, y_tabs + int(base * 1.5)],
                    radius=base // 2, fill=theme.grid)
            d.text((x, y_tabs), t, font=f_mid,
                   fill=theme.text if selected else theme.dim)
            x += tw + int(base * 0.9)

    if style.chrome and foot_h > 0:
        d.rectangle([0, H - foot_h, W, H], fill=theme.pane)
        d.line([0, H - foot_h, W, H - foot_h], fill=theme.grid, width=ss)
        for i, label in enumerate(["Markets", "Trade", "Futures", "Wallet"]):
            d.text(
                (int(W * (0.08 + i * 0.23)), H - foot_h + foot_h // 3),
                label,
                font=f_small,
                fill=theme.dim,
            )

    # ---- 面板划分 ----
    body_top = head_h + int(base * 0.6)
    body_bottom = H - foot_h - int(base * 0.4)
    avail_h = body_bottom - body_top
    vol_h = int(avail_h * 0.17) if style.volume_pane else 0
    ind_h = int(avail_h * 0.17) if style.indicator_pane else 0
    time_h = style.time_axis_h * ss
    price_h = avail_h - vol_h - ind_h - time_h
    axis_w = style.price_axis_w * ss
    plot_w = int(W * (style.width_frac or 0.9))
    plot_w = min(plot_w, W - axis_w - int(W * 0.02))
    left = int(W * 0.012)
    right = left + plot_w
    if right + axis_w > W:
        right = W - axis_w - int(W * 0.008)
        plot_w = right - left

    n = len(bars)
    pitch = plot_w / n
    gap = max(1.0 * ss, pitch * rng.uniform(0.18, 0.30))
    body_w = max(1, int(round(pitch - gap)))
    wick_w = max(1, min(3 * ss, int(round(body_w * rng.uniform(0.14, 0.28)))))
    style.pitch = round(pitch / ss, 2)
    style.body_w = max(1, int(round(body_w / ss)))
    style.wick_w = max(1, int(round(wick_w / ss)))
    style.gap = round(gap / ss, 2)

    hi = max(b["high"] for b in bars)
    lo = min(b["low"] for b in bars)
    pad = (hi - lo) * 0.06 or 1.0
    top_v, bot_v = hi + pad, lo - pad
    y0 = body_top + int(base * 1.2)
    y1 = body_top + price_h - int(base * 0.4)

    if style.log_scale and bot_v > 0:
        lt, lb = math.log(top_v), math.log(bot_v)

        def ypix(v):
            v = max(v, 1e-12)
            return y1 - (math.log(v) - lb) / (lt - lb) * (y1 - y0)
    else:
        def ypix(v):
            return y1 - (v - bot_v) / (top_v - bot_v) * (y1 - y0)

    # ---- 网格 ----
    ticks = _nice_prices(bot_v, top_v)
    for v in ticks:
        yy = ypix(v)
        d.line([left, yy, right, yy], fill=theme.grid, width=ss)
    for i in range(1, 6):
        xx = left + plot_w * i / 6
        d.line([xx, y0, xx, y1], fill=theme.grid, width=ss)

    # ---- 蜡烛 ----
    for i, b in enumerate(bars):
        cx = left + pitch * (i + 0.5)
        up = b["close"] >= b["open"]
        col = theme.up if up else theme.down
        bx0 = int(round(cx - body_w / 2))
        bx1 = bx0 + body_w - 1
        yh, yl = ypix(b["high"]), ypix(b["low"])
        yo, yc = ypix(b["open"]), ypix(b["close"])
        bt, bb = min(yo, yc), max(yo, yc)
        if bb - bt < 1:  # 十字星：实心部分至少留一行，否则连通域里没有「体」
            bt, bb = bt - 0.5, bt + 0.5
        wx0 = int(round(cx - wick_w / 2))
        d.rectangle([wx0, int(round(yh)), wx0 + wick_w - 1, int(round(yl))], fill=col)
        d.rectangle([bx0, int(round(bt)), bx1, int(round(bb))], fill=col)

    # ---- 均线 ----
    closes = [b["close"] for b in bars]
    palette = MA_PALETTES[style.ma_palette]
    for k in range(style.ma_count):
        period = style.ma_periods[k % len(style.ma_periods)]
        series = _ma(closes, period)
        pts = [
            (left + pitch * (i + 0.5), ypix(v))
            for i, v in enumerate(series)
            if v is not None
        ]
        if len(pts) > 2:
            d.line(pts, fill=palette[k % len(palette)], width=max(1, int(1.6 * ss)))

    # ---- 右侧价格轴 ----
    if style.price_axis:
        ax = right + int(W * 0.004)
        d.rectangle([right, body_top, min(W, right + axis_w + int(W * 0.006)),
                     body_top + price_h], fill=theme.bg)
        for v in ticks:
            d.text((ax, ypix(v) - base * 0.5), f"{v:,.6g}", font=f_small, fill=theme.dim)
        # 最新价那个小药丸，真截图上一直都有
        lastc = bars[-1]["close"]
        yy = ypix(lastc)
        col = theme.up if bars[-1]["close"] >= bars[-1]["open"] else theme.down
        d.rectangle([ax - int(base * 0.2), yy - base * 0.7,
                     min(W, right + axis_w + int(W * 0.004)), yy + base * 0.7], fill=col)
        d.text((ax, yy - base * 0.5), f"{lastc:,.6g}", font=f_small, fill=(255, 255, 255))

    # ---- 右边剩下的那一条：盘口 ----
    # 蜡烛区没占满宽度时，真实截图里那块地方不是白的，是买卖盘。留白会让检测器的
    # ROI 白白吃进一大片空地；补上盘口既更像真的，也是对颜色分类器的一次真考验——
    # 那一列红绿小条正是最容易被误认成蜡烛的东西。
    book_left = right + axis_w + int(W * 0.01)
    # 只有横屏才配盘口。竖屏手机上盘口在图的下面或另一个页签里，横着塞一列
    # 价格和数量，两列字会挤在一起——那是我画错了，不是真实的杂乱。
    style.side_panel = (not portrait) and (W - book_left) > W * 0.10
    if style.side_panel:
        rows = max(6, int(price_h / (base * 1.9)))
        rng_b = random.Random(seed ^ 0x5EED)
        mid_p = bars[-1]["close"]
        for i in range(rows):
            ry = body_top + int(i * price_h / rows)
            ask = i < rows // 2
            col = theme.down if ask else theme.up
            depth = rng_b.uniform(0.15, 1.0)
            d.rectangle([W - int((W - book_left) * depth), ry,
                         W - int(W * 0.004), ry + int(base * 1.2)],
                        fill=_mix(theme.bg, col, 0.18))
            step = (rows // 2 - i) * mid_p * 0.0007
            d.text((book_left, ry), f"{mid_p + step:,.6g}", font=f_small, fill=col)
            d.text((book_left + int((W - book_left) * 0.52), ry),
                   f"{rng_b.uniform(0.1, 900):,.3g}", font=f_small, fill=theme.dim)

    # ---- 底部时间轴 ----
    if style.time_axis:
        ty = body_top + price_h + vol_h + ind_h
        for i in range(5):
            idx = min(n - 1, int(n * i / 5))
            t = datetime.fromtimestamp(bars[idx]["start_ms"] / 1000, tz=timezone.utc)
            fmt = "%m-%d" if interval in ("1d", "3d", "1w") else "%m-%d %H:%M"
            d.text(
                (left + plot_w * i / 5, ty + base * 0.3),
                t.strftime(fmt),
                font=f_small,
                fill=theme.dim,
            )

    # ---- 成交量副图 ----
    if style.volume_pane:
        vtop = body_top + price_h + int(base * 0.5)
        vbot = body_top + price_h + vol_h
        vmax = max(b["volume"] for b in bars) or 1.0
        for i, b in enumerate(bars):
            cx = left + pitch * (i + 0.5)
            col = theme.up if b["close"] >= b["open"] else theme.down
            h = (b["volume"] / vmax) * (vbot - vtop)
            bx0 = int(round(cx - body_w / 2))
            d.rectangle([bx0, int(vbot - h), bx0 + body_w - 1, int(vbot)], fill=col)
        d.text((left, vtop - base), "VOL", font=f_small, fill=theme.dim)

    # ---- 指标副图（MACD 那一格；柱子同样共用一条零轴）----
    if style.indicator_pane:
        itop = body_top + price_h + vol_h + int(base * 0.4)
        ibot = body_top + price_h + vol_h + ind_h
        mid = (itop + ibot) / 2
        fast, slow = _ma(closes, 12), _ma(closes, 26)
        hist = [
            (f - s) if (f is not None and s is not None) else 0.0
            for f, s in zip(fast, slow)
        ]
        hmax = max(abs(v) for v in hist) or 1.0
        for i, v in enumerate(hist):
            cx = left + pitch * (i + 0.5)
            col = theme.up if v >= 0 else theme.down
            h = v / hmax * (ibot - itop) / 2
            bx0 = int(round(cx - body_w / 2))
            d.rectangle([bx0, int(min(mid, mid - h)), bx0 + body_w - 1, int(max(mid, mid - h))], fill=col)
        d.text((left, itop - base), "MACD(12,26,9)", font=f_small, fill=theme.dim)

    # ---- 盖在图上的东西：水印 / 悬浮按钮 ----
    if style.watermark:
        layer = Image.new("RGBA", im.size, (0, 0, 0, 0))
        wd = ImageDraw.Draw(layer)
        wf = _font(int(base * 3.2))
        wd.text(
            (int(W * 0.28), int((y0 + y1) / 2 - base)),
            "BINANCE",
            font=wf,
            fill=(theme.text[0], theme.text[1], theme.text[2], 46),
        )
        im = Image.alpha_composite(im.convert("RGBA"), layer).convert("RGB")
        d = ImageDraw.Draw(im)
    if style.floating_button:
        r = int(base * 1.6)
        bx, by = left + int(base * 1.4), y1 - int(base * 2.2)
        d.ellipse([bx, by, bx + r * 2, by + r * 2], fill=theme.pane, outline=theme.grid, width=ss)
        d.text((bx + r * 0.55, by + r * 0.5), "⤢", font=f_mid, fill=theme.dim)

    # ---- 缩放与编码 ----
    if ss != 1:
        im = im.resize((style.frame_w, style.frame_h), Image.LANCZOS)
    if style.downscale != 1.0:
        nw = max(64, int(style.frame_w * style.downscale))
        nh = max(64, int(style.frame_h * style.downscale))
        im = im.resize((nw, nh), Image.BILINEAR if rng.random() < 0.5 else Image.LANCZOS)
    style.final_w, style.final_h = im.size
    style.chart_frac = round((y1 - y0) / ss / style.frame_h, 3)

    import io as _io

    buf = _io.BytesIO()
    if style.jpeg:
        im.save(buf, "JPEG", quality=style.jpeg_quality, subsampling=2)
    else:
        im.save(buf, "PNG", optimize=False)
    return buf.getvalue()


def render_reference(bars, symbol: str, interval: str, width=1100, height=700) -> Image.Image:
    """给人看的干净版：Track A 的并排图右半边用它，不参加任何检索。"""
    theme = LIGHT
    im = Image.new("RGB", (width, height), theme.bg)
    d = ImageDraw.Draw(im)
    f = _font(18)
    left, right = 14, width - 110
    y0, y1 = 46, height - 44
    hi = max(b["high"] for b in bars)
    lo = min(b["low"] for b in bars)
    pad = (hi - lo) * 0.05 or 1.0
    top_v, bot_v = hi + pad, lo - pad

    def ypix(v):
        return y1 - (v - bot_v) / (top_v - bot_v) * (y1 - y0)

    for v in _nice_prices(bot_v, top_v):
        yy = ypix(v)
        d.line([left, yy, right, yy], fill=theme.grid)
        d.text((right + 8, yy - 9), f"{v:,.6g}", font=f, fill=theme.dim)
    n = len(bars)
    pitch = (right - left) / n
    bw = max(1, int(pitch * 0.7))
    for i, b in enumerate(bars):
        cx = left + pitch * (i + 0.5)
        col = theme.up if b["close"] >= b["open"] else theme.down
        d.rectangle([int(cx - 0.5), ypix(b["high"]), int(cx + 0.5), ypix(b["low"])], fill=col)
        bt, bb = sorted((ypix(b["open"]), ypix(b["close"])))
        d.rectangle([int(cx - bw / 2), bt, int(cx - bw / 2) + bw - 1, max(bb, bt + 1)], fill=col)
    t0 = datetime.fromtimestamp(bars[0]["start_ms"] / 1000, tz=timezone.utc)
    t1 = datetime.fromtimestamp(bars[-1]["end_ms"] / 1000, tz=timezone.utc)
    d.text((left, 14), f"{symbol} {interval}  {n} bars", font=f, fill=theme.text)
    d.text(
        (left, height - 32),
        f"{t0:%Y-%m-%d %H:%M} → {t1:%Y-%m-%d %H:%M} UTC",
        font=f,
        fill=theme.dim,
    )
    return im
