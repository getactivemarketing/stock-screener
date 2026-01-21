import pg from "pg";
const DATABASE_URL = "postgresql://postgres:WMxIRbXdhNvmSMIBIayQYyfSXeATlQCE@switchyard.proxy.rlwy.net:15765/railway";
const { Pool } = pg;
const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 3e4
});
async function query(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}
export {
  query as q
};
