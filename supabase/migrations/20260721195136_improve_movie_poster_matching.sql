/*
# Improve movie poster matching metadata

Adds explicit fields for preserving manual decisions, storing uncertain TMDB
candidates without displaying them, and using verified cinema artwork when a
genuine movie poster is not available.
*/

ALTER TABLE movies
  ADD COLUMN IF NOT EXISTS manually_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS poster_override_url text,
  ADD COLUMN IF NOT EXISTS candidate_tmdb_id bigint,
  ADD COLUMN IF NOT EXISTS candidate_poster_path text,
  ADD COLUMN IF NOT EXISTS match_reason text;

ALTER TABLE screenings
  ADD COLUMN IF NOT EXISTS verified_artwork_url text;

COMMENT ON COLUMN movies.manually_confirmed IS
  'True only after a person has confirmed the movie/poster. The matcher never overwrites these rows.';

COMMENT ON COLUMN movies.poster_override_url IS
  'Manually approved absolute artwork URL. Used only when manually_confirmed is true.';

COMMENT ON COLUMN movies.candidate_tmdb_id IS
  'Uncertain TMDB candidate retained for review; never rendered automatically.';

COMMENT ON COLUMN movies.candidate_poster_path IS
  'Poster path belonging to candidate_tmdb_id; never rendered automatically.';

COMMENT ON COLUMN screenings.verified_artwork_url IS
  'Cinema-provided artwork URL that has been verified as representing this listing.';
