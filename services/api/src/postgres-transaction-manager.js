'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

function transactionControl(query) {
  const text = typeof query === 'string' ? query : query?.text;
  const normalized = String(text || '').trim().replace(/;$/, '').toUpperCase();
  return normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK';
}

function emptyQueryResult() {
  return { rows: [], rowCount: 0, command: null, fields: [] };
}

class PostgresTransactionManager {
  constructor(database) {
    if (!database || typeof database.query !== 'function' || typeof database.connect !== 'function') {
      throw new TypeError('PostgresTransactionManager requires a pg-compatible database with query() and connect()');
    }
    this.database = database;
    this.storage = new AsyncLocalStorage();
  }

  get options() {
    return this.database.options;
  }

  get lastSql() {
    return this.database.lastSql;
  }

  get inTransaction() {
    return Boolean(this.storage.getStore()?.client);
  }

  query(query, values, callback) {
    const client = this.storage.getStore()?.client;
    return (client || this.database).query(query, values, callback);
  }

  async connect(...args) {
    const active = this.storage.getStore()?.client;
    if (!active) return this.database.connect(...args);

    return {
      query(query, values, callback) {
        if (transactionControl(query)) {
          const result = emptyQueryResult();
          if (typeof callback === 'function') {
            queueMicrotask(() => callback(null, result));
            return undefined;
          }
          return Promise.resolve(result);
        }
        return active.query(query, values, callback);
      },
      release() {}
    };
  }

  async withTransaction(work) {
    if (typeof work !== 'function') throw new TypeError('withTransaction requires a function');

    if (this.storage.getStore()?.client) return work();

    const client = await this.database.connect();
    let began = false;
    try {
      await client.query('BEGIN');
      began = true;
      return await this.storage.run({ client }, async () => {
        try {
          const result = await work();
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            if (error && typeof error === 'object' && !error.rollbackError) error.rollbackError = rollbackError;
          }
          throw error;
        }
      });
    } catch (error) {
      if (began && !this.storage.getStore()?.client && !String(error?.message || '').includes('ROLLBACK')) {
        // Errors thrown inside storage.run already attempted rollback. This branch is
        // primarily for failures before the async context is established.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { PostgresTransactionManager, transactionControl };
