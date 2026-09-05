'use strict';
const { randomUUID } = require('node:crypto');

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

class AuditStore {
  #events = [];
  append(event) {
    if (!event?.actorUserId) throw new Error('Audit actorUserId is required');
    if (!event?.action) throw new Error('Audit action is required');
    if (!event?.resourceType) throw new Error('Audit resourceType is required');
    const record = freezeClone({
      auditEventId: randomUUID(),
      eventTime: new Date().toISOString(),
      ...event
    });
    this.#events.push(record);
    return record;
  }
  list(filter = {}) {
    return this.#events
      .filter(e => Object.entries(filter).every(([k,v]) => e[k] === v))
      .map(freezeClone);
  }
}

module.exports = { AuditStore };
