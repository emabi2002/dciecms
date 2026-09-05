'use strict';

function requireDatabaseUrl(env = process.env) {
  const value = env.DATABASE_URL;
  if (!value || !String(value).trim()) {
    const error = new Error('DATABASE_URL is required for PostgreSQL persistence');
    error.code = 'DATABASE_URL_REQUIRED';
    throw error;
  }
  return String(value).trim();
}

function createPostgresPool({
  connectionString,
  PoolClass,
  ssl = false,
  max = 10,
  idleTimeoutMillis = 30000,
  connectionTimeoutMillis = 5000,
  applicationName = 'dciecms-api'
} = {}) {
  if (!connectionString) throw new Error('connectionString is required');
  const EffectivePool = PoolClass || require('pg').Pool;
  return new EffectivePool({
    connectionString,
    ssl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    application_name: applicationName
  });
}

module.exports = { requireDatabaseUrl, createPostgresPool };
