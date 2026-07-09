import assert from "node:assert/strict";
import test from "node:test";

import { applyEnvAliases, resetEnvAliasWarnings } from "../../../src/config/env-aliases.js";
import { loadConfig } from "../../../src/config/load.js";

test("applyEnvAliases maps legacy keys to canonical TALLEI_* names", () => {
  resetEnvAliasWarnings();
  const resolved = applyEnvAliases({
    OPENAI_API_KEY: "sk-legacy",
    DATABASE_URL: "postgresql://legacy",
    TALLEI_LOOP_BUILDER__OPENAI_MODEL: "gpt-5-mini",
  });
  assert.equal(resolved.TALLEI_LLM__OPENAI_API_KEY, "sk-legacy");
  assert.equal(resolved.TALLEI_DB__URL, "postgresql://legacy");
  assert.equal(resolved.TALLEI_CONDUCTOR__MODEL, "gpt-5-mini");
});

test("applyEnvAliases does not override canonical values", () => {
  const resolved = applyEnvAliases({
    OPENAI_API_KEY: "sk-legacy",
    TALLEI_LLM__OPENAI_API_KEY: "sk-canonical",
  });
  assert.equal(resolved.TALLEI_LLM__OPENAI_API_KEY, "sk-canonical");
});

test("loadConfig resolves conductor model from legacy loop builder alias", () => {
  const cfg = loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test",
    TALLEI_LOOP_BUILDER__OPENAI_MODEL: "gpt-5-mini",
  });
  assert.equal(cfg.conductorModel, "gpt-5-mini");
});
