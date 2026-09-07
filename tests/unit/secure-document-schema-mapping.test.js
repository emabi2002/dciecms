'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {rewriteSql}=require('../../services/api/src/postgres-schema-mapping');

test('Supabase test profile maps the secure document scan queue into dciecms_test',()=>{
  const sql="SELECT * FROM documents.scan_jobs WHERE document_id=$1";
  assert.equal(
    rewriteSql(sql,'supabase_test'),
    "SELECT * FROM dciecms_test.document_scan_jobs WHERE document_id=$1"
  );
});
