'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditStore } = require('../../packages/audit');

test('audit append requires actor action and resource type', () => {
  const store = new AuditStore();
  assert.throws(() => store.append({ action: 'filing.create' }), /actor/i);
});

test('audit events are append-only frozen records', () => {
  const store = new AuditStore();
  const event = store.append({ actorUserId:'u1', action:'filing.create', resourceType:'filing', resourceId:'f1', correlationId:'c1' });
  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => { event.action = 'changed'; }, TypeError);
  assert.equal(store.list()[0].action, 'filing.create');
});

test('audit list can filter by correlation id', () => {
  const store = new AuditStore();
  store.append({ actorUserId:'u1', action:'a', resourceType:'x', resourceId:'1', correlationId:'c1' });
  store.append({ actorUserId:'u2', action:'b', resourceType:'x', resourceId:'2', correlationId:'c2' });
  assert.deepEqual(store.list({ correlationId:'c2' }).map(e => e.resourceId), ['2']);
});
