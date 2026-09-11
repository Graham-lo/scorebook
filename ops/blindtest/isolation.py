"""把盲测关进一套自己的 PostgreSQL 集群和一对自己的调试进程里。

为什么非要隔离：`scorebook` 那个库是用户真实的交易记录本。盲测要上传一百多张
合成截图、跑一百多次检索、排一百多个作业——这些东西一旦落进去，用户的记录本里
就永远多了一堆本次实验的垃圾，而且没有干净的办法分辨哪些是他自己的。

⚠️ **在同一个 PostgreSQL 实例里开第二个库，不算隔离。**

这不是洁癖，是代码结构决定的：作业租约和维护互斥全靠
`pg_advisory_xact_lock*(hashtextextended($1, k))`——`jobs.rs:31`（键 8，独占）、
`jobs.rs:385` / `history.rs:379` / `settlement.rs:114` / `similarity.rs:70` /
`replay.rs:48` / `exports.rs:156,234`（键 0，共享）、`gc.rs:8` 与
`lifecycle.rs:40`（键 0，**独占**）。键里只有 `owner_id`（有时再拼上队列名），
而 **PostgreSQL 的咨询锁是集群级的，跨 database 共享**。快照又把 `owner_id`
原样抄了过来，于是同一集群里两个库的两个 worker 抢的是同一把锁：盲测这边一次
`gc` 或 `lifecycle` 拿到键 0 的独占锁，线上所有走 `fenced_tx` 的作业就得排队等。
**一个连在同集群任意库上的第二 worker，足以让线上停摆。** 这条结论跟任何具体
事故无关，光看锁的键空间就成立。

至于 2026-09-11 09:32 那次线上 `history.universe` 4h 扇出以 `lease_lost` 死掉、
是不是这个第二 worker 干的——**存疑，别当结论讲**。协调方核过时间线，链条并不
闭合：租约 120 秒（`jobs.rs:142`），失败发生在第二次尝试的第 45.05 秒，租约根本
没到期；`job_attempts` 里没有第三次尝试，说明没人把它抢走；心跳是 +30/+60 秒
（`jobs.rs:178-186`），09:33:07 也不在心跳点上。那次失败是从 `fenced_tx` 在
STEP_BUDGET 让出时冒出来的。阻塞在独占锁上能解释「卡住」，解释不了「这样死」。
所以这里只保留上面那条结构性危险，事故归因留给别人。

于是这一版的隔离做到了集群级：独立容器 `blindtest-pg`、独立端口 55533、独立卷
`blindtest-pgdata`，跟 `scorebook-backend-postgres-1` 只共享磁盘和网卡。咨询锁
空间是真的分开的。

进程这边用 `target/debug/scorebook`，**绝不碰 `target/release`**：那个二进制此刻
正在给用户提供服务，在 macOS 上覆盖一个正在运行的 Mach-O 会直接把它打死。
`cargo build`（debug）写的是另一个目录，安全。

环境变量是**逐条拼出来的，不读仓库的 `.env`**。读 `.env` 的诱惑在于省事，代价
是一个手滑就把 `DATABASE_URL` 指回线上——这正是隔离最怕的失败模式。所以
`Instance.env()` 从一个空 dict 开始，只放它真正需要的几项，并且在 `start()` 里
先把解析出来的 host/port/dbname 打印出来，任何人都能在日志里核对它连的是谁。
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 盲测自己的集群。名字刻意跟线上容器 `scorebook-backend-postgres-1` 拉开距离，
# 防止哪次手抖 docker exec 错了对象。
CONTAINER = "blindtest-pg"
DB = "scorebook_blindtest"
PGPORT = 55533
PGPASSWORD = "blindtest"
IMAGE = "pgvector/pgvector:0.8.2-pg17"
VOLUME = "blindtest-pgdata"

LIVE_CONTAINER = "scorebook-backend-postgres-1"
LIVE_DB = "scorebook"

DATABASE_URL = f"postgres://scorebook:{PGPASSWORD}@127.0.0.1:{PGPORT}/{DB}"


def _psql(container: str, database: str, sql: str, *, quiet=False):
    cmd = [
        "docker", "exec", container, "psql", "-U", "scorebook",
        "-d", database, "-At", "-F", "|", "-c", sql,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 and not quiet:
        raise RuntimeError(f"psql failed: {r.stderr.strip()}")
    return r.stdout.strip()


def query(sql: str):
    """只读地问盲测库。行按 `|` 切开。"""
    out = _psql(CONTAINER, DB, sql)
    return [line.split("|") for line in out.split("\n") if line]


def query_live(sql: str):
    """只读地问线上库。整个套件里线上库只出现在这一个函数里，方便审。"""
    out = _psql(LIVE_CONTAINER, LIVE_DB, sql)
    return [line.split("|") for line in out.split("\n") if line]


def container_running() -> bool:
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and r.stdout.strip() == "true"


def start_container():
    """起盲测集群。已经在跑就不动它——重跑一次实验不该重灌一次快照。"""
    if container_running():
        return
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
    subprocess.run(["docker", "volume", "create", VOLUME], capture_output=True, check=True)
    subprocess.run([
        "docker", "run", "-d", "--name", CONTAINER,
        "-e", f"POSTGRES_PASSWORD={PGPASSWORD}",
        "-e", "POSTGRES_USER=scorebook",
        "-e", f"POSTGRES_DB={DB}",
        "-v", f"{VOLUME}:/var/lib/postgresql/data",
        "-p", f"127.0.0.1:{PGPORT}:5432",
        "--shm-size=1g", IMAGE, "-c", "max_connections=200",
    ], check=True, capture_output=True)
    for _ in range(120):
        r = subprocess.run(
            ["docker", "exec", CONTAINER, "pg_isready", "-U", "scorebook"],
            capture_output=True,
        )
        if r.returncode == 0:
            return
        time.sleep(1)
    raise RuntimeError("blindtest postgres never became ready")


def load_snapshot() -> str:
    """把线上快照灌进盲测集群，返回灌完的时刻。

    时刻要记下来：线上索引此刻还在被别的作业写（月档扇出一小时能加二十万行），
    快照晚一分钟内容就不一样，事后没有这个时间戳就没人能说清这一轮的语料是哪一版。

    用 `pg_dump | psql` 而不是别的：源库上线上 api 和 worker 一直连着，
    `CREATE DATABASE ... TEMPLATE` 要求源库零连接，等于要停服。pg_dump 是只读的。
    """
    dump = subprocess.Popen(
        ["docker", "exec", LIVE_CONTAINER, "pg_dump", "-U", "scorebook",
         "-d", LIVE_DB, "--no-owner", "--no-acl"],
        stdout=subprocess.PIPE,
    )
    load = subprocess.Popen(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "scorebook", "-d", DB, "-q"],
        stdin=dump.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    dump.stdout.close()
    _, err = load.communicate()
    dump.wait()
    if load.returncode != 0:
        raise RuntimeError(f"snapshot load failed: {err.decode()[:2000]}")
    taken = subprocess.run(
        ["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True
    ).stdout.strip()
    neutralise_inherited_jobs()
    return taken


def neutralise_inherited_jobs() -> int:
    """副本继承了线上那些还没跑完的作业。放着不管，盲测的 worker 会抢过来接着跑
    ——比如那个两百品种的月档扇出——既浪费带宽又把队列占死，还会让盲测的检索排在
    它后面等。在副本里全部作废；线上那份原封不动。
    """
    out = _psql(CONTAINER, DB,
                "UPDATE jobs SET status='cancelled',lease_until=NULL,lease_owner=NULL "
                "WHERE status NOT IN ('succeeded','cancelled','failed')")
    return int(out.split()[-1]) if out else 0


def repair_orphan_provenance() -> int:
    """给「已发布但没有来源世代链接」的特征补上链接。**只在副本里做。**

    这不是化妆，补的也不是假证据。线上确实有 2470 条已发布的 1d 特征在
    `generation_features` 里没有对应行；但它们每一条都落在一个同 symbol/interval/
    market、状态 ready、区间覆盖它的世代里——向量是合法的，来源是可证的，丢的只是
    那一行链接。所以这里按覆盖关系把链接补回去，不新建任何世代。

    不补就量不到匹配质量：`attach_market_sources`（history.rs:637）对任何一条查不到
    ready 世代的候选直接抛 `indexed_window_source_unproven`，而那是**整次检索**的
    错误、不是单条候选的——一条孤儿混进三十个候选里，用户那次「按图找」就整个失败。
    孤儿本身是线上的真缺陷，单独报告，不在这里修。
    """
    before = int(query(
        "SELECT count(*) FROM public_market.features f WHERE f.published AND NOT EXISTS("
        "SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id)"
    )[0][0])
    if before == 0:
        return 0
    _psql(CONTAINER, DB, """
INSERT INTO public_market.generation_features(generation_id, feature_id)
SELECT DISTINCT ON (f.id) g.id, f.id
FROM public_market.features f
JOIN public_market.generations g
  ON g.status='ready'
 AND g.body->>'symbol'   = f.symbol
 AND g.body->>'interval' = f.timeframe
 AND g.body->>'market'   = f.market
 AND (g.body->>'source') IN ('rest','monthly_archive')
 AND (g.body->>'start_at')::timestamptz <= f.start_at
 AND (g.body->>'end_at')::timestamptz   >= f.end_at
WHERE f.published
  AND NOT EXISTS (SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id)
ORDER BY f.id, g.published_at DESC NULLS LAST, g.id DESC
""")
    after = int(query(
        "SELECT count(*) FROM public_market.features f WHERE f.published AND NOT EXISTS("
        "SELECT 1 FROM public_market.generation_features l WHERE l.feature_id=f.id)"
    )[0][0])
    if after:
        raise RuntimeError(f"{after} orphan features still unprovable after repair")
    return before


class Instance:
    """跑在 8788 上的第二对 api+worker，连的是盲测集群。"""

    def __init__(self, root: str, port: int = 8788):
        self.root = root
        self.port = port
        self.base = f"http://127.0.0.1:{port}"
        self.storage = os.path.join(root, "storage")
        self.logs = os.path.join(root, "logs")
        self.api = None
        self.worker = None

    def env(self) -> dict:
        """从空的开始拼，**不继承 os.environ、不读仓库 .env**。

        少一条 PATH 之类的东西不影响这两个子命令；多读一次 `.env` 却可能把
        `DATABASE_URL` 指回线上，那是这套东西唯一不能犯的错。
        """
        return {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": os.environ.get("HOME", "/tmp"),
            "DATABASE_URL": DATABASE_URL,
            "SCOREBOOK_BIND": f"127.0.0.1:{self.port}",
            "SCOREBOOK_STORAGE": self.storage,
            "SCOREBOOK_EGRESS_ID": "blind-test",
            "RUST_LOG": "warn,scorebook=info",
            # OCR 和 vision 这两项必须显式给：不给 OCR，`analysis.evidence` 直接抛
            # `ocr_not_configured`，每一次试验都死在分析那一步，一条匹配质量的数据
            # 都拿不到。值是照抄仓库 `.env` 的，但是**逐条抄进来的**，不是 source
            # 整个文件——差别在于 `DATABASE_URL` 绝不会被带进来。
            #
            # ⚠️ 8790 那个 vision 边车是**和线上共用的一个进程**。它是无状态的推理
            # 服务，不碰数据库、没有锁，所以不构成隔离漏洞；但盲测跑起来会给它加一份
            # 负载，线上这段时间的分析延迟会被我拖慢一点。报告里要说这件事。
            "SCOREBOOK_OCR_EXECUTABLE": os.path.join(REPO, "ops", "bin", "scorebook-ocr"),
            "SCOREBOOK_VISION_URL": "http://127.0.0.1:8790",
        }

    def target(self) -> dict:
        """解析出这对进程到底连了谁，供报告里公示。"""
        tail = DATABASE_URL.rsplit("@", 1)[1]
        hostport, dbname = tail.split("/", 1)
        host, port = hostport.split(":")
        return {"host": host, "port": int(port), "database": dbname,
                "container": CONTAINER, "binary": "target/debug/scorebook"}

    def start(self):
        os.makedirs(self.storage, exist_ok=True)
        os.makedirs(self.logs, exist_ok=True)
        env = self.env()
        binary = os.path.join(REPO, "target", "debug", "scorebook")
        if not os.path.exists(binary):
            raise RuntimeError("target/debug/scorebook missing; run `cargo build --bin scorebook`")
        t = self.target()
        print(f"[isolation] debug api+worker -> {t['host']}:{t['port']}/{t['database']} "
              f"({t['container']}), binary {t['binary']}", flush=True)
        for name in ("serve", "worker"):
            log = open(os.path.join(self.logs, f"{name}.log"), "ab")
            p = subprocess.Popen([binary, name], cwd=REPO, env=env, stdout=log, stderr=log)
            setattr(self, "api" if name == "serve" else "worker", p)
            time.sleep(0.5)
        for _ in range(180):
            try:
                urllib.request.urlopen(self.base + "/v1/health", timeout=2).read()
                return
            except Exception:
                time.sleep(0.5)
        raise RuntimeError("isolated api never became healthy")

    def stop(self):
        for p in (self.worker, self.api):
            if p is None or p.poll() is not None:
                continue
            p.send_signal(signal.SIGTERM)
        for p in (self.worker, self.api):
            if p is None:
                continue
            try:
                p.wait(timeout=20)
            except Exception:
                p.kill()

    @staticmethod
    def stop_by_port(port: int):
        """接管一个不是本进程拉起来的实例时用。按端口找 PID，比记 PID 稳。"""
        r = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True)
        for pid in r.stdout.split():
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception:
                pass


def teardown_container(remove_volume: bool = True):
    """停掉并删掉盲测集群。整套实验不该在机器上留下任何长期存在的东西。"""
    subprocess.run(["docker", "rm", "-f", CONTAINER], capture_output=True)
    if remove_volume:
        subprocess.run(["docker", "volume", "rm", VOLUME], capture_output=True)


def discard_storage(root: str):
    shutil.rmtree(os.path.join(root, "storage"), ignore_errors=True)
