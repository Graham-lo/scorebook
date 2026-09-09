from pathlib import Path
from huggingface_hub import snapshot_download
root = Path(__file__).parent / "models" / "dinov2-small"
snapshot_download("facebook/dinov2-small", revision="150c8e7bb7cef2d30ec31b13a517af14840ee3f7", local_dir=root, allow_patterns=["config.json", "model.safetensors", "preprocessor_config.json", "README.md"])
print("Downloaded pinned DINOv2 weights for local inference.")
