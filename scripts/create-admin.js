const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

async function main() {
  const envPath = fs.existsSync('.env') ? '.env' : '.env.example';
  require('dotenv').config({ path: envPath });

  const configuredAccount = [
    process.env.CHAIRPERSON_USERNAME,
    process.env.CHAIRPERSON_FULL_NAME,
    process.env.CHAIRPERSON_PASSWORD
  ];
  const configuredCount = configuredAccount.filter(Boolean).length;
  if (configuredCount > 0 && configuredCount < configuredAccount.length) {
    throw new Error('Set CHAIRPERSON_USERNAME, CHAIRPERSON_FULL_NAME, and CHAIRPERSON_PASSWORD together, or leave all three empty for interactive setup.');
  }

  let prompt;
  let connection;
  try {
    let username;
    let fullName;
    let password;
    if (configuredCount === configuredAccount.length) {
      [username, fullName, password] = configuredAccount;
      if (username.startsWith('change-') || password.startsWith('replace-')) {
        throw new Error(`Replace the chairperson account placeholders in ${envPath} before running this command.`);
      }
    } else {
      prompt = readline.createInterface({ input: stdin, output: stdout });
      username = (await prompt.question('Chairperson username: ')).trim();
      fullName = (await prompt.question('Chairperson full name: ')).trim();
      password = await prompt.question('Password (minimum 12 characters): ');
    }

    if (!/^[a-zA-Z0-9._-]{3,80}$/.test(username) || !fullName || fullName.length > 160 ||
        password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('Use a 3–80 character username, a full name of up to 160 characters, and a password of at least 12 characters and no more than 72 UTF-8 bytes.');
    }

    for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
      if (!process.env[name] || process.env[name].startsWith('replace-')) {
        throw new Error(`Set ${name} in ${envPath} before creating the chairperson account.`);
      }
    }

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.beginTransaction();
    try {
      const [chairpersons] = await connection.execute(
        "SELECT id FROM users WHERE role = 'chairperson' FOR UPDATE"
      );
      if (chairpersons.length > 1) {
        throw new Error('More than one chairperson account exists. Resolve the accounts before updating credentials.');
      }

      const chairpersonId = chairpersons.length ? chairpersons[0].id : null;
      const [usernameMatches] = await connection.execute(
        'SELECT id FROM users WHERE username = ? LIMIT 1',
        [username]
      );
      if (usernameMatches.length && String(usernameMatches[0].id) !== String(chairpersonId)) {
        throw new Error('That username is already assigned to another account.');
      }

      if (chairpersonId) {
        await connection.execute(
          'UPDATE users SET username = ?, password_hash = ?, full_name = ?, is_active = TRUE WHERE id = ?',
          [username, passwordHash, fullName, chairpersonId]
        );
        await connection.execute(
          `DELETE FROM sessions
           WHERE JSON_VALID(data)
             AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.user.id')) = ?`,
          [String(chairpersonId)]
        );
        await connection.commit();
        console.log('Chairperson account updated; existing chairperson sessions were signed out.');
      } else {
        await connection.execute(
          'INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)',
          [username, passwordHash, fullName, 'chairperson']
        );
        await connection.commit();
        console.log('Chairperson account created.');
      }
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (prompt) prompt.close();
    if (connection) await connection.end();
  }
}

main().catch((error) => {
  console.error(`Admin setup failed: ${error.message}`);
  process.exitCode = 1;
});
