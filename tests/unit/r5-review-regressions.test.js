'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveActorFromClaims } = require('../../packages/auth');
const { JudicialOperationsService } = require('../../services/api/src/judicial-operations-service');

const COURT_A = '11111111-1111-1111-1111-111111111111';
const CASE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const HEARING_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

test('outbox claim SQL aliases the candidate id to avoid UPDATE FROM RETURNING ambiguity', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../services/api/src/postgres-outbox-store.js'), 'utf8');
  assert.match(source, /SELECT\s+outbox_event_id\s+AS\s+candidate_id[\s\S]+FROM\s+integration\.outbox_events/i);
  assert.match(source, /outbox\.outbox_event_id\s*=\s*candidates\.candidate_id/i);
});

test('hearing adjournment outbox payload excludes free-text judicial reason', async () => {
  const actor = resolveActorFromClaims({ sub: 'mag-a', roles: ['MAG'], court_ids: [COURT_A] });
  const events = [];
  const repository = {
    async getHearing(id) {
      return id === HEARING_A
        ? { hearingId: HEARING_A, caseId: CASE_A, courtId: COURT_A, status: 'SCHEDULED' }
        : null;
    },
    async getCase(id) {
      return id === CASE_A
        ? { caseId: CASE_A, courtId: COURT_A, status: 'ASSIGNED', assignedToSubject: 'mag-a' }
        : null;
    },
    async adjournHearing({ reason, nextStart, nextEnd, actorSubject, at }) {
      return {
        hearingId: HEARING_A,
        caseId: CASE_A,
        courtId: COURT_A,
        status: 'ADJOURNED',
        adjournmentReason: reason,
        nextStart,
        nextEnd,
        adjournedBy: actorSubject,
        adjournedAt: at
      };
    }
  };
  const outboxStore = { async enqueue(event) { events.push(event); return event; } };
  const service = new JudicialOperationsService({ repository, outboxStore });

  await service.adjournHearing(actor, HEARING_A, { reason: 'Sensitive free-text judicial reason' });

  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'hearing.adjourned');
  assert.equal(Object.hasOwn(events[0].payload, 'reason'), false);
});
