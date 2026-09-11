CREATE INDEX embeddings_visual_hnsw ON image_embeddings USING hnsw ((embedding::vector(384)) vector_cosine_ops) WHERE model_id='dinov2-small-v1';
