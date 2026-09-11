"""Install only the pinned, verified official restic binary into this workspace."""
import urllib.request,hashlib,bz2,platform
from pathlib import Path
VERSION='0.19.1'
SHA='7be0a144ccc377880f294204aa271d76e4b79554b42a751151d425ce6ebac143'
if platform.system()!='Darwin' or platform.machine()!='arm64':raise SystemExit('This installer pins darwin/arm64; use a separately verified platform package.')
url=f'https://github.com/restic/restic/releases/download/v{VERSION}/restic_{VERSION}_darwin_arm64.bz2'
with urllib.request.urlopen(url,timeout=60) as r: data=r.read(32*1024*1024+1)
if len(data)>32*1024*1024 or hashlib.sha256(data).hexdigest()!=SHA:raise SystemExit('restic_download_checksum_mismatch')
plain=bz2.BZ2Decompressor().decompress(data,max_length=64*1024*1024)
if len(plain)>=64*1024*1024:raise SystemExit('restic_binary_too_large')
path=Path(__file__).parent/'bin'/'restic';path.parent.mkdir(exist_ok=True);path.write_bytes(plain);path.chmod(0o755)
print(f'Installed restic {VERSION}; binary sha256={hashlib.sha256(plain).hexdigest()}')
