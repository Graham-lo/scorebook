"""对着隔离实例说话的 HTTP 客户端。

只用 stdlib 的 urllib：盲测脚本多一个第三方依赖，就多一个「跑不起来」的理由，
而这份脚本存在的意义就是别人重跑一遍能得到同样的数。multipart 手写，反正
`/v1/attachments` 只认 `file` / `kind` / `captured_at` 三个字段。

所有写操作都要 `Idempotency-Key`（`http/src/lib.rs::key`），少一个就是 400；
响应统一裹在 `{"data":…,"meta":…}` 里，所以这里一律先剥 `data`。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid


class ApiError(Exception):
    def __init__(self, status: int, code: str, body: str):
        super().__init__(f"HTTP {status} {code}: {body[:400]}")
        self.status = status
        self.code = code
        self.body = body


class Client:
    def __init__(self, base: str, token: str, timeout: float = 180.0):
        self.base = base.rstrip("/")
        self.token = token
        self.timeout = timeout

    # ---- 底层 ----

    def _request(self, method: str, path: str, *, body=None, ctype=None, idem=None):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if ctype:
            headers["Content-Type"] = ctype
        if idem:
            headers["Idempotency-Key"] = idem
        req = urllib.request.Request(
            self.base + path, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                payload = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            code = ""
            try:
                code = json.loads(raw).get("error", {}).get("code", "")
            except Exception:
                pass
            raise ApiError(e.code, code, raw) from None
        return payload.get("data", payload)

    def get(self, path):
        return self._request("GET", path)

    def post(self, path, obj, idem=None):
        return self._request(
            "POST",
            path,
            body=json.dumps(obj).encode("utf-8"),
            ctype="application/json",
            idem=idem or str(uuid.uuid4()),
        )

    # ---- 用得上的几个端点 ----

    def health(self):
        return self.get("/v1/health")

    def ready(self):
        return self.get("/v1/ready")

    def upload(self, data: bytes, filename: str, mime: str, kind: str = "scene") -> str:
        boundary = "----sbblind" + uuid.uuid4().hex
        parts = []
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode()
        )
        parts.append(data)
        parts.append(
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n'
            f"{kind}\r\n--{boundary}--\r\n".encode()
        )
        payload = b"".join(parts)
        v = self._request(
            "POST",
            "/v1/attachments",
            body=payload,
            ctype=f"multipart/form-data; boundary={boundary}",
            idem=str(uuid.uuid4()),
        )
        return v["id"]

    def analyze(self, attachment_id: str, region=None, red_up=False):
        body = {"attachment_id": attachment_id, "red_up": red_up}
        if region is not None:
            body["region"] = region
        return self.post("/v1/chart-analyses", body)

    def search(
        self,
        attachment_id: str,
        *,
        interval: str,
        scope: str = "binance_history",
        limit: int = 30,
        cutoff_at: str | None = None,
        market: str | None = None,
        symbol: str | None = None,
        red_up: bool = False,
        interval_policy: str = "same_interval",
    ):
        # `any_interval` 下 `interval` 必须是 null（chart_match.rs 的契约），
        # 给了值服务端会拒；这里替调用方守住，免得每个调用点各写一遍。
        if interval_policy == "any_interval":
            interval = None
        body = {
            "attachment_id": attachment_id,
            "scope": scope,
            "symbol": symbol,
            "market": market,
            "interval": interval,
            "limit": limit,
            "red_up": red_up,
            "interval_policy": interval_policy,
        }
        if cutoff_at:
            body["cutoff_at"] = cutoff_at
        return self.post("/v1/chart-search/runs", body)

    def poll(self, run_id: str, timeout: float = 300.0, interval: float = 0.5):
        """等一次检索跑完。

        交互队列全局只允许两个作业同时 running，所以排队是常态，等待时间里既有
        真实计算也有排队——两者在报告里要分开说，别把队列延迟算成检索耗时。
        """
        deadline = time.time() + timeout
        queued_until = None
        while True:
            run = self.get(f"/v1/chart-search/runs/{run_id}")
            status = run.get("status")
            if status == "running" and queued_until is None:
                queued_until = time.time()
            if status in ("succeeded", "failed", "cancelled"):
                run["_queue_wait"] = (queued_until - (deadline - timeout)) if queued_until else None
                return run
            if time.time() > deadline:
                run["_timeout"] = True
                return run
            time.sleep(interval)
