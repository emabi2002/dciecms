'use strict';

const SUPABASE_TEST_TABLES = Object.freeze({
  'config.courts': 'dciecms_test.config_courts',
  'config.case_types': 'dciecms_test.config_case_types',
  'iam.users': 'dciecms_test.iam_users',
  'iam.roles': 'dciecms_test.iam_roles',
  'iam.permissions': 'dciecms_test.iam_permissions',
  'iam.user_role_assignments': 'dciecms_test.iam_user_role_assignments',
  'case_mgmt.parties': 'dciecms_test.case_parties',
  'registry.filings': 'dciecms_test.registry_filings',
  'documents.documents': 'dciecms_test.documents',
  'audit.audit_events': 'dciecms_test.audit_events',
  'workflow.idempotency_records': 'dciecms_test.workflow_idempotency_records',
  'workflow.workflow_tasks': 'dciecms_test.workflow_tasks',
  'finance.fee_assessments': 'dciecms_test.finance_fee_assessments',
  'finance.payments': 'dciecms_test.finance_payments',
  'finance.receipts': 'dciecms_test.finance_receipts',
  'finance.reconciliations': 'dciecms_test.finance_reconciliations',
  'case_mgmt.case_number_sequences': 'dciecms_test.case_number_sequences',
  'case_mgmt.cases': 'dciecms_test.cases',
  'judicial.hearings': 'dciecms_test.judicial_hearings',
  'judicial.hearing_adjournments': 'dciecms_test.judicial_hearing_adjournments',
  'judicial.hearing_appearances': 'dciecms_test.judicial_hearing_appearances',
  'judicial.proceeding_records': 'dciecms_test.judicial_proceeding_records',
  'judicial.judgments': 'dciecms_test.judicial_judgments',
  'integration.outbox_events': 'dciecms_test.integration_outbox_events'
});

function rewriteSql(text, profile = 'logical') {
  if (profile !== 'supabase_test' || typeof text !== 'string') return text;
  let rewritten = text;
  for (const [logical, physical] of Object.entries(SUPABASE_TEST_TABLES)) {
    rewritten = rewritten.replaceAll(logical, physical);
  }
  return rewritten;
}

function mapQueryArg(query, profile) {
  if (typeof query === 'string') return rewriteSql(query, profile);
  if (query && typeof query === 'object' && typeof query.text === 'string') {
    return { ...query, text: rewriteSql(query.text, profile) };
  }
  return query;
}

function wrapClient(client, profile) {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (query, values, callback) => target.query(mapQueryArg(query, profile), values, callback);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function createMappedDatabase(db, profile = 'logical') {
  if (!db || profile !== 'supabase_test') return db;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (query, values, callback) => target.query(mapQueryArg(query, profile), values, callback);
      }
      if (property === 'connect') {
        return async (...args) => wrapClient(await target.connect(...args), profile);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

module.exports = { SUPABASE_TEST_TABLES, rewriteSql, createMappedDatabase };