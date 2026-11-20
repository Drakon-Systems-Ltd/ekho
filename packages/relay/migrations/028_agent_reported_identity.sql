-- #97 self-reported adapter identity, latest heartbeat wins. Nullable columns only, no row is rewritten. NULL reads as "version unknown".
ALTER TABLE agents ADD COLUMN reported_adapter TEXT;
ALTER TABLE agents ADD COLUMN reported_adapter_version TEXT;
ALTER TABLE agents ADD COLUMN reported_sdk_version TEXT;
ALTER TABLE agents ADD COLUMN reported_host_runtime TEXT;
ALTER TABLE agents ADD COLUMN reported_host_runtime_version TEXT;
ALTER TABLE agents ADD COLUMN reported_instance_id TEXT;
