
'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
require('dotenv').config();

const router = express.Router();

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

const encryptionKeyHex = process.env.TOKEN_ENCRYPTION_KEY || '';

if (!/^[0-9a-fA-F]{64}$/.test(encryptionKeyHex)) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters.');
}

const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');

// Avoid simultaneous refresh requests for the same browser session.
const refreshPromises = new Map();

function createError(message, status = 401) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function encryptTokenBundle(bundle) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(bundle), 'utf8'),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join('.');
}

function decryptTokenBundle(value) {
  if (typeof value !== 'string') {
    throw createError('not_logged_in');
  }

  try {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid encrypted token format');

    const [ivPart, tagPart, encryptedPart] = parts;

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(ivPart, 'base64')
    );

    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64')),
      decipher.final()
    ]);

    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    throw createError('token_decryption_failed');
  }
}

function safeStateMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') {
    return false;
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(received);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSpotifyConfig() {
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Spotify OAuth environment variables are incomplete.');
  }
}

function spotifyAuthHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization:
      'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  };
}

// Step 1: Start a Spotify OAuth login for this browser session.
router.get('/login', async (req, res) => {
  try {
    requireSpotifyConfig();

    const state = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = state;

    await saveSession(req);

    const scope = [
      'streaming',
      'user-read-email',
      'user-read-private',
      'user-read-playback-state',
      'user-modify-playback-state'
    ].join(' ');

    const authorizeUrl =
      'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id: clientId,
        scope,
        redirect_uri: redirectUri,
        state
      });

    res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[Iris:auth] Login initialization failed:', err.message);
    res.status(500).send('Spotify login could not be started.');
  }
});

// Step 2: Handle Spotify's OAuth callback.
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (req.query.error) {
    return res.redirect('/?error=access_denied');
  }

  if (typeof code !== 'string' ||
      !safeStateMatch(req.session.oauthState, state)) {
    return res.redirect('/?error=invalid_state');
  }

  try {
    requireSpotifyConfig();

    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
      { headers: spotifyAuthHeaders() }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    if (!access_token || !refresh_token) {
      throw new Error('Spotify did not return the expected token bundle.');
    }

    // Capture the Spotify account ID for account-scoped search caching.
    const profile = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 5000
    });

    // Regenerate the session ID after successful authentication.
    await regenerateSession(req);

    req.session.spotifyTokens = encryptTokenBundle({
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000
    });

    req.session.spotifyUserId = profile.data.id;
    req.session.spotifyDisplayName = profile.data.display_name || null;
    req.session.lastRefreshedAt = Date.now();
    req.session.lastKnownDeviceId = null;

    await saveSession(req);

    console.log('[Iris:auth] Spotify login successful for a browser session.');
    res.redirect('/?logged_in=true');
  } catch (err) {
    console.error(
      '[Iris:auth] Callback failed:',
      err.response ? `Spotify returned ${err.response.status}` : err.message
    );

    res.redirect('/?error=invalid_token');
  }
});

// Refresh tokens belonging only to this browser session.
async function performTokenRefresh(req, bundle) {
  if (!bundle.refresh_token) {
    throw createError('no_refresh_token');
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: bundle.refresh_token
      }),
      { headers: spotifyAuthHeaders() }
    );

    return {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token || bundle.refresh_token,
      expires_at: Date.now() + (response.data.expires_in || 3600) * 1000
    };
  } catch (err) {
    console.error(
      '[Iris:auth] Token refresh failed:',
      err.response ? `Spotify returned ${err.response.status}` : err.message
    );

    throw createError('refresh_failed');
  }
}

async function refreshAccessToken(req, bundle) {
  const sessionId = req.sessionID;

  if (refreshPromises.has(sessionId)) {
    return refreshPromises.get(sessionId);
  }

  const refreshPromise = performTokenRefresh(req, bundle);
  refreshPromises.set(sessionId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (refreshPromises.get(sessionId) === refreshPromise) {
      refreshPromises.delete(sessionId);
    }
  }
}

// Single source of truth for getting a usable access token.
async function getValidAccessToken(req) {
  if (!req || !req.session || !req.session.spotifyTokens) {
    throw createError('not_logged_in');
  }

  let bundle = decryptTokenBundle(req.session.spotifyTokens);

  if (!bundle.access_token) {
    throw createError('not_logged_in');
  }

  if (Date.now() > bundle.expires_at - 60 * 1000) {
    bundle = await refreshAccessToken(req, bundle);

    req.session.spotifyTokens = encryptTokenBundle(bundle);
    req.session.lastRefreshedAt = Date.now();

    await saveSession(req);
  }

  return bundle.access_token;
}

// Frontend obtains a short-lived access token for the Spotify Web Playback SDK.
router.get('/token', async (req, res) => {
  try {
    const accessToken = await getValidAccessToken(req);
    res.json({ access_token: accessToken });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
});

// Each browser sees only its own login status.
router.get('/status', (req, res) => {
  res.json({
    logged_in: !!(req.session && req.session.spotifyTokens)
  });
});

// Store the playback device ID in this user's session, not globally.
router.post('/device', (req, res) => {
  const deviceId = req.body && req.body.device_id;

  if (deviceId && typeof deviceId === 'string') {
    req.session.lastKnownDeviceId = deviceId;
    console.log('[Iris:device] Browser session reported a playback device.');

    req.session.save((err) => {
      if (err) return res.status(500).json({ ok: false });
      res.json({ ok: true });
    });

    return;
  }

  res.json({ ok: true });
});

// Safe diagnostics. Never return Spotify tokens or encryption material.
router.get('/debug', (req, res) => {
  let bundle = null;

  try {
    if (req.session.spotifyTokens) {
      bundle = decryptTokenBundle(req.session.spotifyTokens);
    }
  } catch {
    bundle = null;
  }

  const expiresAt = bundle ? bundle.expires_at : null;

  res.json({
    logged_in: !!bundle,
    has_refresh_token: !!(bundle && bundle.refresh_token),
    token_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    seconds_until_expiry: expiresAt
      ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
      : null,
    last_refreshed_at: req.session.lastRefreshedAt
      ? new Date(req.session.lastRefreshedAt).toISOString()
      : null,
    last_known_device_id: req.session.lastKnownDeviceId || null,
    configured_redirect_uri: redirectUri || null
  });
});

// Log out only the current browser session.
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'logout_failed' });
    }

    res.clearCookie('iris.sid', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    res.json({ ok: true });
  });
});

module.exports = router;
module.exports.getValidAccessToken = getValidAccessToken;
