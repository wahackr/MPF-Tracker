-- A crawler may store valid prices while individual funds fail. Preserve that distinction.
ALTER TABLE mpf.jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE mpf.jobs ADD CONSTRAINT jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed'));
