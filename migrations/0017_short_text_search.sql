-- Trigram indexes cannot narrow a single Chinese character. An exact character-set prefilter
-- handles short literal queries; ILIKE remains the final substring predicate (no fuzzy fallback).
CREATE FUNCTION literal_characters(v text) RETURNS text[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT ARRAY(SELECT DISTINCT ch FROM regexp_split_to_table(lower(v),'') ch WHERE ch<>'')
$$;
CREATE INDEX calls_short_text ON calls USING gin(literal_characters(original_text));
