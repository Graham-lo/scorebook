"""Compilation boundaries, with no old application tree alongside the workspace."""
import pathlib, tomllib
root = pathlib.Path(__file__).resolve().parents[1]
for crate, forbidden in {'core':{'axum','sqlx','reqwest','scorebook-infrastructure','scorebook-http'}, 'http':{'sqlx','reqwest','scorebook-infrastructure'}}.items():
    deps = set(tomllib.loads((root / 'crates' / crate / 'Cargo.toml').read_text())['dependencies'])
    assert not deps & forbidden, (crate, deps & forbidden)
for old in ['src/application','src/adapters','src/domain','src/http']:
    assert not (root / old).exists(), f'Old implementation tree remains: {old}'
print('Workspace dependency boundaries verified')
