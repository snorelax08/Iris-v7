
'use strict';

const axios = require('axios');

const SEARCH_URL = 'https://api.spotify.com/v1/search';
const LIMIT = Math.max(
  1,
  Math.min(50, parseInt(process.env.AKON_SEARCH_LIMIT || '10', 10) || 10)
);

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cacheGet(key) {
  const hit = cache.get(key);

  if (!hit) return null;

  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }

  cache.delete(key);
  cache.set(key, hit);

  return hit.items;
}

function cacheSet(key, items) {
  cache.set(key, { at: Date.now(), items });

  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

async function searchTracks(
  query,
  getToken,
  { retries = 1, cacheScope = 'default' } = {}
) {
  // Authenticate before checking the cache.
  const token = await getToken();

  // Each Spotify account gets its own market-specific search cache.
  const cacheKey = `${cacheScope}:${query}`;
  const cached = cacheGet(cacheKey);

  if (cached) return cached;

  try {
    const res = await axios.get(SEARCH_URL, {
      params: {
        q: query,
        type: 'track',
        limit: LIMIT,
        market: 'from_token'
      },
      headers: {
        Authorization: `Bearer ${token}`
      },
      timeout: 4000
    });

    const items =
      (res.data && res.data.tracks && res.data.tracks.items) || [];

    cacheSet(cacheKey, items);

    return items;
  } catch (err) {
    const status = err.response && err.response.status;

    if (
      retries > 0 &&
      (status === 429 || (status >= 500 && status < 600))
    ) {
      const retryAfter = parseInt(
        (err.response.headers || {})['retry-after'] || '1',
        10
      );

      await sleep(Math.min(2000, Math.max(250, retryAfter * 1000)));

      return searchTracks(query, getToken, {
        retries: retries - 1,
        cacheScope
      });
    }

    const error = new Error(
      `spotify_search_failed:${status || err.code || err.message}`
    );

    error.status = status;
    throw error;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { searchTracks, clearCache };
