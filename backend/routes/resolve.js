
'use strict';

const express = require('express');
const { getValidAccessToken } = require('../auth');
const { resolveSong } = require('../music/resolver');
const { searchTracks } = require('../music/spotifySearch');
const llm = require('../music/llm');
const { extractIntent } = require('../../shared/intent');

const router = express.Router();

router.post('/resolve', async (req, res) => {
  const body = req.body || {};
  const query = typeof body.query === 'string' ? body.query.slice(0, 200) : '';

  if (!query.trim()) {
    return res.status(400).json({ error: 'missing_query' });
  }

  const alternatives = Array.isArray(body.alternatives)
    ? body.alternatives
        .filter((a) => typeof a === 'string')
        .map((a) => a.slice(0, 200))
        .slice(0, 4)
    : [];

  const deps = {
    search: (q) =>
      searchTracks(
        q,
        () => getValidAccessToken(req),
        {
          cacheScope: req.session.spotifyUserId || req.sessionID
        }
      ),
    llm: {
      enabled: llm.enabled,
      extract: llm.llmExtract
    }
  };

  try {
    const result = await resolveSong(
      { query, alternatives, implicit: !!body.implicit },
      deps
    );

    const top = result.track || (result.options && result.options[0]);

    console.log(
      `[Iris:resolve] "${query}" -> ${result.action}` +
        (top ? ` ${top.name} — ${top.artists.join(', ')} (${top.score})` : '') +
        ` [${result.source}, ${result.debug.ms}ms, ${result.debug.queries.length} queries]`
    );

    res.json(result);
  } catch (err) {
    const status = err.status === 401 ? 401 : 502;
    console.error('[Iris:resolve] failed:', err.message);
    res.status(status).json({ error: err.message });
  }
});

router.get('/intent', (req, res) => {
  res.json(extractIntent(String(req.query.text || '')));
});

module.exports = router;
