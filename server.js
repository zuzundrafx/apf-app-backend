require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

const corsOptions = {
    origin: ['https://apf-app.vercel.app', 'http://localhost:5173'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
  };
  app.use(cors(corsOptions));
  // Не нужно отдельно вызывать app.options('*', ...)
app.use(express.json());

// --- Авторизация ---
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user || !user.id) {
      return res.status(400).json({ error: 'User data missing' });
    }
    const userId = `user_${user.id}`;
    const username = user.username || `${user.first_name} ${user.last_name || ''}`.trim();
    const photoUrl = user.photo_url;

    let existingUser = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (existingUser.rows.length === 0) {
      await pool.query(
        `INSERT INTO users (id, username, photo_url, level, experience, exp_points, coins, tickets, ton)
         VALUES ($1, $2, $3, 1, 0, 1, 100, 0, 0)`,
        [userId, username, photoUrl]
      );
    } else {
      await pool.query(
        'UPDATE users SET username = $1, photo_url = $2, updated_at = NOW() WHERE id = $3',
        [username, photoUrl, userId]
      );
    }

    const userData = (await pool.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    const token = jwt.sign({ userId: userData.id, username: userData.username }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: userData.id,
        username: userData.username,
        photoUrl: userData.photo_url,
        level: userData.level,
        experience: userData.experience,
        expPoints: userData.exp_points,
        coins: userData.coins,
        tickets: userData.tickets,
        ton: userData.ton
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Профиль ---
app.get('/api/user/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId])).rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Список турниров ---
app.get('/api/tournaments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM tournaments ORDER BY date DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Бойцы турнира ---
app.get('/api/tournaments/:id/fighters', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id);
    const result = await pool.query('SELECT * FROM fighters WHERE tournament_id = $1', [tournamentId]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Создание ставки ---
app.post('/api/bets', async (req, res) => {
  try {
    const { userId, tournamentId, betAmount, selections } = req.body;
    if (!userId || !tournamentId || !betAmount || !selections || selections.length !== 5) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    // Проверка баланса
    const userRes = await pool.query('SELECT coins FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const userCoins = userRes.rows[0].coins;
    if (userCoins < betAmount) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    // Списание монет
    await pool.query('UPDATE users SET coins = coins - $1, updated_at = NOW() WHERE id = $2', [betAmount, userId]);

    // Подсчёт totalDamage
    const totalDamage = selections.reduce((sum, sel) => sum + (sel.fighter.TotalDamage || 0), 0);

    // Сохранение ставки
    const result = await pool.query(
      `INSERT INTO bets (user_id, tournament_id, bet_amount, total_damage, selections, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING *`,
      [userId, tournamentId, betAmount, totalDamage, JSON.stringify(selections)]
    );

    res.json({ success: true, bet: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Получение ставки пользователя на турнир ---
app.get('/api/bets/user/:userId/tournament/:tournamentId', async (req, res) => {
  try {
    const { userId, tournamentId } = req.params;
    const result = await pool.query(
      'SELECT * FROM bets WHERE user_id = $1 AND tournament_id = $2',
      [userId, tournamentId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bet not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Уведомления (заглушка) ---
app.get('/api/notifications', async (req, res) => {
  // Пока возвращаем пустой массив
  res.json([]);
});

app.post('/api/notifications/claim-all', async (req, res) => {
  res.json({ success: true });
});

// --- PvP (заглушка) ---
app.post('/api/pvp/start', async (req, res) => {
  res.status(501).json({ error: 'Not implemented yet' });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});