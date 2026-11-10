const test = require('node:test');
const assert = require('node:assert/strict');
const MySQLSessionStore = require('../src/mysql-session-store');

function callbackResult(action) {
  return new Promise((resolve, reject) => {
    action((error, result) => error ? reject(error) : resolve(result));
  });
}

test('stores and reads an express session as JSON', async () => {
  const calls = [];
  const stored = { session_id: 'session-id', data: '{"user":{"id":7}}' };
  const pool = {
    execute: async (sql, values) => {
      calls.push({ sql, values });
      return sql.startsWith('SELECT') ? [[stored]] : [{ affectedRows: 1 }];
    }
  };
  const store = new MySQLSessionStore(pool);
  const sessionData = { cookie: { maxAge: 60000 }, user: { id: 7 } };

  await callbackResult((callback) => store.set('session-id', sessionData, callback));
  const result = await callbackResult((callback) => store.get('session-id', callback));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[0], 'session-id');
  assert.deepEqual(JSON.parse(calls[0].values[2]), sessionData);
  assert.deepEqual(result, { user: { id: 7 } });
});

test('reports malformed stored session data instead of hiding it', async () => {
  const store = new MySQLSessionStore({
    execute: async () => [[{ data: '{invalid' }]]
  });

  await assert.rejects(callbackResult((callback) => store.get('session-id', callback)));
});

test('deletes and touches sessions using prepared statements', async () => {
  const calls = [];
  const store = new MySQLSessionStore({
    execute: async (sql, values) => {
      calls.push({ sql, values });
      return [{ affectedRows: 1 }];
    }
  });
  const data = { cookie: { maxAge: 60000 } };

  await callbackResult((callback) => store.touch('session-id', data, callback));
  await callbackResult((callback) => store.destroy('session-id', callback));

  assert.match(calls[0].sql, /WHERE session_id = \?/);
  assert.deepEqual(calls[0].values[1], 'session-id');
  assert.match(calls[1].sql, /WHERE session_id = \?/);
  assert.deepEqual(calls[1].values, ['session-id']);
});
