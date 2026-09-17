-- Hostname is operational metadata only.  Device authentication and all
-- school/line relationships continue to use the immutable device id and
-- monitoring point mapping.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS hostname TEXT;

ALTER TABLE devices
    ADD CONSTRAINT devices_hostname_length
        CHECK (hostname IS NULL OR length(hostname) BETWEEN 1 AND 255);

CREATE INDEX IF NOT EXISTS ix_devices_hostname ON devices(hostname);
