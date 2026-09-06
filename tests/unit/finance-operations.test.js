'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function loadFinanceOperationsService() {
  try {
    return require('../../services/api/src/finance-operations-service').FinanceOperationsService;
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes('finance-operations-service')) return null;
    throw error;
  }
}

test('R3 exposes a dedicated finance operations service', () => {
  const FinanceOperationsService = loadFinanceOperationsService();
  assert.equal(typeof FinanceOperationsService, 'function');
});
