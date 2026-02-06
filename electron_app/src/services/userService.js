const { getDB } = require('./db');
const axios = require('axios');
const { getWebhookConfig } = require('../config/configStore');

async function getAllTables() {
  const pool = getDB();
  const result = await pool.request().query(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' AND TABLE_CATALOG = DB_NAME()`
  );
  return result.recordset.map(t => t.TABLE_NAME);
}

async function getTableData(tableName) {
  const pool = getDB();
  const result = await pool.request().query(`SELECT * FROM [${tableName}]`);
  return result.recordset;
}

async function getUsers() {
  return await getTableData('users');
}

async function syncTables(tableNames) {
  const webhook = getWebhookConfig();

  if (!webhook) {
    throw new Error('Webhook not configured');
  }

  const syncData = {};
  for (const tableName of tableNames) {
    syncData[tableName] = await getTableData(tableName);
  }

  const response = await axios.post(webhook, syncData);
  return response.data;
}

async function syncUsers(users) {
  const webhook = getWebhookConfig();

  if (!webhook) {
    throw new Error('Webhook not configured');
  }

  const response = await axios.post(webhook, { users });
  return response.data;
}

module.exports = { getUsers, syncUsers, getAllTables, getTableData, syncTables };
