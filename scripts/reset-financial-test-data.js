require('dotenv').config({ path: require('node:fs').existsSync('.env') ? '.env' : '.env.example' });
const mysql = require('mysql2/promise');

async function main() {
  if (process.env.CONFIRM_FINANCIAL_DATA_RESET !== 'YES') {
    throw new Error('Set CONFIRM_FINANCIAL_DATA_RESET=YES after confirming the financial data reset scope.');
  }
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
  });
  try {
    await connection.beginTransaction();
    const deleted = {};
    for (const table of [
      'subgroup_member_meeting_revisions',
      'subgroup_member_meeting_records',
      'subgroup_cashbook_revisions',
      'subgroup_cashbook_submissions',
      'loan_repayments',
      'repayment_schedule',
      'contributions',
      'meeting_cashbooks',
      'transactions',
      'loans'
    ]) {
      const [result] = await connection.execute(`DELETE FROM \`${table}\``);
      deleted[table] = result.affectedRows;
    }
    const [memberResult] = await connection.execute(
      'UPDATE members SET registration_fee_paid = 0.00 WHERE registration_fee_paid <> 0.00'
    );
    deleted.members_registration_fee_reset = memberResult.affectedRows;
    await connection.execute(
      `UPDATE subgroup_cashbook_config
       SET opening_balance = 0.00, effective_from = CURRENT_DATE
       WHERE id = 1`
    );
    await connection.commit();
    console.log('Financial records cleared. Users, members, meetings, attendance and subgroup meeting notes were preserved.');
    console.log(JSON.stringify(deleted, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Financial test data reset failed: ${error.message}`);
  process.exitCode = 1;
});
