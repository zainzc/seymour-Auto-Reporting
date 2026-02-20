const { OAuth2Client } = require('google-auth-library');
const ElectronStore = require('electron-store').default;
const { saveReportingConfig, getReportingConfig, saveInventoryConfig, getInventoryConfig } = require('../config/configStore');
const { loadEnv } = require('../config/loadEnv');
loadEnv();

// OAuth2 credentials from environment variables
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Redirect URI used by our local callback server
const REDIRECT_URI = 'http://localhost:9999/oauth2callback';

let oauth2Client = null;
const store = new ElectronStore({ encryptionKey: 'client-secret-key' });

/**
 * Initialize OAuth2 client
 */
function initOAuth2Client() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      'Google OAuth is not configured. Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment.'
    );
  }
  oauth2Client = new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  return oauth2Client;
}

/**
 * Get OAuth2 client instance
 */
function getOAuth2Client() {
  if (!oauth2Client) {
    initOAuth2Client();
  }
  return oauth2Client;
}

/**
 * Generate Google login URL
 * @returns {string} URL to send user to for login
 */
function getAuthUrl(context = 'reporting') {
  const client = getOAuth2Client();
  
  return client.generateAuthUrl({
    access_type: 'offline',  // Get refresh token
    redirect_uri: REDIRECT_URI,
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'consent',  // Always show consent screen
    state: context
  });
}

/**
 * Exchange authorization code for tokens
 * @param {string} code - Authorization code from Google
 * @returns {Promise<Object>} Token data
 */
async function getTokensFromCode(code, context = 'reporting') {
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    
    // Save tokens to scoped config (encrypted via Electron Store)
    if (context === 'inventory') {
      saveInventoryConfig('googleTokens', tokens);
    } else {
      saveReportingConfig('googleTokens', tokens);
    }
    
    console.log('✅ Google OAuth2 tokens saved');
    return tokens;
  } catch (error) {
    console.error('❌ Failed to exchange code for tokens:', error.message);
    throw error;
  }
}

/**
 * Get stored tokens from electron-store
 * @returns {Object|null} Stored tokens or null
 */
function getStoredTokens(context = 'reporting') {
  return context === 'inventory'
    ? getInventoryConfig('googleTokens')
    : getReportingConfig('googleTokens');
}

/**
 * Check if user is authenticated
 * @returns {boolean} True if tokens exist
 */
function isAuthenticated(context = 'reporting') {
  const tokens = getStoredTokens(context);
  if (!tokens || typeof tokens !== 'object') return false;
  if (Object.keys(tokens).length === 0) return false;
  if (!tokens.access_token || typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) return false;
  return true;
}

/**
 * Set tokens on OAuth2 client
 * @param {Object} tokens - Token object
 */
function setTokensOnClient(tokens) {
  const client = getOAuth2Client();
  client.setCredentials(tokens);
}

/**
 * Get authenticated OAuth2 client with user's tokens
 * @returns {OAuth2Client} Authenticated client
 */
function getAuthenticatedClient(context = 'reporting') {
  const tokens = getStoredTokens(context);
  
  if (!tokens || !tokens.access_token) {
    throw new Error('User not authenticated. Please connect to Google first.');
  }
  
  const client = getOAuth2Client();
  client.setCredentials(tokens);
  
  return client;
}

/**
 * Disconnect user (remove tokens)
 */
function disconnect(context = 'reporting') {
  const key = context === 'inventory'
    ? 'inventoryWebhook.googleTokens'
    : 'reporting.googleTokens';
  store.delete(key);
  console.log('✅ Google disconnected');
}

/**
 * Get user info from tokens
 * @returns {Promise<Object>} User info {email, name}
 */
async function getUserInfo(context = 'reporting') {
  try {
    const client = getAuthenticatedClient(context);
    const { google } = require('googleapis');
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const userInfo = await oauth2.userinfo.get();
    return {
      email: userInfo.data.email,
      name: userInfo.data.name,
      picture: userInfo.data.picture
    };
  } catch (error) {
    console.error('❌ Failed to get user info:', error.message);
    return null;
  }
}

module.exports = {
  initOAuth2Client,
  getOAuth2Client,
  getAuthUrl,
  getTokensFromCode,
  getStoredTokens,
  isAuthenticated,
  setTokensOnClient,
  getAuthenticatedClient,
  disconnect,
  getUserInfo
};
