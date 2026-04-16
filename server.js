require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3001;

// Supabase клиент
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

app.use(cors({ origin: ['https://apf-app.vercel.app', 'http://localhost:5173'] }));
app.use(express.json());

// Авторизация
app.post('/api/auth/telegram', async (req, res) => {
  try {
    const { user } = req.body;
    if (!user || !user.id) return res.status(400).json({ error: 'User data missing' });
    const userId = `user_${user.id}`;
    const username = user.username || `${user.first_name} ${user.last_name || ''}`.trim();
    const photoUrl = user.photo_url;

    let { data: existingUser, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();
    if (selectError && selectError.code !== 'PGRST116') throw selectError;

    if (!existingUser) {
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([{ id: userId, username, photo_url: photoUrl, level: 1, experience: 0, exp_points: 1, coins: 100, tickets: 0, ton: 0 }])
        .select()
        .single();
      if (insertError) throw insertError;
      existingUser = newUser;
    } else {
      await supabase.from('users').update({ username, photo_url: photoUrl, updated_at: new Date() }).eq('id', userId);
    }

    const token = jwt.sign({ userId: existingUser.id, username: existingUser.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: existingUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Профиль
app.get('/api/user/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
    const token = authHeader.split(' ')[1];
    let decoded;
    try { decoded = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }
    const { data: user, error } = await supabase.from('users').select('*').eq('id', decoded.userId).single();
    if (error) throw error;
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Список турниров
app.get('/api/tournaments', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tournaments').select('*').order('date', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Бойцы турнира
app.get('/api/tournaments/:id/fighters', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id);
    const { data, error } = await supabase.from('fighters').select('*').eq('tournament_id', tournamentId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Создание ставки (исправлено: убран .single(), добавлена проверка)
app.post('/api/bets', async (req, res) => {
  try {
    const { userId, tournamentId, betAmount, selections } = req.body;
    if (!userId || !tournamentId || !betAmount || !selections || selections.length !== 5) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    // Проверка баланса
    const { data: user, error: userError } = await supabase.from('users').select('coins').eq('id', userId).single();
    if (userError) throw userError;
    if (user.coins < betAmount) return res.status(400).json({ error: 'Not enough coins' });

    // Списание монет
    const { error: updateError } = await supabase.from('users').update({ coins: user.coins - betAmount }).eq('id', userId);
    if (updateError) throw updateError;

    // Сохранение ставки
    const totalDamage = selections.reduce((sum, sel) => sum + (sel.fighter.TotalDamage || 0), 0);
    const { data: bet, error: betError } = await supabase
      .from('bets')
      .insert([{ user_id: userId, tournament_id: tournamentId, bet_amount: betAmount, total_damage: totalDamage, selections: selections }])
      .select();

    if (betError) throw betError;
    if (!bet || bet.length === 0) throw new Error('Failed to insert bet');

    res.json({ success: true, bet: bet[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Получить ставку пользователя для турнира
app.get('/api/bets/user/:userId/tournament/:tournamentId', async (req, res) => {
  try {
    const { userId, tournamentId } = req.params;
    const { data, error } = await supabase
      .from('bets')
      .select('*')
      .eq('user_id', userId)
      .eq('tournament_id', tournamentId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    res.json(data || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Получить все ставки пользователя
app.get('/api/bets/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase.from('bets').select('*').eq('user_id', userId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Уведомления (заглушки)
app.get('/api/notifications', async (req, res) => res.json([]));
app.post('/api/notifications/claim-all', async (req, res) => res.json({ success: true }));

// PvP (заглушка)
app.post('/api/pvp/start', async (req, res) => res.status(501).json({ error: 'Not implemented' }));

app.listen(port, () => console.log(`Server running on port ${port}`));