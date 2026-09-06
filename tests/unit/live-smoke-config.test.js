'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveSmokeConfig } = require('../../scripts/live-smoke');

test('live smoke requires a database URL and forces the Supabase test profile', () => {
  assert.throws(
    () => createLiveSmokeConfig({}),
    (error) => error && error.code === 'DATABASE_URL_REQUIRED'
  );

  const config = createLiveSmokeConfig({
    DATABASE_URL: 'postgres://example.invalid/postgres'
  });

  assert.equal(config.databaseUrl, 'postgres://example.invalid/postgres');
  assert.equal(config.dbProfile, 'supabase_test');
});
