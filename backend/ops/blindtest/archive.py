"""从币安官方月度归档取真实 K 线。

只走 `data.binance.vision` 的月档，不走 REST——这是项目里的一条硬规矩（见
docs/history-search.md「取数只走 data.binance.vision 的月度归档」）。盲测本来也
只需要历史上某一段已经收盘的 bars，REST 的分页和限频在这里一点好处都没有。

列名顺序照抄 `adapters/binance_archive.rs::parse_klines`：0 open_time(ms)、
1 open、2 high、3 low、4 close、5 volume、6 close_time(ms)，并且一根 bar 的
`end` 是 `close_time + 1ms`——后端就是这么算的，特征表里的 `end_at` 也是这么来
的，差这 1 毫秒就会把窗口的最后一根切掉。

zip 缓存在 scratchpad 里。产品侧「公共行情只在内存」的原则不适用于这里：这是
测试脚手架，缓存落在仓库之外、产品存储目录之外，跑完可以整个删掉。
"""

from __future__ import annotations

import io
import os
import ssl
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

INTERVAL_SECONDS = {
    "1m": 60,
    "3m": 180,
    "5m": 300,
    "15m": 900,
    "30m": 1800,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "6h": 21600,
    "8h": 28800,
    "12h": 43200,
    "1d": 86400,
    "3d": 259200,
    "1w": 604800,
}

_MARKET_PRODUCT = {"usd_m": "um", "coin_m": "cm"}


class ArchiveMissing(Exception):
    """币安自己就没有这个月档。新币、已下架、偶尔漏传，都是常态不是错误。"""


def _segment(interval: str) -> str:
    # 归档目录里只有月线的写法与对外不同（`1M` -> `1mo`），别的原样。
    return "1mo" if interval == "1M" else interval


def month_keys(market: str, symbol: str, interval: str, start: datetime, end: datetime):
    product = _MARKET_PRODUCT[market]
    seg = _segment(interval)
    cursor = datetime(start.year, start.month, 1, tzinfo=timezone.utc)
    while cursor < end:
        stamp = cursor.strftime("%Y-%m")
        yield (
            f"data/futures/{product}/monthly/klines/{symbol}/{seg}/"
            f"{symbol}-{seg}-{stamp}.zip"
        )
        cursor = (cursor + timedelta(days=32)).replace(day=1)


class Archive:
    """带磁盘缓存的月档取数器。

    缓存键就是归档 key 本身，所以同一个月档在整轮盲测里只会下一次——一轮 120 次
    trial 里同一个品种反复出现是必然的，没有缓存的话光下载就能把这件事拖垮。
    """

    def __init__(self, cache_dir: str, timeout: float = 120.0):
        self.cache_dir = cache_dir
        self.timeout = timeout
        os.makedirs(cache_dir, exist_ok=True)
        self._ctx = ssl.create_default_context()
        self.downloads = 0
        self.cache_hits = 0

    def _cache_path(self, key: str) -> str:
        return os.path.join(self.cache_dir, key.replace("/", "_"))

    def _fetch(self, key: str) -> bytes:
        path = self._cache_path(key)
        miss = path + ".404"
        if os.path.exists(miss):
            raise ArchiveMissing(key)
        if os.path.exists(path):
            self.cache_hits += 1
            with open(path, "rb") as f:
                return f.read()
        url = f"https://data.binance.vision/{key}"
        last = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "scorebook-blindtest/1"})
                with urllib.request.urlopen(req, timeout=self.timeout, context=self._ctx) as r:
                    body = r.read()
                break
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    # 记下这个洞，免得每次 rerun 都再去问一遍同一个不存在的月。
                    open(miss, "wb").close()
                    raise ArchiveMissing(key) from e
                last = e
                time.sleep(1.5 * (attempt + 1))
            except Exception as e:  # 网络抖动：退避重试，别让一次超时毁掉一轮
                last = e
                time.sleep(1.5 * (attempt + 1))
        else:
            raise RuntimeError(f"archive download failed: {key}: {last}")
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        self.downloads += 1
        return body

    def bars(self, market: str, symbol: str, interval: str, start: datetime, end: datetime):
        """返回 `[start, end)` 区间内完整收盘的 bars。

        判据与 `parse_klines` 一样：`open_time >= start` 且 `close_time+1ms <= end`。
        """
        start_ms = int(start.timestamp() * 1000)
        end_ms = int(end.timestamp() * 1000)
        out = []
        for key in month_keys(market, symbol, interval, start, end):
            try:
                blob = self._fetch(key)
            except ArchiveMissing:
                continue
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                names = [n for n in z.namelist() if n.endswith(".csv")]
                if len(names) != 1:
                    raise RuntimeError(f"unexpected archive entries in {key}")
                with z.open(names[0]) as fh:
                    for raw in io.TextIOWrapper(fh, encoding="utf-8"):
                        cells = raw.rstrip("\n").split(",")
                        if len(cells) < 7 or cells[0] in ("open_time", "openTime"):
                            continue
                        at = int(cells[0])
                        to = int(cells[6]) + 1
                        if at < start_ms or to > end_ms:
                            continue
                        out.append(
                            {
                                "start_ms": at,
                                "end_ms": to,
                                "open": float(cells[1]),
                                "high": float(cells[2]),
                                "low": float(cells[3]),
                                "close": float(cells[4]),
                                "volume": float(cells[5]),
                            }
                        )
        out.sort(key=lambda b: b["start_ms"])
        return out
