-- Trigram matching for typo-tolerant product search (name). Must exist before the indexes in the next migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
