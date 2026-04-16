// server.js (обновлённый)
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

app.use(cors({
  origin: ['https://apf-app.vercel.app', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json());

// Middleware для проверки JWT
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { userId, username }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- АВТОРИЗАЦИЯ ----------
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
        .insert([{
          id: userId,
          username,
          photo_url: photoUrl,
          level: 1,
          experience: 0,
          exp_points: 1,
          coins: 100,
          tickets: 0,
          ton: 0
        }])
        .select()
        .single();
      if (insertError) throw insertError;
      existingUser = newUser;
    } else {
      await supabase.from('users')
        .update({ username, photo_url: photoUrl, updated_at: new Date() })
        .eq('id', userId);
    }

    const token = jwt.sign(
      { userId: existingUser.id, username: existingUser.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, user: existingUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ПРОФИЛЬ ----------
app.get('/api/user/profile', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', req.user.userId)
      .single();
    if (error) throw error;
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ТУРНИРЫ ----------
app.get('/api/tournaments', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tournaments')
      .select('*')
      .order('date', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- БОЙЦЫ ТУРНИРА ----------
app.get('/api/tournaments/:id/fighters', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id);
    const { data, error } = await supabase
      .from('fighters')
      .select('*')
      .eq('tournament_id', tournamentId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СТАВКИ ----------
app.post('/api/bets', authenticate, async (req, res) => {
  try {
    const { tournamentId, betAmount, selections } = req.body;
    const userId = req.user.userId;

    // Валидация
    if (!tournamentId || !betAmount || !selections || selections.length !== 5) {
      return res.status(400).json({ error: 'Invalid data: need 5 selections' });
    }

    // Проверить, что все 5 весовых категорий различны
    const weightClasses = selections.map(s => s.weightClass);
    if (new Set(weightClasses).size !== 5) {
      return res.status(400).json({ error: 'All weight classes must be different' });
    }

    // Проверить, что турнир имеет статус upcoming
    const { data: tournament, error: tournError } = await supabase
      .from('tournaments')
      .select('status')
      .eq('id', tournamentId)
      .single();
    if (tournError) throw tournError;
    if (tournament.status !== 'upcoming') {
      return res.status(400).json({ error: 'Tournament is not open for betting' });
    }

    // Проверить баланс
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('coins')
      .eq('id', userId)
      .single();
    if (userError) throw userError;
    if (user.coins < betAmount) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    // Списать монеты
    const { error: updateError } = await supabase
      .from('users')
      .update({ coins: user.coins - betAmount })
      .eq('id', userId);
    if (updateError) throw updateError;

    // Рассчитать предварительный totalDamage (до результатов боёв) – сумма переданных TotalDamage
    const totalDamage = selections.reduce((sum, sel) => sum + (sel.fighter.TotalDamage || 0), 0);

    // Сохранить ставку
    const { data: bet, error: betError } = await supabase
      .from('bets')
      .insert([{
        user_id: userId,
        tournament_id: tournamentId,
        bet_amount: betAmount,
        total_damage: totalDamage,
        selections: selections,
        cancelled: false,
        reward_accepted: false
      }])
      .select();

    if (betError) throw betError;
    if (!bet || bet.length === 0) throw new Error('Failed to insert bet');

    res.json({ success: true, bet: bet[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Получить все ставки пользователя
app.get('/api/bets/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { data, error } = await supabase
      .from('bets')
      .select('*')
      .eq('user_id', userId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Получить ставку пользователя на конкретный турнир
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

// ---------- УВЕДОМЛЕНИЯ ----------
app.get('/api/notifications', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.userId)
      .eq('claimed', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/claim-all', authenticate, async (req, res) => {
  try {
    const userId = req.user.userId;
    // Получить все непрочитанные уведомления
    const { data: notifications, error: notifError } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', userId)
      .eq('claimed', false);
    if (notifError) throw notifError;

    let totalCoins = 0;
    let totalTickets = 0;
    let totalExp = 0;

    for (const n of notifications) {
      if (n.type === 'tournament_reward') {
        totalCoins += n.data.coins || 0;
        totalTickets += n.data.tickets || 0;
        totalExp += n.data.experience || 0;
      } else if (n.type === 'bet_cancelled') {
        totalCoins += n.data.refundAmount || 0;
      }
    }

    if (totalCoins > 0 || totalTickets > 0 || totalExp > 0) {
      // Получить текущие значения пользователя
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('coins, tickets, experience, level, exp_points')
        .eq('id', userId)
        .single();
      if (userError) throw userError;

      const newCoins = user.coins + totalCoins;
      const newTickets = user.tickets + totalTickets;
      const newExp = user.experience + totalExp;

      // Рассчитать новый уровень (логика из фронта, упрощённо)
      const LEVEL_THRESHOLDS = [5, 10, 15, 20, 25, 30, 35, 40, 45];
      let level = user.level;
      let expForNext = LEVEL_THRESHOLDS[level - 1] || 0;
      let remainingExp = newExp;
      for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
        if (remainingExp >= LEVEL_THRESHOLDS[i]) {
          remainingExp -= LEVEL_THRESHOLDS[i];
          level = i + 2;
        } else break;
      }
      let newExpPoints = user.exp_points;
      if (level > user.level) newExpPoints += (level - user.level);

      await supabase.from('users')
        .update({
          coins: newCoins,
          tickets: newTickets,
          experience: newExp,
          level: level,
          exp_points: newExpPoints
        })
        .eq('id', userId);
    }

    // Пометить уведомления как прочитанные
    const ids = notifications.map(n => n.id);
    if (ids.length > 0) {
      await supabase.from('notifications')
        .update({ claimed: true })
        .in('id', ids);
    }

    res.json({
      success: true,
      newCoins: (await supabase.from('users').select('coins').eq('id', userId).single()).data.coins,
      newTickets: (await supabase.from('users').select('tickets').eq('id', userId).single()).data.tickets,
      newExp: (await supabase.from('users').select('experience').eq('id', userId).single()).data.experience
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/claim-refund', authenticate, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.userId;

    const { data: notification, error: notifError } = await supabase
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .eq('user_id', userId)
      .single();
    if (notifError) throw notifError;
    if (notification.type !== 'bet_cancelled') {
      return res.status(400).json({ error: 'Not a refund notification' });
    }

    const refundAmount = notification.data.refundAmount || 0;
    if (refundAmount > 0) {
      await supabase.rpc('increment_coins', { user_id: userId, amount: refundAmount });
    }

    await supabase.from('notifications')
      .update({ claimed: true })
      .eq('id', notificationId);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ЛИДЕРБОРД ----------
app.get('/api/leaderboard/:tournamentId', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.tournamentId);
    const { data, error } = await supabase
      .from('bets')
      .select('user_id, username:users(username), total_damage, created_at')
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .order('total_damage', { ascending: false })
      .limit(100);
    if (error) throw error;

    const leaderboard = data.map((entry, index) => ({
      rank: index + 1,
      userId: entry.user_id,
      username: entry.username,
      totalDamage: entry.total_damage,
      timestamp: entry.created_at
    }));
    res.json(leaderboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СИНХРОНИЗАЦИЯ ОТ ПАРСЕРА ----------
app.post('/api/tournaments/sync', async (req, res) => {
  try {
    const { tournament, fighters } = req.body;
    // tournament: { name, league, date }
    // fighters: массив объектов Fighter со всеми полями

    // 1. Найти или создать турнир
    let { data: dbTournament, error: findError } = await supabase
      .from('tournaments')
      .select('*')
      .eq('name', tournament.name)
      .single();
    if (findError && findError.code !== 'PGRST116') throw findError;

    if (!dbTournament) {
      const { data: newT, error: insertError } = await supabase
        .from('tournaments')
        .insert([{ ...tournament, status: 'upcoming' }])
        .select()
        .single();
      if (insertError) throw insertError;
      dbTournament = newT;
    }

    // 2. Определить, завершён ли турнир (все бойцы имеют W/L)
    const allHaveResult = fighters.every(f => f['W/L'] && ['win','lose','draw'].includes(f['W/L'].toLowerCase()));
    if (allHaveResult) {
      await supabase.from('tournaments')
        .update({ status: 'completed' })
        .eq('id', dbTournament.id);
    }

    // 3. Обновить/вставить бойцов
    for (const f of fighters) {
      await supabase.from('fighters').upsert({
        tournament_id: dbTournament.id,
        fighter_name: f.Fighter,
        weight_class: f['Weight class'],
        fight_id: f.Fight_ID,
        wl: f['W/L']?.toLowerCase() || null,
        total_damage: f['Total Damage'],
        method: f.Method,
        round: f.Round,
        time: f.Time,
        str: f.Str,
        td: f.Td,
        sub: f.Sub
      }, { onConflict: 'tournament_id, fighter_name' });
    }

    // 4. Если турнир завершён, обработать ставки
    if (allHaveResult) {
      const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('tournament_id', dbTournament.id)
        .eq('cancelled', false);

      for (const bet of bets) {
        const selections = bet.selections;
        let winners = 0;
        let totalDamage = 0;
        const updatedSelections = [];

        for (const sel of selections) {
          const fighterData = fighters.find(f => f.Fighter === sel.fighter.Fighter);
          if (fighterData) {
            // Обогащаем данными о результате
            const enriched = {
              ...sel,
              fighter: {
                ...sel.fighter,
                'W/L': fighterData['W/L']?.toLowerCase(),
                'Total Damage': fighterData['Total Damage'],
                Method: fighterData.Method,
                Round: fighterData.Round,
                Time: fighterData.Time,
                Str: fighterData.Str,
                Td: fighterData.Td,
                Sub: fighterData.Sub
              }
            };
            updatedSelections.push(enriched);
            totalDamage += fighterData['Total Damage'];
            if (fighterData['W/L']?.toLowerCase() === 'win') winners++;
          } else {
            // Боец не найден – ставка аннулируется (будет обработано ниже)
          }
        }

        if (updatedSelections.length === 5) {
          const coins = winners * Math.floor(bet.bet_amount * 2 / 5);
          const exp = winners * 5;
          const tickets = winners;

          // Сохранить уведомление
          await supabase.from('notifications').insert({
            user_id: bet.user_id,
            type: 'tournament_reward',
            tournament_name: dbTournament.name,
            data: {
              coins,
              tickets,
              experience: exp,
              winners: updatedSelections.filter(s => s.fighter['W/L'] === 'win'),
              allSelections: updatedSelections
            }
          });

          // Обновить ставку
          await supabase.from('bets')
            .update({
              total_damage: totalDamage,
              reward_coins: coins,
              reward_exp: exp,
              selections: updatedSelections
            })
            .eq('id', bet.id);
        } else {
          // Если не все бойцы найдены, помечаем ставку как отменённую и создаём уведомление на возврат
          await supabase.from('bets')
            .update({ cancelled: true })
            .eq('id', bet.id);
          await supabase.from('notifications').insert({
            user_id: bet.user_id,
            type: 'bet_cancelled',
            tournament_name: dbTournament.name,
            data: {
              refundAmount: bet.bet_amount,
              cancelledFighters: selections.filter(s => !fighters.find(f => f.Fighter === s.fighter.Fighter)).map(s => ({
                originalFighter: s.fighter.Fighter,
                weightClass: s.weightClass
              }))
            }
          });
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PVP ----------
app.post('/api/pvp/start', authenticate, async (req, res) => {
  try {
    const { tournamentId, betAmount } = req.body;
    const userId = req.user.userId;

    // Проверить, что у пользователя есть ставка на этот турнир
    const { data: userBet, error: betError } = await supabase
      .from('bets')
      .select('total_damage, selections')
      .eq('user_id', userId)
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .single();
    if (betError) throw new Error('No valid bet found for this tournament');

    // Проверить баланс
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('coins, tickets')
      .eq('id', userId)
      .single();
    if (userError) throw userError;
    if (user.coins < betAmount || user.tickets < 1) {
      return res.status(400).json({ error: 'Not enough coins or tickets' });
    }

    // Списать валюту
    await supabase.from('users')
      .update({ coins: user.coins - betAmount, tickets: user.tickets - 1 })
      .eq('id', userId);

    // Найти соперника с близким total_damage
    const { data: rivals, error: rivalError } = await supabase
      .from('bets')
      .select('user_id, total_damage, selections')
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .neq('user_id', userId);
    if (rivalError) throw rivalError;
    if (rivals.length === 0) {
      // Вернуть валюту
      await supabase.from('users')
        .update({ coins: user.coins, tickets: user.tickets })
        .eq('id', userId);
      return res.status(400).json({ error: 'No opponents available' });
    }

    // Выбрать соперника с минимальной разницей в total_damage
    const userDamage = userBet.total_damage;
    let bestRival = rivals[0];
    let minDiff = Math.abs(userDamage - bestRival.total_damage);
    for (const r of rivals) {
      const diff = Math.abs(userDamage - r.total_damage);
      if (diff < minDiff) {
        minDiff = diff;
        bestRival = r;
      }
    }

    // Получить профиль соперника
    const { data: rivalProfile } = await supabase
      .from('users')
      .select('username, photo_url')
      .eq('id', bestRival.user_id)
      .single();

    // Симуляция боя (упрощённая логика, можно расширить)
    const userCards = userBet.selections;
    const rivalCards = bestRival.selections;

    // Вычислить суммарный урон для каждой стороны
    const userTotal = userCards.reduce((sum, c) => sum + c.fighter['Total Damage'], 0);
    const rivalTotal = rivalCards.reduce((sum, c) => sum + c.fighter['Total Damage'], 0);

    let result, resultType, winnerId = null;
    if (userTotal > rivalTotal) {
      result = 'win';
      winnerId = userId;
      if (userTotal - rivalTotal >= 100) resultType = 'decision-unanimous';
      else resultType = 'decision-split';
    } else if (rivalTotal > userTotal) {
      result = 'loss';
      winnerId = bestRival.user_id;
      if (rivalTotal - userTotal >= 100) resultType = 'decision-unanimous';
      else resultType = 'decision-split';
    } else {
      result = 'draw';
    }

    // Рассчитать награды
    let coinsReward = 0, expReward = 0;
    if (result === 'win') {
      if (resultType === 'decision-unanimous') {
        coinsReward = Math.ceil(betAmount * 1.5);
        expReward = 7;
      } else {
        coinsReward = Math.ceil(betAmount * 1.2);
        expReward = 5;
      }
    } else if (result === 'loss') {
      expReward = resultType === 'decision-unanimous' ? 2 : 3;
    } else if (result === 'draw') {
      coinsReward = betAmount;
      expReward = 4;
    }

    // Начислить награды победителю (если есть)
    if (winnerId) {
      const { data: winner } = await supabase.from('users').select('coins, experience, level, exp_points').eq('id', winnerId).single();
      let newCoins = winner.coins + coinsReward;
      let newExp = winner.experience + expReward;
      // Расчёт уровня (аналогично claim-all)
      // ...
      await supabase.from('users').update({ coins: newCoins, experience: newExp }).eq('id', winnerId);
    }

    // Записать бой в pvp_battles (таблицу нужно создать)
    await supabase.from('pvp_battles').insert({
      user_id: userId,
      rival_id: bestRival.user_id,
      tournament_id: tournamentId,
      bet_amount: betAmount,
      result: result,
      winner_id: winnerId,
      user_total_damage: userTotal,
      rival_total_damage: rivalTotal
    });

    // Подготовить ответ с данными для анимации
    const battleScript = {
      rounds: 1, // можно позже добавить раунды
      events: [
        { type: 'countdown' },
        { type: 'damage', userDamage: userTotal, rivalDamage: rivalTotal }
      ],
      result: { result, resultType, winnerId }
    };

    res.json({
      success: true,
      battleScript,
      rewards: { coins: coinsReward, experience: expReward },
      rival: {
        username: rivalProfile.username,
        photoUrl: rivalProfile.photo_url,
        selections: rivalCards
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));