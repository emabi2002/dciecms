'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../../db/migrations/0001_baseline.sql'),'utf8');
const durableControlsPath=path.join(__dirname,'../../db/migrations/0011_durable_controls.sql');

test('migration creates required schemas for the vertical slice',()=>{
  for(const schema of ['audit','config','iam','registry','case_mgmt','documents']) assert.match(sql,new RegExp(`CREATE SCHEMA IF NOT EXISTS ${schema}`,'i'));
});

test('migration creates required tables and unique business identifiers',()=>{
  for(const table of ['courts','users','roles','permissions','user_role_assignments','parties','filings','documents','audit_events']) assert.match(sql,new RegExp(`CREATE TABLE IF NOT EXISTS [\\w.]*${table}`,'i'));
  assert.match(sql,/filing_reference[^,\n]+UNIQUE/i);
});

test('audit table revokes ordinary update and delete operations',()=>{
  assert.match(sql,/REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+audit\.audit_events/i);
});

test('0011 creates durable idempotency and actor-subject audit controls',()=>{
  assert.equal(fs.existsSync(durableControlsPath),true,'0011_durable_controls.sql must exist');
  const durableSql=fs.readFileSync(durableControlsPath,'utf8');
  assert.match(durableSql,/CREATE TABLE IF NOT EXISTS workflow\.idempotency_records/i);
  assert.match(durableSql,/response_payload\s+jsonb/i);
  assert.match(durableSql,/UNIQUE\s*\(\s*actor_subject\s*,\s*operation\s*,\s*resource_id\s*,\s*idempotency_key\s*\)/i);
  assert.match(durableSql,/ALTER TABLE audit\.audit_events[\s\S]*ADD COLUMN IF NOT EXISTS actor_subject\s+text/i);
  assert.match(durableSql,/REVOKE\s+UPDATE\s*,\s*DELETE\s+ON\s+workflow\.idempotency_records/i);
});
