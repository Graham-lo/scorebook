-- Retain the old three-candidate samples for audit, but never mix them with
-- the full production search distribution. Each measured source is resumable.
ALTER TABLE chart_match_calibration ADD COLUMN pipeline text NOT NULL DEFAULT 'legacy-top3';
ALTER TABLE chart_match_calibration ADD COLUMN sample_id uuid;
CREATE UNIQUE INDEX chart_match_calibration_sample
ON chart_match_calibration(interval,bars_bucket,pipeline,sample_id);
