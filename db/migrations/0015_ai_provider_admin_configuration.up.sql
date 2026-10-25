-- P1-09 / 0015: future admin-managed provider settings and sealed credentials.
-- CI ONLY: no production deployment or live key acceptance was authorized.
BEGIN;

CREATE TABLE vns.ai_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('openai','google_gemini')),
  selected_model text CHECK (
    selected_model IS NULL OR selected_model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,119}$'
  ),
  selected_voice text CHECK (
    selected_voice IS NULL OR selected_voice ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$'
  ),
  language text NOT NULL DEFAULT 'en' CHECK (language='en'),
  enabled boolean NOT NULL DEFAULT false CHECK (enabled = false),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE vns.ai_provider_sealed_credentials (
  provider text PRIMARY KEY REFERENCES vns.ai_provider_settings(provider) ON DELETE RESTRICT,
  format_version integer NOT NULL DEFAULT 1 CHECK (format_version = 1),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 12 AND 512),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO vns.ai_provider_settings(provider,selected_model) VALUES
 ('openai','gpt-6.1-sol'),
 ('google_gemini','gemini-3.8-flash-tts');

-- IMPORTANT: no provider credentials or grants are seeded.
-- The default application roles are unable to see or mutate either table.
-- Until a separate migration, provider execution cannot be enabled via SQL.
COMMENT ON TABLE vns.ai_provider_settings IS
 'CI-only preparation for encrypted, admin-managed AI provider configurations. Always disabled.';
COMMENT ON TABLE vns.ai_provider_sealed_credentials IS
 'CI-only sealed credential envelope. AES-GCM master key must reside outside PostgreSQL and Git. No application grants.';

INSERT INTO vns.schema_migrations(version)
VALUES ('0015_ai_provider_admin_configuration');
COMMIT;
