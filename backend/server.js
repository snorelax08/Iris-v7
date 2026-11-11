
const express = require('express');
const path = require('path');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const { Pool } = require('pg');
require('dotenv').config();

const authRoutes = require('./auth');
const resolveRoutes = require('./routes/resolve');

const app = express();
const PORT = process.env.PORT || 8888;
const isProduction = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required.');
}

if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production.');
}

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json());

let sessionStore;

if (process.env.DATABASE_URL) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  const PostgreSQLStore = connectPgSimple(session);

  sessionStore = new PostgreSQLStore({
    pool,
    tableName: 'iris_sessions',
    createTableIfMissing: true
  });

  console.log('[Iris] PostgreSQL session storage enabled.');
} else {
  console.warn('[Iris] Using temporary in-memory sessions for local development.');
}

const sessionOptions = {
  name: 'iris.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
};

if (sessionStore) {
  sessionOptions.store = sessionStore;
}

app.use(session(sessionOptions));

app.use('/auth', authRoutes);
app.use('/api', resolveRoutes);

app.use('/shared', express.static(path.join(__dirname, '../shared')));
app.use(express.static(path.join(__dirname, '../frontend')));

app.listen(PORT, () => {
  console.log(`[Iris] Server running on port ${PORT}`);

  if (!process.env.SPOTIFY_REDIRECT_URI) {
    console.warn('[Iris] SPOTIFY_REDIRECT_URI is not configured.');
  } else {
    console.log(`[Iris] Spotify redirect URI: ${process.env.SPOTIFY_REDIRECT_URI}`);
  }
});
