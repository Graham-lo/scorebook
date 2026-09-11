CREATE TABLE instrument_catalog(venue text NOT NULL,market text NOT NULL,symbol text NOT NULL,body jsonb NOT NULL,refreshed_at timestamptz NOT NULL,PRIMARY KEY(venue,market,symbol));
CREATE INDEX instruments_class ON instrument_catalog((body->>'underlyingType'));
