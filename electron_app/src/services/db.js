const sql = require('mssql/msnodesqlv8');  // Use Windows ODBC driver (like sqlcmd)
const { getDbConfig } = require('../config/configStore');

let pool = null;

function toSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatMssqlError(err) {
  if (!err) return 'Unknown MSSQL error';

  const parts = [];
  const topMessage = err.message;
  if (typeof topMessage === 'string' && topMessage && topMessage !== '[object Object]') {
    parts.push(toSingleLine(topMessage));
  }

  if (err.code) parts.push(`code=${err.code}`);
  if (err.number !== undefined) parts.push(`number=${err.number}`);
  if (err.state !== undefined) parts.push(`state=${err.state}`);
  if (err.sqlState) parts.push(`sqlState=${err.sqlState}`);

  const original = err.originalError;
  if (original) {
    const originalMessage = original.message || original.toString();
    if (originalMessage) {
      parts.push(`original=${toSingleLine(originalMessage)}`);
    }
    if (original.code) parts.push(`originalCode=${original.code}`);
    if (original.sqlstate) parts.push(`originalSqlState=${original.sqlstate}`);
  }

  if (Array.isArray(err.precedingErrors) && err.precedingErrors.length) {
    const details = err.precedingErrors
      .map((e) => toSingleLine(e?.message || e))
      .filter(Boolean)
      .join(' | ');
    if (details) parts.push(`preceding=${details}`);
  }

  if (!parts.length) {
    try {
      return JSON.stringify(err);
    } catch (_) {
      return toSingleLine(err.toString());
    }
  }

  return parts.join(' ; ');
}

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
    const errorMessage = formatMssqlError(err);
    console.error('❌ Connection error:', {
      message: errorMessage,
      code: err.code,
      originalError: err.originalError?.message,
      precedingErrors: err.precedingErrors
    });
    throw new Error(`Failed to connect to ${serverName} - ${errorMessage}`);
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
  const serverName = String(serverAddress || '').trim();
  const databaseName = String(database || '').trim();
  const connectTimeoutSec = Number(process.env.DB_CONNECT_TIMEOUT_SEC || 30);
  const requestTimeoutMs = Number(process.env.DB_REQUEST_TIMEOUT_MS || 120000);
  const queryTimeoutSec = Math.ceil(requestTimeoutMs / 1000);

  const windowsAuthConfig = {
    connectionString: `Driver={ODBC Driver 18 for SQL Server};Server=${serverName};Database=${databaseName};Trusted_Connection=yes;TrustServerCertificate=yes;Connection Timeout=${connectTimeoutSec};Query Timeout=${queryTimeoutSec};`,
    connectionTimeout: connectTimeoutSec * 1000,
    requestTimeout: requestTimeoutMs,
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };

  console.log(`🔐 Attempting connection with Windows Authentication to ${serverName}...`);

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
    const errorMessage = formatMssqlError(err);
    console.error('❌ Connection error:', {
      message: errorMessage,
      code: err.code,
      originalError: err.originalError?.message,
      precedingErrors: err.precedingErrors
    });
    throw new Error(`Failed to connect with Windows Auth - ${errorMessage}`);
  }
}

module.exports = {
  initDb,
  initDbWindowsAuth,
  getDB,
};
