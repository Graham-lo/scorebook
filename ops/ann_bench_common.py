"""Read the production query and settings so ANN acceptance cannot drift from Rust."""
import pathlib
import re
ROOT = pathlib.Path(__file__).resolve().parents[1]

def public_query():
    source = (ROOT / 'crates/infrastructure/src/application/history.rs').read_text()
    query = re.search(r'"(WITH ann_candidates AS MATERIALIZED .*?LIMIT 1000)"', source).group(1)
    query = query.replace('{dimension}', '192').replace('{model}', 'candle-geometry-v2')
    return re.sub(r'\$(\d+)', lambda m: '%(q' + m[1] + ')s', query)

def configure(connection):
    source = (ROOT / 'crates/infrastructure/src/adapters/ann.rs').read_text()
    for setting in re.findall(r'"SET LOCAL ([^"\n]+)"', source):
        connection.execute('SET ' + setting)
