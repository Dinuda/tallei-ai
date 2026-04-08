import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        google_sub TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      ALTER TABLE users
      ALTER COLUMN password_hash DROP NOT NULL;
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local',
      ADD COLUMN IF NOT EXISTS google_sub TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub_unique
      ON users(google_sub)
      WHERE google_sub IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT UNIQUE NOT NULL,
        name TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_info JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_challenge TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT,
        resource TEXT,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        consumed_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_client ON oauth_authorization_codes(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_user ON oauth_authorization_codes(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_auth_codes_expires ON oauth_authorization_codes(expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token TEXT PRIMARY KEY,
        refresh_token TEXT UNIQUE NOT NULL,
        client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        scope TEXT,
        resource TEXT,
        access_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        revoked_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh ON oauth_tokens(refresh_token);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_expiry ON oauth_tokens(access_expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_expiry ON oauth_tokens(refresh_expires_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claude_onboarding_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        current_state TEXT NOT NULL,
        project_name TEXT NOT NULL DEFAULT 'chatgpt memory',
        checkpoint JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_error TEXT,
        completed_at TIMESTAMP WITH TIME ZONE,
        canceled_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_user_created ON claude_onboarding_sessions(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_status ON claude_onboarding_sessions(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS claude_onboarding_events (
        id BIGSERIAL PRIMARY KEY,
        session_id UUID NOT NULL REFERENCES claude_onboarding_sessions(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        state TEXT,
        payload JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_claude_onboarding_events_session_id ON claude_onboarding_events(session_id, created_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS browser_onboarding_fallback_cache (
        state TEXT NOT NULL,
        error_signature TEXT NOT NULL,
        instruction TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (state, error_signature)
      );

      CREATE INDEX IF NOT EXISTS idx_browser_fallback_cache_state_hits
        ON browser_onboarding_fallback_cache(state, hits DESC);
    `);

    console.log("Database schema initialized successfully.");
  } catch (error) {
    console.error("Error initializing database schema:", error);
    throw error;
  } finally {
    client.release();
  }
}
