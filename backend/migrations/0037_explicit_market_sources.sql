-- v3 was REST-only. Encode that fact once; readers must not guess missing sources.
UPDATE public_market.generations SET body=jsonb_set(body,'{source}','"rest"') WHERE NOT body ? 'source';
UPDATE history_indexes SET body=jsonb_set(body,'{source}','"rest"') WHERE NOT body ? 'source';
UPDATE history_plans SET body=jsonb_set(body,'{source}','"rest"') WHERE NOT body ? 'source';
