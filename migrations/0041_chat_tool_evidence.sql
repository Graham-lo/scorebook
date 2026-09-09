-- Computed answers can cite their exact tool result without indexing Chat into itself.
CREATE VIEW chat_tool_evidence AS
SELECT owner_id,run_id,md5(run_id::text||':'||tool_call_id)::uuid AS id,completed_at AS occurred_at,
 jsonb_build_object('identity','deterministic_tool_result','tool',name,'arguments_sha256',arguments_sha256,'result',result) AS body
FROM chat_tool_calls WHERE status='completed' AND result IS NOT NULL;
