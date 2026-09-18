ALTER TABLE agent_commands ADD COLUMN situation_id BIGINT REFERENCES situations(id) ON DELETE SET NULL;
CREATE INDEX agent_commands_situation_idx ON agent_commands (situation_id, created_at);

CREATE TABLE live_verify_results (
    command_id BIGINT PRIMARY KEY REFERENCES agent_commands(id) ON DELETE CASCADE,
    situation_id BIGINT NOT NULL REFERENCES situations(id) ON DELETE CASCADE,
    measurement_id BIGINT NOT NULL UNIQUE REFERENCES measurements(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX live_verify_results_situation_idx ON live_verify_results (situation_id, created_at);
