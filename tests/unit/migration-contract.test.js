'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'../../db/migrations/0001_baseline.sql'),'utf8');

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
