const sql = require('mssql/msnodesqlv8');  // Use Windows ODBC driver (like sqlcmd)
const { getDbConfig } = require('../config/configStore');

let pool = null;

async function initDb() {
  const config = getDbConfig();
  console.log('Database config:', config);
  
  if (!config) {
    throw new Error('Database config not found');
  }

  // Use server name exactly as provided - no port parsing
  // Let SQL Server Browser handle the connection like SSMS does
  const serverName = config.server.trim();
  const connectTimeoutSec = Number(process.env.DB_CONNECT_TIMEOUT_SEC || 30);
  const requestTimeoutMs = Number(process.env.DB_REQUEST_TIMEOUT_MS || 120000);
  const queryTimeoutSec = Math.ceil(requestTimeoutMs / 1000);

  const poolConfig = {
    connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${serverName};Database=${config.database};Uid=${config.user};Pwd=${config.password};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=${connectTimeoutSec};Query Timeout=${queryTimeoutSec};`,
    connectionTimeout: connectTimeoutSec * 1000,
    requestTimeout: requestTimeoutMs,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

  console.log(`🔐 Attempting connection to ${serverName} (${config.user})...`);

  pool = new sql.ConnectionPool(poolConfig);

  // ⚠️ CRITICAL: Always attach error listener per official docs
  pool.on('error', err => {
    console.error('❌ Unexpected error on MSSQL connection pool:', err);
  });

  try {
    await pool.connect();
    console.log('✅ MSSQL database connected successfully');
  } catch (err) {
    pool = null;  // Reset pool on connection failure
    console.error('❌ Connection error:', {
      message: err.message,
      code: err.code,
      originalError: err.originalError?.message
    });
    throw new Error(`Failed to connect to ${serverName} - ${err.message}`);
  }

  return pool;
}

function getDB() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

// Windows Authentication Method
async function initDbWindowsAuth(serverAddress, database) {
  const windowsAuthConfig = {
    connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${serverAddress};Database=${database};Trusted_Connection=yes;TrustServerCertificate=yes;`
  };

  console.log(`🔐 Attempting connection with Windows Authentication to ${serverAddress}...`);

  try {
    pool = new sql.ConnectionPool(windowsAuthConfig);

    // ⚠️ CRITICAL: Always attach error listener per official docs
    pool.on('error', err => {
      console.error('❌ Unexpected error on MSSQL connection pool:', err);
    });

    await pool.connect();
    console.log('✅ MSSQL database connected successfully (Windows Auth)');
    return pool;
  } catch (err) {
    pool = null;  // Reset pool on connection failure
    console.error('❌ Connection error:', {
      message: err.message,
      code: err.code,
      originalError: err.originalError?.message
    });
    throw new Error(`Failed to connect with Windows Auth - ${err.message}`);
  }
}

module.exports = {
  initDb,
  initDbWindowsAuth,
  getDB,
};
