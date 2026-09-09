"""Explicit installation of the pinned public BGE-M3 dense encoder. No account token."""
from huggingface_hub import snapshot_download
from pathlib import Path
import hashlib
ROOT=Path(__file__).parent/'models'/'bge-m3'
REVISION='5617a9f61b028005a4858fdac845db406aefb181'
WEIGHTS='b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38'
if __name__ == "__main__":
    snapshot_download('BAAI/bge-m3',revision=REVISION,token=False,local_dir=ROOT,allow_patterns=['pytorch_model.bin','config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','sentencepiece.bpe.model'],max_workers=2)
    with (ROOT/'pytorch_model.bin').open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
    if actual!=WEIGHTS: raise SystemExit('model_checksum_mismatch')
    print('Verified bge-m3-dense-v1',REVISION,actual)
