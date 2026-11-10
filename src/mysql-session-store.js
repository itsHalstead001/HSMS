const session = require('express-session');

function expirationTime(sessionData) {
  const cookie = sessionData.cookie || {};
  if (cookie.expires) return new Date(cookie.expires).getTime();
  const maxAge = Number(cookie.maxAge);
  return Date.now() + (Number.isFinite(maxAge) && cookie.maxAge != null ? Math.max(maxAge, 0) : 24 * 60 * 60 * 1000);
}

class MySQLSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
  }

  get(sessionId, callback) {
    this.pool.execute(
      'SELECT data FROM sessions WHERE session_id = ? AND expires > ?',
      [sessionId, Math.floor(Date.now() / 1000)]
    ).then(([rows]) => {
      callback(null, rows.length ? JSON.parse(rows[0].data) : null);
    }).catch(callback);
  }

  set(sessionId, sessionData, callback) {
    const expiresAt = expirationTime(sessionData);
    if (!Number.isFinite(expiresAt)) {
      return callback(new Error('Cannot save a session with an invalid expiration date.'));
    }

    this.pool.execute(
      `INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
      [sessionId, Math.floor(expiresAt / 1000), JSON.stringify(sessionData)]
    ).then(() => callback(null)).catch(callback);
  }

  touch(sessionId, sessionData, callback) {
    const expiresAt = expirationTime(sessionData);
    if (!Number.isFinite(expiresAt)) {
      return callback(new Error('Cannot update a session with an invalid expiration date.'));
    }

    this.pool.execute(
      'UPDATE sessions SET expires = ? WHERE session_id = ?',
      [Math.floor(expiresAt / 1000), sessionId]
    ).then(() => callback(null)).catch(callback);
  }

  destroy(sessionId, callback) {
    this.pool.execute('DELETE FROM sessions WHERE session_id = ?', [sessionId])
      .then(() => callback(null)).catch(callback);
  }
}

module.exports = MySQLSessionStore;
