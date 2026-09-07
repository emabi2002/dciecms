'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresRepository } = require('../../services/api/src/postgres-repository');

test('canonical provider event reload locks the inbox row for one transactional processor', async () => {
  const eventRecordId = '44444444-4444-4444-4444-444444444444';
  const db = {
    async query(text, params) {
      assert.match(text, /FROM\s+finance\.payment_provider_events/i);
      assert.match(text, /payment_provider_event_record_id\s*=\s*\$1/i);
      assert.match(text, /FOR\s+UPDATE/i);
      assert.deepEqual(params, [eventRecordId]);
      return { rows: [] };
    }
  };

  const repo = new PostgresRepository(db);
  const event = await repo.getPaymentProviderEvent(eventRecordId);
  assert.equal(event, null);
});
