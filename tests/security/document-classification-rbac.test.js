'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveActorFromClaims } = require('../../packages/auth');
const { authorizeDocumentClassification } = require('../../services/api/src/document-policy');

function actor({ roles=['REG'], courtIds=['COURT-A'], grants=[] } = {}) {
  return resolveActorFromClaims({
    sub: 'actor-1',
    roles,
    court_ids: courtIds,
    explicit_grants: grants
  });
}

test('PUBLIC still requires base document.view permission and court scope', () => {
  assert.throws(
    () => authorizeDocumentClassification(actor({roles:['ICT-ADMIN']}), {courtId:'COURT-A',classification:'PUBLIC'}, 'view'),
    /permission denied/i
  );
  assert.throws(
    () => authorizeDocumentClassification(actor({courtIds:['COURT-B']}), {courtId:'COURT-A',classification:'PUBLIC'}, 'view'),
    /court scope/i
  );
});

test('CONFIDENTIAL uses base document permission and court scope', () => {
  assert.doesNotThrow(() => authorizeDocumentClassification(
    actor(),
    {courtId:'COURT-A',classification:'CONFIDENTIAL'},
    'view'
  ));
});

test('RESTRICTED requires explicit restricted-document grant in addition to base access', () => {
  assert.throws(
    () => authorizeDocumentClassification(actor(), {courtId:'COURT-A',classification:'RESTRICTED'}, 'view'),
    /explicit grant/i
  );
  assert.doesNotThrow(() => authorizeDocumentClassification(
    actor({grants:['document.restricted.view']}),
    {courtId:'COURT-A',classification:'RESTRICTED'},
    'view'
  ));
});

test('SEALED requires explicit sealed-document grant in addition to base access', () => {
  assert.throws(
    () => authorizeDocumentClassification(actor({roles:['MAG']}), {courtId:'COURT-A',classification:'SEALED'}, 'view'),
    /explicit grant/i
  );
  assert.doesNotThrow(() => authorizeDocumentClassification(
    actor({roles:['MAG'],grants:['document.sealed.view']}),
    {courtId:'COURT-A',classification:'SEALED'},
    'view'
  ));
});

test('restricted and sealed grants do not bypass base permission or court scope', () => {
  assert.throws(
    () => authorizeDocumentClassification(
      actor({roles:['ICT-ADMIN'],grants:['document.restricted.view','document.sealed.view']}),
      {courtId:'COURT-A',classification:'RESTRICTED'},
      'view'
    ),
    /permission denied/i
  );
  assert.throws(
    () => authorizeDocumentClassification(
      actor({roles:['REG'],courtIds:['COURT-B'],grants:['document.sealed.view']}),
      {courtId:'COURT-A',classification:'SEALED'},
      'view'
    ),
    /court scope/i
  );
});
