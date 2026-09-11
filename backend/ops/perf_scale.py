"""刻舟求剑要的「任意品种、任意周期」有多大，这台机器撑到哪一级为止。

这个脚本回答两件事，两件都必须是量出来的，不是估出来的：

1. 现在这个九万行的公共索引，检索到底走不走 HNSW。行数这么少的时候顺序扫也
   只要几十毫秒，所以「快」根本不能证明索引在用；三个索引都是带表达式转型的
   部分索引（`(embedding)::vector(192)` + `model_id=... AND published`），谓词
   或者转型只要对不上，PostgreSQL 就静静地不用它，等到行数上去才暴露。所以这
   里把 `chart_search/repository.rs` 里那条 SQL 原样抠出来跑
   `EXPLAIN (ANALYZE, BUFFERS)`，逐个分区确认扫的是 `*_embedding_idx2`。
2. 把行数一级一级加上去（100k → 500k → 2M → 8M），量建索引耗时、索引与表的大
   小、ANN 延迟分位数，以及最关键的 recall@10——对着同一批数据的精确顺序扫
   比。延迟涨得不多而 recall 悄悄掉下去，是这类索引最常见也最难发现的坏法。

向量怎么造，决定了这一整页数字值不值得信。纯高斯随机向量对 HNSW 来说太容易
（各向同性、彼此距离都差不多，图一建好谁都找得到），拿它量出来的 recall 和延
迟是往好看里骗人的。这里改成：把真库里那批 candle-geometry-v2 向量整批拉出来
当种子，合成向量是「随机取两条真向量做凸组合 + 一点噪声 + 重新归一化」。这保
住了真实流形的局部结构（两条真向量中间那个点仍然落在数据聚集的地方），但它仍
然**不是**真数据：它造不出真数据里没有的新聚类，真实窗口之间那种 STRIDE=4 造
成的近乎重复也被削弱了。结论里必须把这一条写明白。

约束：所有写操作只发生在临时库 `scorebook_perf_<hex>` 上，schema 用项目真实的
migrations 建（`target/debug/scorebook migrate`），跑完无论成功、失败还是
Ctrl-C 都 DROP 掉。线上库全程只读——只有 SELECT 和 EXPLAIN。
"""

import argparse
import atexit
import json
import math
import os
import pathlib
import random
import re
import signal
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
# 生产那条 ANN SQL 只有一份来源。从 Rust 里抠出来而不是抄一遍，是为了让这个脚本
# 在查询被改动之后跟着变，而不是安安静静地量一条已经不存在的查询。
REPOSITORY = ROOT / "crates/infrastructure/src/application/chart_search/repository.rs"
ANN_SETTINGS = ROOT / "crates/infrastructure/src/adapters/ann.rs"
DIMENSIONS = 192
MODEL = "candle-geometry-v2"
RENDER_VERSION = "ohlc-geometry-resample64-v2"
# 真库 1d 分区里 64/128/256 三档窗口的实际比例：34516 / 27828 / 17030。
TIER_64, TIER_128 = 0.435, 0.351
SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200,
           "4h": 14400, "6h": 21600, "8h": 28800, "12h": 43200, "1d": 86400, "3d": 259200,
           "1w": 604800, "1M": 2592000}
WEIGHT_LEVELS = 16


def public_query():
    """把 public_candidates 里那条 SQL 原样取出来。"""
    source = REPOSITORY.read_text()
    match = re.search(r'"(WITH candidates AS MATERIALIZED \(SELECT id,market,symbol,timeframe.*?LIMIT 1000)"', source)
    if not match:
        raise SystemExit("public_candidates 的 SQL 变了形状，先把这里的正则对齐再量。")
    return match.group(1)


def ann_locals():
    """ann.rs 里那几条 SET LOCAL 就是生产的检索参数，照抄，不另立一套。"""
    return re.findall(r'"SET LOCAL ([^"\n]+)"', ANN_SETTINGS.read_text())


def bind(query, vector, timeframe="'1h'", cutoff="now()", symbol="NULL", market="NULL"):
    """把 $1..$7 换成字面量。`vector` 允许传 '$1'，那一条就留给 EXECUTE ... USING。"""
    literals = {"$1": vector, "$2": cutoff, "$3": symbol, "$4": market, "$5": timeframe,
                "$6": "ARRAY[64,128,256]", "$7": "'{}'::uuid[]"}
    for key in sorted(literals, key=lambda k: -len(k)):
        query = query.replace(key, literals[key])
    return query


class Postgres:
    """所有 SQL 都从 docker exec 走：这台机器上没有 psql 客户端，也不该为了跑一次性能测试装一个。"""

    def __init__(self, container, user):
        self.container = container
        self.user = user

    def command(self, database, tuples):
        value = ["docker", "exec", "-i", self.container, "psql", "-U", self.user, "-d", database,
                 "--no-psqlrc", "-q", "-v", "ON_ERROR_STOP=1"]
        return value + (["-At"] if tuples else []) + ["-f", "-"]

    def run(self, database, script, tuples=True, timeout=None, notices=False):
        value = subprocess.run(self.command(database, tuples), input=script, text=True, timeout=timeout,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if value.returncode:
            raise RuntimeError((value.stderr or "")[-4000:])
        return ((value.stderr if notices else value.stdout) or "").strip()

    def run_file(self, database, path, timeout=None):
        """几百 MB 的 COPY 数据不经过 Python 的内存，直接把文件接到 psql 的 stdin 上。"""
        with path.open("rb") as handle:
            value = subprocess.run(self.command(database, True), stdin=handle, timeout=timeout,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if value.returncode:
            raise RuntimeError((value.stderr or "")[-4000:])
        return (value.stdout or "").strip()

    def rows(self, database, sql):
        return [line.split("|") for line in self.run(database, sql).splitlines() if line]


def free_bytes(container):
    """临时库和线上库住在同一个卷上：每上一级之前先看盘，宁可停梯子也不能把用户的盘写满。"""
    out = subprocess.run(["docker", "exec", container, "df", "-k", "/var/lib/postgresql/data"],
                         text=True, stdout=subprocess.PIPE, check=True).stdout.splitlines()[-1]
    return int(out.split()[3]) * 1024


def shm_bytes(container):
    """容器的 /dev/shm 有多大。pgvector 的并行建索引会一次性申请 maintenance_work_mem
    那么大的一段 DSM（posix 实现就落在 /dev/shm 上），比这里小就直接报
    「could not resize shared memory segment」而不是退化成串行——这一条把这台机器上
    能一次装进内存的图钉死在 1GB 以内，是真实的部署上限，不是调参偏好。"""
    line = subprocess.run(["docker", "exec", container, "df", "-k", "/dev/shm"],
                          stdout=subprocess.PIPE, text=True, check=True).stdout.splitlines()[-1]
    return int(line.split()[3]) * 1024


def parse_size(text):
    unit = {"KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3}[text[-2:].upper()]
    return int(text[:-2]) * unit


def migrate(database, url_base):
    """schema、分区和索引定义必须和生产逐字一致，所以走项目自己的 migrations，不手写简化表。"""
    binary = ROOT / "target/debug/scorebook"
    if not binary.exists():
        raise SystemExit("target/debug/scorebook 不在。release 那个二进制正在给用户服务，不许重建；"
                         "先 cargo build（debug）再来。")
    environment = dict(os.environ, DATABASE_URL=f"{url_base}/{database}",
                       SCOREBOOK_STORAGE=str(ROOT / "data"))
    environment.pop("SCOREBOOK_VISION_URL", None)
    value = subprocess.run([str(binary), "migrate"], env=environment, cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if value.returncode:
        sys.stderr.write(value.stderr[-2000:] + "\n")
        raise RuntimeError("migrate 失败")
    return "target/debug/scorebook migrate"


def load_seed(pg, database, seed_path, limit, work):
    """真向量整批灌进临时库当种子。COPY ... FROM STDIN 的数据跟在脚本后面走同一根 stdin。"""
    script = work / "seed_copy.sql"
    used = 0
    with script.open("w") as out, seed_path.open() as handle:
        out.write("CREATE TABLE perf_seed(i int PRIMARY KEY, embedding vector(192));\n")
        out.write("COPY perf_seed(i,embedding) FROM STDIN;\n")
        for i, line in enumerate(handle):
            if i >= limit:
                break
            out.write(f"{i}\t{line.strip()}\n")
            used = i + 1
        out.write("\\.\n")
    pg.run_file(database, script)
    return used


def load_helpers(pg, database, noise, sigma, mix_low, mix_high, rng):
    """噪声向量和权重向量。

    pgvector 没有「标量乘向量」这个算子，只有逐元素的 vector*vector，所以凸组合的
    权重得做成一条每个分量都等于 w 的常量向量。顺手把 w 离散成 16 档——连续的 w
    对结构没有任何额外贡献，却要为每一行现拼一个两千字节的字面量。
    噪声向量在 Python 这边生成：SQL 里只有均匀分布的 random()，凑正态又贵又不值。
    """
    lines = ["CREATE TABLE perf_noise(i int PRIMARY KEY, embedding vector(192));",
             "COPY perf_noise(i,embedding) FROM STDIN;"]
    for i in range(noise):
        vector = [rng.gauss(0, 1) for _ in range(DIMENSIONS)]
        norm = math.sqrt(sum(v * v for v in vector)) / sigma or 1.0
        lines.append(f"{i}\t[" + ",".join(f"{v / norm:.6g}" for v in vector) + "]")
    lines += ["\\.", "CREATE TABLE perf_weight(k int PRIMARY KEY, wa vector(192), wb vector(192));",
              "COPY perf_weight(k,wa,wb) FROM STDIN;"]
    for k in range(WEIGHT_LEVELS):
        w = mix_low + (mix_high - mix_low) * k / (WEIGHT_LEVELS - 1)
        lines.append(f"{k}\t[" + ",".join([f"{w:.6g}"] * DIMENSIONS) + "]\t["
                     + ",".join([f"{1 - w:.6g}"] * DIMENSIONS) + "]")
    lines.append("\\.")
    pg.run(database, "\n".join(lines) + "\n")


SYNTHESIS = """BEGIN;
INSERT INTO public_market.feature_locator(id,market,timeframe)
SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,'usd_m','{timeframe}'
FROM generate_series({low},{high}) n;
INSERT INTO public_market.features(
  id,market,symbol,timeframe,start_at,end_at,bars_count,model_id,embedding,input_hash,render_version,published)
SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(g.n),12,'0'))::uuid,
       'usd_m', 'PERF'||lpad((g.n % {symbols})::text,3,'0')||'USDT', '{timeframe}',
       -- 每个品种的窗口按 STRIDE=4 根往后排，和 history.universe 造窗口的间距一致；
       -- 整段时间轴锚在 now() 之前，否则 end_at<=cutoff 那一条会把行全滤掉。
       to_timestamp({epoch} + (g.n / {symbols}) * {stride}),
       to_timestamp({epoch} + (g.n / {symbols}) * {stride} + g.bars * {bar}),
       g.bars, '{model}',
       -- 两条真向量的凸组合 + 小噪声 + 重新归一化：保住真实流形的局部结构。
       l2_normalize((a.embedding * w.wa) + (b.embedding * w.wb) + z.embedding),
       'synthetic-'||g.n, '{render}', true
FROM (SELECT n,
             (random() * {levels})::int % {levels} AS ik,
             {holdout} + (random() * {pool})::int % {pool} AS ia,
             {holdout} + (random() * {pool})::int % {pool} AS ib,
             (random() * {noise})::int % {noise} AS iz,
             CASE WHEN random() < {p64} THEN 64 WHEN random() < {p128} THEN 128 ELSE 256 END AS bars
      FROM generate_series({low},{high}) n) g
JOIN perf_seed a ON a.i = g.ia
JOIN perf_seed b ON b.i = g.ib
JOIN perf_noise z ON z.i = g.iz
JOIN perf_weight w ON w.k = g.ik;
COMMIT;
"""


def batch_sql(low, high, plan):
    return SYNTHESIS.format(low=low, high=high, model=MODEL, render=RENDER_VERSION,
                            levels=WEIGHT_LEVELS, p64=TIER_64, p128=TIER_128 / (1 - TIER_64), **plan)


def synthesize(pg, database, total, plan, batch, log):
    """分批插：features 和 feature_locator 之间的外键是 DEFERRABLE，一口气八百万行会把触发器队列撑爆。"""
    started = time.monotonic()
    done = 0
    while done < total:
        size = min(batch, total - done)
        pg.run(database, batch_sql(done, done + size - 1, plan))
        done += size
        log({"phase": "synthesize", "rows": done, "of": total, "seconds": round(time.monotonic() - started, 1)})
    return round(time.monotonic() - started, 2)


def build_index(pg, database, maintenance_work_mem, timeout, parallel_workers=None):
    """HNSW 建索引。图装不进 maintenance_work_mem 就退化成逐条插进盘上索引，慢的不止一个量级，
    所以这个参数必须连着耗时一起报，不然数字没法读。

    索引是灌完数据才建的——migrate 之后先把空索引 DROP 掉。带着索引灌八百万行量的是
    「逐条插入」那条路（那是 history.universe 付的代价，另有 insert_cost 专门量），
    不是这里要的批量重建耗时。

    parallel_workers 传 0 是有意义的一档，不是把并行关掉图个清静：pgvector 的并行建
    索引把整张图放在一段 DSM 里，而 DSM 走的是容器的 /dev/shm——这里只有 1.0GB，于是
    maintenance_work_mem 再大也申请不到。改成串行之后图分配在后端进程自己的内存里，
    才有可能给到几个 GB。两条路的耗时差就是这一档要量的东西。"""
    started = time.monotonic()
    workers = ("" if parallel_workers is None
               else f"SET max_parallel_maintenance_workers={parallel_workers};\n")
    # pgvector 在图装不下的时候会发一条 NOTICE，明说装到第几条为止。这条消息就是
    # 「这台机器能在内存里建多大的索引」的直接证据，比任何估算都硬，必须留下来。
    notices = pg.run(database, f"SET maintenance_work_mem='{maintenance_work_mem}';\n" + workers +
                               "CREATE INDEX public_geometry_ann ON public_market.features "
                               "USING hnsw ((embedding::vector(192)) vector_cosine_ops) "
                               f"WHERE model_id='{MODEL}' AND published;\n",
                     timeout=timeout, notices=True)
    seconds = round(time.monotonic() - started, 2)
    pg.run(database, "ANALYZE public_market.features;", timeout=timeout)
    return seconds, [line for line in notices.splitlines() if line.strip()]


def sizes(pg, database, timeframe):
    partition = "features_usd_m_" + ("1mo" if timeframe == "1M" else timeframe)
    row = pg.rows(database, f"""
SELECT pg_total_relation_size('public_market.{partition}'),
       pg_relation_size('public_market.{partition}'),
       COALESCE((SELECT pg_relation_size(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public_market' AND c.relname LIKE '{partition}%embedding_idx2'),0),
       pg_total_relation_size('public_market.feature_locator'),
       pg_database_size(current_database());""")[0]
    return dict(zip(["partition_total", "heap", "hnsw_index", "feature_locator_total", "database_total"],
                    (int(v) for v in row)))


LATENCY = """{locals}
SET hnsw.ef_search={ef};
CREATE TEMP TABLE perf_timings(ms double precision);
DO $x$
DECLARE p record; t timestamptz; n int;
BEGIN
  FOR p IN SELECT embedding FROM perf_probe ORDER BY i LOOP
    t := clock_timestamp();
    -- 只数行不取行：客户端搬走一千行的代价不随索引规模变，混进来只会稀释真正的信号。
    EXECUTE 'SELECT count(*) FROM (' || $q${query}$q$ || ') s' USING p.embedding INTO n;
    INSERT INTO perf_timings VALUES (EXTRACT(epoch FROM clock_timestamp()-t)*1000);
  END LOOP;
END $x$;
SELECT count(*)||'|'||round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::numeric,2)
       ||'|'||round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::numeric,2)
       ||'|'||round(percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)::numeric,2)
       ||'|'||round(min(ms)::numeric,2)||'|'||round(max(ms)::numeric,2)||'|'||round(avg(ms)::numeric,2)
FROM perf_timings;
"""

EXACT = """SET enable_indexscan=off;
SET enable_bitmapscan=off;
SET max_parallel_workers_per_gather=4;
CREATE TABLE perf_exact(i int PRIMARY KEY, ids uuid[], nearest double precision, kth double precision);
DO $x$
DECLARE p record; ids uuid[]; d1 double precision; dk double precision;
BEGIN
  FOR p IN SELECT i,embedding FROM perf_probe ORDER BY i LIMIT {probes} LOOP
    -- 精确解：关掉索引扫，逼它顺序扫整张分区，这才是 recall 的分母。一级梯子上
    -- 只算一次——八百万行扫一遍要几十秒，每换一个 ef_search 重扫纯属浪费。
    -- 顺手把第一近和第 k 近的真实距离记下来：合成数据到底像不像真数据，看的就是这两个数。
    SELECT array_agg(id ORDER BY d), min(d), max(d) INTO ids, d1, dk FROM (
      SELECT id, embedding::vector(192) <=> p.embedding AS d FROM public_market.features
      WHERE model_id='{model}' AND published AND timeframe='{timeframe}'
      AND bars_count=ANY(ARRAY[64,128,256]) AND end_at<=now()
      ORDER BY 2 LIMIT {k}) t;
    INSERT INTO perf_exact VALUES (p.i, ids, d1, dk);
  END LOOP;
END $x$;
SELECT count(*)||'|'||round(avg(nearest)::numeric,5)||'|'||round(avg(kth)::numeric,5) FROM perf_exact;
"""

RECALL = """{locals}
SET hnsw.ef_search={ef};
CREATE TEMP TABLE perf_hit(i int, hit int);
DO $x$
DECLARE p record; approx uuid[];
BEGIN
  FOR p IN SELECT i,embedding FROM perf_probe ORDER BY i LIMIT {probes} LOOP
    EXECUTE 'SELECT array_agg(id) FROM (SELECT id FROM (' || $q${query}$q$
            || ') s ORDER BY distance+0,id LIMIT {k}) t' USING p.embedding INTO approx;
    INSERT INTO perf_hit SELECT p.i, (SELECT count(*) FROM unnest(e.ids) x WHERE x = ANY(approx))
    FROM perf_exact e WHERE e.i=p.i;
  END LOOP;
END $x$;
SELECT count(*)||'|'||round(avg(hit)::numeric/{k},4)||'|'||min(hit)||'|'||max(hit) FROM perf_hit;
"""


def exact_topk(pg, database, probes, k, timeframe, timeout):
    """一级梯子的精确答案，只算一次，后面所有 ef_search 共用这一份分母。"""
    count, d1, dk = pg.run(database, EXACT.format(probes=probes, k=k, model=MODEL, timeframe=timeframe),
                           timeout=timeout).splitlines()[-1].split("|")
    return {"probes": int(count), "k": k, "exact_nearest_distance_mean": float(d1),
            "exact_kth_distance_mean": float(dk)}


def latency(pg, database, query, ef, timeframe, timeout):
    """延迟在服务端量：clock_timestamp 夹一条 EXECUTE，把 docker exec 那一段往返开销排除在外。"""
    script = LATENCY.format(locals="\n".join("SET " + s + ";" for s in ann_locals()), ef=ef,
                            query=bind(query, "$1", timeframe=f"'{timeframe}'"))
    count, p50, p95, p99, low, high, mean = pg.run(database, script, timeout=timeout).splitlines()[-1].split("|")
    return {"ef_search": ef, "probes": int(count), "p50_ms": float(p50), "p95_ms": float(p95),
            "p99_ms": float(p99), "min_ms": float(low), "max_ms": float(high), "mean_ms": float(mean)}


def recall(pg, database, query, ef, probes, k, timeframe, timeout):
    """recall@k：ANN 的前 k 条对上精确顺序扫的前 k 条。延迟没涨而这个数悄悄掉，才是索引真的坏了。"""
    script = RECALL.format(locals="\n".join("SET " + s + ";" for s in ann_locals()), ef=ef, probes=probes,
                           k=k, query=bind(query, "$1", timeframe=f"'{timeframe}'"))
    count, mean, low, high = pg.run(database, script, timeout=timeout).splitlines()[-1].split("|")
    return {"ef_search": ef, "probes": int(count), "k": k, "recall_mean": float(mean),
            "recall_min": int(low) / k, "recall_max": int(high) / k}


def insert_cost(pg, database, plan, base, count):
    """索引建成之后再往里插一批：history.universe 付的是这个代价，不是 CREATE INDEX 的代价。"""
    started = time.monotonic()
    pg.run(database, batch_sql(base, base + count - 1, plan))
    seconds = time.monotonic() - started
    return {"rows": count, "seconds": round(seconds, 2), "rows_per_second": round(count / seconds, 1)}


LIVE_LATENCY = """BEGIN;
SET TRANSACTION READ ONLY;
{locals}
SET LOCAL hnsw.ef_search={ef};
DO $x$
DECLARE p record; t timestamptz; n int; ms double precision[] := '{{}}'; line text;
BEGIN
  FOR p IN SELECT (embedding::vector(192)) AS embedding FROM public_market.features
           WHERE model_id='{model}' AND published AND timeframe='{timeframe}'
           ORDER BY md5(id::text) LIMIT {probes} LOOP
    t := clock_timestamp();
    EXECUTE 'SELECT count(*) FROM (' || $q${query}$q$ || ') s' USING p.embedding INTO n;
    ms := ms || (EXTRACT(epoch FROM clock_timestamp()-t)*1000);
  END LOOP;
  SELECT count(*)||'|'||round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::numeric,2)
         ||'|'||round(percentile_cont(0.95) WITHIN GROUP (ORDER BY v)::numeric,2)
         ||'|'||round(percentile_cont(0.99) WITHIN GROUP (ORDER BY v)::numeric,2)
         ||'|'||round(min(v)::numeric,2)||'|'||round(max(v)::numeric,2)||'|'||round(avg(v)::numeric,2)
    INTO line FROM unnest(ms) v;
  RAISE NOTICE 'perf_latency %', line;
END $x$;
COMMIT;
"""


def ann_only(query):
    """把外面那层「物化前 1000 条再排一次」剥掉，只留候选 CTE 本身。
    两者一减，得到的就是「取 3000 个近邻」和「把它们排序截到 1000 条」各占多少。
    这两段里只有前一段随索引规模涨，后一段永远是 3000 行的排序。"""
    inner = re.search(r"AS MATERIALIZED \((.*)\)\s*SELECT", query, re.S)
    if not inner:
        raise RuntimeError("候选 CTE 的形状变了，stage 拆分要跟着改。")
    return inner.group(1)


def latency_live(pg, database, query, ef, timeframe, probes, timeout, overrides=()):
    """线上库上的干净基线。三重保险让它不可能写到任何东西：整笔事务 READ ONLY
    （连临时表都建不了，所以计时结果只能靠 RAISE NOTICE 带出来）、只跑 SELECT、
    设置一律 SET LOCAL。探针取库里已有的真向量——用户手里那张截图多半就是某个
    已索引窗口的样子，但也要承认这偏乐观：探针自己就在图里，第一跳必中。"""
    settings = list(ann_locals()) + list(overrides)
    script = LIVE_LATENCY.format(locals="\n".join("SET LOCAL " + s + ";" for s in settings), ef=ef,
                                 model=MODEL, timeframe=timeframe, probes=probes,
                                 query=bind(query, "$1", timeframe=f"'{timeframe}'"))
    notices = pg.run(database, script, timeout=timeout, notices=True)
    row = re.search(r"perf_latency (\S+)", notices).group(1).split("|")
    return {"timeframe": timeframe, "ef_search": ef, "overrides": list(overrides),
            "probes": int(row[0]), "p50_ms": float(row[1]),
            "p95_ms": float(row[2]), "p99_ms": float(row[3]), "min_ms": float(row[4]),
            "max_ms": float(row[5]), "mean_ms": float(row[6])}


def explain_live(pg, database, query, probe, timeframe):
    """线上库只读的那一半：确认 HNSW 真的被选中，而且每个分区都是索引扫。"""
    script = ("BEGIN;\n" + "\n".join("SET LOCAL " + s + ";" for s in ann_locals()) + "\n"
              + "EXPLAIN (ANALYZE, BUFFERS) " + bind(query, "'" + probe + "'", timeframe=timeframe) + ";\nCOMMIT;\n")
    plan = pg.run(database, script, tuples=False)
    scans = re.findall(r"->\s+(\w[\w ]*?) using (\S+) on (\S+)", plan)
    execution = re.search(r"Execution Time: ([\d.]+) ms", plan)
    return {"timeframe": timeframe,
            "index_scans": [{"node": a.strip(), "index": b, "relation": c} for a, b, c in scans],
            "sequential_scans": re.findall(r"Seq Scan on (\S+)", plan),
            "hnsw_partitions": sorted({b for _, b, _ in scans if b.endswith("embedding_idx2")}),
            "execution_ms": float(execution.group(1)) if execution else None,
            "plan": plan}


MANIFOLD = """SET enable_indexscan=off;
SET enable_bitmapscan=off;
SELECT round(avg(d1)::numeric,5)||'|'||round(avg(dk)::numeric,5)||'|'||count(*)
FROM (SELECT (SELECT min(d) FROM (SELECT f.embedding::vector(192) <=> p.embedding AS d
              FROM public_market.features f
              WHERE f.model_id='{model}' AND f.published AND f.timeframe='{timeframe}'
              AND f.bars_count=ANY(ARRAY[64,128,256]) AND {exclude} ORDER BY 1 LIMIT {k}) a) AS d1,
             (SELECT max(d) FROM (SELECT f.embedding::vector(192) <=> p.embedding AS d
              FROM public_market.features f
              WHERE f.model_id='{model}' AND f.published AND f.timeframe='{timeframe}'
              AND f.bars_count=ANY(ARRAY[64,128,256]) AND {exclude} ORDER BY 1 LIMIT {k}) b) AS dk
      FROM (SELECT id, symbol, embedding::vector(192) AS embedding FROM public_market.features
            WHERE model_id='{model}' AND published AND timeframe='{timeframe}'
            ORDER BY md5(id::text) LIMIT {probes}) p) t;
"""


def manifold_live(pg, database, timeframe, probes, k, timeout, exclude="f.id<>p.id"):
    """真数据自己的近邻距离分布。合成向量像不像真的，只能拿这一对数字比——
    真窗口之间 STRIDE=4 有大量近乎重复，第一近邻的距离会非常小；合成数据造不出
    这种重复，所以它的第一近邻一定更远、也就是「更难」。这个差多少，必须报出来。"""
    row = pg.run(database, MANIFOLD.format(model=MODEL, timeframe=timeframe, k=k, probes=probes,
                                           exclude=exclude), timeout=timeout).splitlines()[-1].split("|")
    return {"timeframe": timeframe, "probes": int(row[2]), "k": k, "excluded": exclude,
            "exact_nearest_distance_mean": float(row[0]), "exact_kth_distance_mean": float(row[1])}


PROJECTION = """WITH d AS (
  SELECT symbol, (max(end_at)::date - min(start_at)::date) + 1 AS days, count(*) AS rows
  FROM public_market.features WHERE published AND model_id='{model}' AND timeframe='{timeframe}'
  GROUP BY 1)
SELECT count(*)||'|'||sum(days)||'|'||sum(rows)||'|'||round(sum(rows)::numeric/sum(days),4) FROM d;
"""


def projection(pg, database, symbols):
    """把「200 个合约、15 个周期、全部历史」这句话换算成行数。

    分母不拿公式硬推。理论上一个连续单元是 0.75×bars−109 行（64/128/256 三档、
    STRIDE=4），但真跑出来的行数一直比它低：范围会被切成多个单元，每切一刀就少 109 行，
    上市晚和上游缺档还会再削一截。所以这里用线上 1d 那一轮真实扇出的「每根 K 线摊多少
    行」当系数——那是 187 个合约、十六万个合约日跑完之后的实测值，比任何推导都可信。
    4h 那一轮的系数一并量出来作对照：两个系数不一样，差的就是切段带来的损耗。"""
    rows = {}
    for timeframe in ("1d", "4h"):
        line = pg.run(database, PROJECTION.format(model=MODEL, timeframe=timeframe)).splitlines()[-1]
        count, days, total, ratio = line.split("|")
        bars = int(days) * (86400 // SECONDS[timeframe])
        rows[timeframe] = {"symbols": int(count), "symbol_days": int(days), "rows": int(total),
                           "rows_per_symbol_day": float(ratio), "bars": bars,
                           "rows_per_bar": round(int(total) / bars, 4)}
    # 1d 那一轮是完整的 200 名单跑完的结果，拿它按合约数放大到满员。
    anchor = rows["1d"]
    symbol_days = anchor["symbol_days"] / anchor["symbols"] * symbols
    per_bar = anchor["rows_per_bar"]
    table = []
    for timeframe, seconds in sorted(SECONDS.items(), key=lambda kv: kv[1]):
        bars = symbol_days * 86400 / seconds
        table.append({"timeframe": timeframe, "bars": round(bars),
                      # 两个系数都摆出来：粗周期那一轮切段少、每根 K 线摊到的行更多，
                      # 细周期只会比 1d 那个系数更高，所以真值落在两者之间偏上。
                      "rows_at_1d_ratio": round(bars * per_bar),
                      "rows_at_4h_ratio": round(bars * rows["4h"]["rows_per_bar"])})
    return {"measured": rows, "symbols": symbols, "symbol_days": round(symbol_days),
            "per_interval": table,
            "total_rows_at_1d_ratio": sum(v["rows_at_1d_ratio"] for v in table),
            "total_rows_at_4h_ratio": sum(v["rows_at_4h_ratio"] for v in table)}


def main():
    parser = argparse.ArgumentParser(description="Scorebook 公共向量索引的规模验收。")
    parser.add_argument("--rungs", default="100000,500000,2000000,8000000")
    parser.add_argument("--probes", type=int, default=200)
    parser.add_argument("--recall-probes", type=int, default=25)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--symbols", type=int, default=200)
    parser.add_argument("--sigma", type=float, default=0.08, help="噪声向量的模长，相对单位长度的真向量。")
    parser.add_argument("--mix", default="0.15,0.85")
    parser.add_argument("--seeds", type=int, default=100000)
    parser.add_argument("--noise-pool", type=int, default=4096)
    parser.add_argument("--batch", type=int, default=250000)
    parser.add_argument("--maintenance-work-mem", default="2GB")
    parser.add_argument("--parallel-workers", type=int, default=None,
                        help="建索引时的 max_parallel_maintenance_workers。给 0 走串行，"
                             "图就不占 /dev/shm，maintenance_work_mem 才能给到 GB 级。")
    parser.add_argument("--ef", default="1000,2000,200", help="生产默认是 ann.rs 里的 1000。")
    parser.add_argument("--container", default="scorebook-backend-postgres-1")
    parser.add_argument("--reserve-gb", type=float, default=40.0, help="低于这个余量就停梯子，不再往下建一级。")
    parser.add_argument("--build-timeout", type=float, default=7200)
    parser.add_argument("--out", default=None)
    parser.add_argument("--live-probes", type=int, default=200, help="线上基线的探针条数。")
    parser.add_argument("--live-timeframes", default="1d",
                        help="线上基线要量哪几个周期，逗号分隔。")
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--projection-only", action="store_true")
    parser.add_argument("--stages-only", action="store_true")
    parser.add_argument("--knobs-only", action="store_true",
                        help="在线上库上（只读）交叉扫 ef_search × iterative_scan，"
                             "看哪个旋钮真的决定代价。")
    parser.add_argument("--skip-baseline", action="store_true")
    arguments = parser.parse_args()

    config = dict(line.split("=", 1) for line in (ROOT / ".env").read_text().splitlines()
                  if line and not line.startswith("#"))
    url_base, live = config["DATABASE_URL"].rsplit("/", 1)
    user = url_base.split("//", 1)[1].split(":", 1)[0]
    out = pathlib.Path(arguments.out or (ROOT / "ops/tmp/perf"))
    out.mkdir(parents=True, exist_ok=True)
    pg = Postgres(arguments.container, user)
    query = public_query()
    mix_low, mix_high = (float(v) for v in arguments.mix.split(","))
    log = lambda event: print(json.dumps(event, default=str), flush=True)

    report = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "arguments": vars(arguments),
              "query_source": "chart_search/repository.rs::public_candidates",
              "ann_settings": ann_locals(), "rungs": [], "notes": []}

    if arguments.knobs_only:
        # 梯子上 ef_search 从 10 调到 2000，延迟和 recall 一动不动，这不正常——
        # HNSW 不可能在 ef=10 的时候还把前十名全找齐。怀疑是 iterative_scan 把
        # ef_search 架空了：候选 SQL 要 LIMIT 3000，比任何 ef 都大，relaxed_order
        # 于是一轮轮翻倍重扫，直到凑够 3000 条或者撞上 max_scan_tuples，
        # 最后落在哪儿由 LIMIT 决定，和初始 ef 无关。这一组就是去证伪它：
        # 在线上库上（只读）把 iterative_scan 关掉再扫一遍同样的 ef 网格。
        grid = []
        for scan in ["relaxed_order", "off"]:
            for ef in (int(v) for v in arguments.ef.split(",")):
                value = latency_live(pg, live, query, ef, "1d", arguments.live_probes,
                                     arguments.build_timeout,
                                     overrides=[f"hnsw.iterative_scan='{scan}'"])
                value["iterative_scan"] = scan
                grid.append(value)
                log({"phase": "knob", **value})
        payload = {"grid": grid, "live_jobs": pg.rows(live, "SELECT kind,status,count(*) FROM jobs "
                                                            "WHERE status IN ('queued','running','leased') "
                                                            "GROUP BY 1,2;")}
        (out / "knobs.json").write_text(json.dumps(payload, indent=1, ensure_ascii=False))
        return 0

    if arguments.stages_only:
        stages = {}
        for name, sql in [("ann_fetch_3000", ann_only(query)), ("full_candidates_1000", query)]:
            stages[name] = latency_live(pg, live, sql, 1000, "1d", arguments.live_probes,
                                        arguments.build_timeout)
            log({"phase": "stage", "stage": name, **stages[name]})
        stages["live_jobs"] = pg.rows(live, "SELECT kind,status,count(*) FROM jobs "
                                            "WHERE status IN ('queued','running','leased') GROUP BY 1,2;")
        (out / "stages.json").write_text(json.dumps(stages, indent=1, ensure_ascii=False))
        return 0

    if arguments.projection_only:
        value = projection(pg, live, arguments.symbols)
        (out / "projection.json").write_text(json.dumps(value, indent=1, ensure_ascii=False))
        log({"phase": "projection", "total_rows_at_1d_ratio": value["total_rows_at_1d_ratio"],
             "total_rows_at_4h_ratio": value["total_rows_at_4h_ratio"]})
        return 0

    seed_path = out / "seed_vectors.txt"
    if not seed_path.exists():
        log({"phase": "seed_export", "into": str(seed_path)})
        with seed_path.open("w") as handle:
            subprocess.run(["docker", "exec", arguments.container, "psql", "-U", user, "-d", live, "-Atc",
                            f"COPY (SELECT (embedding::vector(192))::text FROM public_market.features "
                            f"WHERE model_id='{MODEL}' AND published ORDER BY id) TO STDOUT"],
                           stdout=handle, check=True)
    report["seed"] = {"path": str(seed_path), "vectors": sum(1 for _ in seed_path.open()),
                      "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(seed_path.stat().st_mtime)),
                      "method": "线上库只读导出的真实 candle-geometry-v2 向量快照"}

    if not arguments.skip_baseline:
        probe = pg.run(live, f"SELECT (embedding::vector(192))::text FROM public_market.features "
                             f"WHERE model_id='{MODEL}' AND published ORDER BY id LIMIT 1;")
        report["baseline"] = {
            "live_rows": pg.rows(live, "SELECT timeframe,count(*) FROM public_market.features "
                                       "WHERE published GROUP BY 1 ORDER BY count(*) DESC;"),
            "explain": [explain_live(pg, live, query, probe, tf)
                        for tf in [f"'{v}'" for v in arguments.live_timeframes.split(",")] + ["NULL"]],
            # 只有在机器确实安静的时候，线上延迟才配叫基线。忙碌时跑出来的数字
            # 比没有数字更坏，所以把当时的在跑作业一并记下来，让读的人自己判断。
            "busy_jobs": pg.rows(live, "SELECT kind,status,count(*) FROM jobs "
                                       "WHERE status IN ('queued','running','leased') GROUP BY 1,2;"),
            # 周期是一个一个量的：不同周期的已发布行数差着一两个数量级，而线上这份
            # 数据是真向量，正好可以拿来对照合成梯子——4h 灌到四十万行的时候，
            # 它就是「真实数据在这个规模上到底多快」的唯一一手证据。
            "latency": [latency_live(pg, live, query, ef, tf, arguments.live_probes,
                                     arguments.build_timeout)
                        for tf in arguments.live_timeframes.split(",")
                        for ef in (int(v) for v in arguments.ef.split(","))],
            # 两种排除法都量：只排自己，和把同品种的全部排掉。后者才对得上「用户手里
            # 那张截图，索引里没见过」这个情形，也才和梯子上留出来的探针可比。
            "manifold": [manifold_live(pg, live, tf, arguments.recall_probes, arguments.k,
                                       arguments.build_timeout, exclude)
                         for tf in arguments.live_timeframes.split(",")
                         for exclude in ["f.id<>p.id", "f.symbol<>p.symbol"]]}
        for entry in report["baseline"]["explain"]:
            log({"phase": "baseline", "timeframe": entry["timeframe"],
                 "hnsw_partitions": len(entry["hnsw_partitions"]),
                 "sequential_scans": entry["sequential_scans"], "execution_ms": entry["execution_ms"]})
        (out / "report.json").write_text(json.dumps(report, indent=1, default=str))
        if arguments.baseline_only:
            return 0

    shm = shm_bytes(arguments.container)
    if arguments.parallel_workers != 0 and parse_size(arguments.maintenance_work_mem) > shm * 0.9:
        capped = f"{int(shm * 0.9 / 1024 ** 2)}MB"
        report["notes"].append(
            f"maintenance_work_mem 从 {arguments.maintenance_work_mem} 压到 {capped}："
            f"容器 /dev/shm 只有 {shm / 1024 ** 3:.1f}GB，并行建 HNSW 要在那里整段申请 "
            "maintenance_work_mem，超了是硬报错而不是退化。这就是这台机器一次能建多大图的上限。")
        log({"phase": "shm_cap", "shm_gb": round(shm / 1024 ** 3, 2),
             "requested": arguments.maintenance_work_mem, "used": capped})
        arguments.maintenance_work_mem = capped
    report["shm_bytes"] = shm

    rng = random.Random(20260911)
    for rows in (int(v) for v in arguments.rungs.split(",")):
        free = free_bytes(arguments.container)
        # 一行连表带索引大约 3KB（线上 1d 分区实测 2.87KB/行），留一倍余量再上一级。
        want = rows * 3200 * 2 + arguments.reserve_gb * 1024 ** 3
        if free < want:
            report["notes"].append(f"{rows} 这一级没跑：卷上只剩 {free / 1024 ** 3:.0f}GB，"
                                   f"预计需要 {want / 1024 ** 3:.0f}GB（含余量）。")
            log({"phase": "abort_ladder", "rows": rows, "free_gb": round(free / 1024 ** 3, 1)})
            break
        database = "scorebook_perf_" + uuid.uuid4().hex[:12]
        state = {"dropped": False}

        def drop(_signal=None, _frame=None):
            if not state["dropped"]:
                state["dropped"] = True
                try:
                    pg.run("postgres", f"DROP DATABASE IF EXISTS {database} WITH (FORCE);")
                    print(json.dumps({"phase": "dropped", "database": database}), flush=True)
                except Exception as error:  # 清理失败必须喊出来：静默残留一个几十 GB 的库最恶劣。
                    print(json.dumps({"phase": "drop_failed", "database": database,
                                      "error": str(error)}), flush=True)
            if _signal is not None:
                raise SystemExit(130)

        atexit.register(drop)
        signal.signal(signal.SIGINT, drop)
        signal.signal(signal.SIGTERM, drop)
        # 同一台机器上线上 worker 在不在干活，直接决定这一级的数字能不能当干净结果读。
        busy = lambda: pg.rows(live, "SELECT kind,status,count(*) FROM jobs "
                                     "WHERE status IN ('queued','running','leased') GROUP BY 1,2;")
        rung = {"rows": rows, "database": database, "timeframe": arguments.timeframe,
                "free_bytes_before": free, "started_at": time.strftime("%H:%M:%S"),
                "live_jobs_at_start": busy()}
        try:
            started = time.monotonic()
            pg.run("postgres", f"CREATE DATABASE {database};")
            rung["migrated_with"] = migrate(database, url_base)
            pg.run(database, "DROP INDEX public_market.public_geometry_ann;")
            rung["seed_vectors"] = load_seed(pg, database, seed_path, arguments.seeds, out)
            load_helpers(pg, database, arguments.noise_pool, arguments.sigma, mix_low, mix_high, rng)
            stride = 4 * SECONDS[arguments.timeframe]
            plan = {"symbols": arguments.symbols, "timeframe": arguments.timeframe, "stride": stride,
                    "bar": SECONDS[arguments.timeframe], "seeds": rung["seed_vectors"],
                    "noise": arguments.noise_pool, "holdout": arguments.probes,
                    "pool": rung["seed_vectors"] - arguments.probes,
                    # 时间轴往前铺够整条梯子，末尾留一天，保证 end_at<=now() 全部成立。
                    "epoch": int(time.time()) - 86400 - (rows // arguments.symbols + 2100) * stride}
            rung["synthesis_seconds"] = synthesize(pg, database, rows, plan, arguments.batch, log)
            rung["loaded_rows"] = int(pg.run(database, "SELECT count(*) FROM public_market.features;"))
            rung["visible_rows"] = int(pg.run(database, "SELECT count(*) FROM public_market.features "
                                                        f"WHERE published AND model_id='{MODEL}' "
                                                        "AND end_at<=now();"))
            log({"phase": "build_index", "rows": rows,
                 "maintenance_work_mem": arguments.maintenance_work_mem,
                 "parallel_workers": arguments.parallel_workers})
            rung["maintenance_work_mem"] = arguments.maintenance_work_mem
            rung["parallel_workers"] = arguments.parallel_workers
            try:
                rung["index_build_seconds"], rung["index_build_notices"] = build_index(
                    pg, database, arguments.maintenance_work_mem, arguments.build_timeout,
                    arguments.parallel_workers)
            except subprocess.TimeoutExpired:
                rung["index_build_seconds"] = None
                rung["index_build_timed_out_after"] = arguments.build_timeout
                report["notes"].append(f"{rows} 行的 HNSW 在 {arguments.build_timeout}s 内没建完，"
                                       "这一级只剩下「建不完」这一个结论。")
                raise RuntimeError("index build timed out")
            log({"phase": "index_built", "rows": rows, "seconds": rung["index_build_seconds"]})
            rung["sizes"] = sizes(pg, database, arguments.timeframe)
            rung["bytes_per_row"] = round(rung["sizes"]["partition_total"] / rows, 1)
            # 探针取真向量本身（用户手里是真截图，不是合成点），而且取的是合成时
            # 留出来没用过的那几百条：拿参与过合成的种子当探针，它的最近邻就是一堆
            # 「0.85 倍它自己 + 一点别人」的行，recall 会漂亮得毫无意义。
            pg.run(database, "CREATE TABLE perf_probe(i int PRIMARY KEY, embedding vector(192));\n"
                             "INSERT INTO perf_probe SELECT i,embedding FROM perf_seed "
                             f"WHERE i < {arguments.probes};")
            rung["exact"] = exact_topk(pg, database, arguments.recall_probes, arguments.k,
                                       arguments.timeframe, arguments.build_timeout)
            log({"phase": "exact", "rows": rows, **rung["exact"]})
            rung["latency"], rung["recall"] = [], []
            for ef in (int(v) for v in arguments.ef.split(",")):
                # 每一组百分位都自带它当时的队列快照。梯子要跑几个小时，生产的品种
                # 扇出随时可能起停，事后拿「这一级开始时」的状态去解释「这一级第三组
                # ef 的 p99」是糊弄人——要标注就标注到能对上号的粒度。
                before = busy()
                measured = latency(pg, database, query, ef, arguments.timeframe,
                                   arguments.build_timeout)
                measured["live_jobs_before"], measured["live_jobs_after"] = before, busy()
                rung["latency"].append(measured)
                log({"phase": "latency", "rows": rows, **measured})
                rung["recall"].append(recall(pg, database, query, ef, arguments.recall_probes, arguments.k,
                                             arguments.timeframe, arguments.build_timeout))
                log({"phase": "recall", "rows": rows, **rung["recall"][-1]})
            rung["insert_cost"] = insert_cost(pg, database, plan, rows, 2000)
            log({"phase": "insert_cost", "rows": rows, **rung["insert_cost"]})
            rung["total_seconds"] = round(time.monotonic() - started, 1)
            rung["live_jobs_at_end"] = busy()
        except Exception as error:
            rung["error"] = str(error)[-2000:]
            log({"phase": "rung_failed", "rows": rows, "error": rung["error"][:400]})
        finally:
            drop()
            atexit.unregister(drop)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
        report["rungs"].append(rung)
        (out / "report.json").write_text(json.dumps(report, indent=1, default=str))
        if "error" in rung:
            break

    (out / "report.json").write_text(json.dumps(report, indent=1, default=str))
    log({"phase": "done", "report": str(out / "report.json")})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
