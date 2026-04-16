// server.js – ПОЛНЫЙ ФАЙЛ с расширенным логированием PvP
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3001;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const JWT_SECRET = process.env.JWT_SECRET || 'your_secret_key';

app.use(cors({
  origin: ['https://apf-app.vercel.app', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json());

// Middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Вспомогательная функция
const safeNumber = (val) => {
  if (val === null || val === undefined || val === '') return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
};

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
          id: userId, username, photo_url: photoUrl, level: 1,
          experience: 0, exp_points: 1, coins: 100, tickets: 0, ton: 0
        }])
        .select().single();
      if (insertError) throw insertError;
      existingUser = newUser;
    } else {
      await supabase.from('users')
        .update({ username, photo_url: photoUrl, updated_at: new Date() })
        .eq('id', userId);
    }

    const token = jwt.sign(
      { userId: existingUser.id, username: existingUser.username },
      JWT_SECRET, { expiresIn: '7d' }
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
      .from('users').select('*').eq('id', req.user.userId).single();
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
      .from('tournaments').select('*').order('date', { ascending: false });
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
    if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament id' });
    const { data, error } = await supabase
      .from('fighters').select('*').eq('tournament_id', tournamentId);
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

    if (!tournamentId || !betAmount || !selections || selections.length !== 5) {
      return res.status(400).json({ error: 'Invalid data: need 5 selections' });
    }
    const weightClasses = selections.map(s => s.weightClass);
    if (new Set(weightClasses).size !== 5) {
      return res.status(400).json({ error: 'All weight classes must be different' });
    }

    const { data: tournament, error: tournError } = await supabase
      .from('tournaments').select('status').eq('id', tournamentId).single();
    if (tournError) throw tournError;
    if (tournament.status !== 'upcoming') {
      return res.status(400).json({ error: 'Tournament is not open for betting' });
    }

    const { data: user, error: userError } = await supabase
      .from('users').select('coins').eq('id', userId).single();
    if (userError) throw userError;
    if (user.coins < betAmount) {
      return res.status(400).json({ error: 'Not enough coins' });
    }

    await supabase.from('users')
      .update({ coins: user.coins - betAmount }).eq('id', userId);

    const totalDamage = selections.reduce((sum, sel) => sum + (sel.fighter.TotalDamage || 0), 0);

    const { data: bet, error: betError } = await supabase
      .from('bets').insert([{
        user_id: userId, tournament_id: tournamentId, bet_amount: betAmount,
        total_damage: totalDamage, selections: selections, cancelled: false, reward_accepted: false
      }]).select();

    if (betError) throw betError;
    res.json({ success: true, bet: bet[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bets/user/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bets').select('*').eq('user_id', req.params.userId);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bets/user/:userId/tournament/:tournamentId', async (req, res) => {
  try {
    const { userId, tournamentId } = req.params;
    const { data, error } = await supabase
      .from('bets').select('*')
      .eq('user_id', userId).eq('tournament_id', tournamentId).single();
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
      .from('notifications').select('*')
      .eq('user_id', req.user.userId).eq('claimed', false)
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
    const { data: notifications, error: notifError } = await supabase
      .from('notifications').select('*')
      .eq('user_id', userId).eq('claimed', false);
    if (notifError) throw notifError;

    let totalCoins = 0, totalTickets = 0, totalExp = 0;
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
      const { data: user, error: userError } = await supabase
        .from('users').select('coins, tickets, experience, level, exp_points')
        .eq('id', userId).single();
      if (userError) throw userError;

      const newCoins = user.coins + totalCoins;
      const newTickets = user.tickets + totalTickets;
      const newExp = user.experience + totalExp;

      const LEVEL_THRESHOLDS = [5, 10, 15, 20, 25, 30, 35, 40, 45];
      let level = user.level;
      let remainingExp = newExp;
      for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
        if (remainingExp >= LEVEL_THRESHOLDS[i]) {
          remainingExp -= LEVEL_THRESHOLDS[i];
          level = i + 2;
        } else break;
      }
      let newExpPoints = user.exp_points;
      if (level > user.level) newExpPoints += (level - user.level);

      await supabase.from('users').update({
        coins: newCoins, tickets: newTickets, experience: newExp,
        level: level, exp_points: newExpPoints
      }).eq('id', userId);
    }

    const ids = notifications.map(n => n.id);
    if (ids.length > 0) {
      await supabase.from('notifications').update({ claimed: true }).in('id', ids);
    }

    const { data: updatedUser } = await supabase
      .from('users').select('coins, tickets, experience').eq('id', userId).single();
    res.json({
      success: true,
      newCoins: updatedUser.coins,
      newTickets: updatedUser.tickets,
      newExp: updatedUser.experience
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
      .from('notifications').select('*')
      .eq('id', notificationId).eq('user_id', userId).single();
    if (notifError) throw notifError;
    if (notification.type !== 'bet_cancelled') {
      return res.status(400).json({ error: 'Not a refund notification' });
    }

    const refundAmount = notification.data.refundAmount || 0;
    if (refundAmount > 0) {
      await supabase.rpc('increment_coins', { user_id: userId, amount: refundAmount });
    }
    await supabase.from('notifications').update({ claimed: true }).eq('id', notificationId);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ЛИДЕРБОРД (исправлен) ----------
app.get('/api/leaderboard/:tournamentId', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.tournamentId);
    const { data: bets, error: betsError } = await supabase
      .from('bets')
      .select('user_id, total_damage, created_at')
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .order('total_damage', { ascending: false })
      .limit(100);
    if (betsError) throw betsError;

    const userIds = bets.map(b => b.user_id);
    const { data: users } = await supabase
      .from('users')
      .select('id, username')
      .in('id', userIds);

    const userMap = new Map(users.map(u => [u.id, u.username]));

    const leaderboard = bets.map((bet, index) => ({
      rank: index + 1,
      userId: bet.user_id,
      username: userMap.get(bet.user_id) || 'Unknown',
      totalDamage: bet.total_damage,
      timestamp: bet.created_at
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
    const { tournament, fighters, is_completed } = req.body;
    console.log(`📥 Sync request for "${tournament.name}", fighters: ${fighters?.length || 0}, completed: ${is_completed}`);

    let { data: dbTournament, error: findError } = await supabase
      .from('tournaments').select('*').eq('name', tournament.name).single();
    if (findError && findError.code !== 'PGRST116') throw findError;

    if (!dbTournament) {
      const { data: newT, error: insertError } = await supabase
        .from('tournaments').insert([{ ...tournament, status: is_completed ? 'completed' : 'upcoming' }])
        .select().single();
      if (insertError) throw insertError;
      dbTournament = newT;
      console.log(`🆕 Created tournament id=${dbTournament.id}`);
    } else {
      const newStatus = is_completed ? 'completed' : 'upcoming';
      if (dbTournament.status !== newStatus) {
        await supabase.from('tournaments').update({ status: newStatus }).eq('id', dbTournament.id);
        dbTournament.status = newStatus;
      }
      console.log(`♻️ Existing tournament id=${dbTournament.id}, status=${dbTournament.status}`);
    }

    let insertedCount = 0;
    for (const f of fighters) {
      const fighterData = {
        tournament_id: dbTournament.id,
        fighter_name: f.Fighter,
        weight_class: f['Weight class'],
        fight_id: safeNumber(f.Fight_ID),
        wl: f['W/L']?.toLowerCase() || null,
        total_damage: safeNumber(f['Total Damage']),
        method: f.Method || '',
        round: safeNumber(f.Round),
        time: f.Time || '',
        str: safeNumber(f.Str),
        td: safeNumber(f.Td),
        sub: safeNumber(f.Sub)
      };
      const { error } = await supabase.from('fighters').upsert(fighterData, {
        onConflict: 'tournament_id, fighter_name'
      });
      if (error) {
        console.error(`❌ Fighter insert error for ${f.Fighter}:`, error);
      } else {
        insertedCount++;
      }
    }
    console.log(`✅ Inserted/updated ${insertedCount} fighters`);

    if (is_completed) {
      console.log('🏁 Tournament completed, processing bets...');
      const { data: bets } = await supabase
        .from('bets').select('*')
        .eq('tournament_id', dbTournament.id).eq('cancelled', false);

      for (const bet of bets) {
        const selections = bet.selections;
        let winners = 0;
        let totalDamage = 0;
        const updatedSelections = [];

        for (const sel of selections) {
          const fighterData = fighters.find(f => f.Fighter === sel.fighter.Fighter);
          if (fighterData) {
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
          }
        }

        if (updatedSelections.length === 5) {
          const coins = winners * Math.floor(bet.bet_amount * 2 / 5);
          const exp = winners * 5;
          const tickets = winners;

          await supabase.from('notifications').insert({
            user_id: bet.user_id,
            type: 'tournament_reward',
            tournament_name: dbTournament.name,
            data: { coins, tickets, experience: exp, winners: updatedSelections.filter(s => s.fighter['W/L'] === 'win'), allSelections: updatedSelections }
          });

          await supabase.from('bets').update({
            total_damage: totalDamage,
            reward_coins: coins,
            reward_exp: exp,
            selections: updatedSelections
          }).eq('id', bet.id);
        } else {
          await supabase.from('bets').update({ cancelled: true }).eq('id', bet.id);
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
    console.error('❌ Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- PVP (с подробным логом) ----------
app.post('/api/pvp/start', authenticate, async (req, res) => {
  try {
    const { tournamentId, betAmount } = req.body;
    const userId = req.user.userId;

    console.log('═══════════════════════════════════════');
    console.log(`🎮 PvP start request`);
    console.log(`   userId: ${userId}`);
    console.log(`   tournamentId: ${tournamentId}`);
    console.log(`   betAmount: ${betAmount}`);

    // 1. Ставка пользователя
    const { data: userBet, error: betError } = await supabase
      .from('bets')
      .select('total_damage, selections')
      .eq('user_id', userId)
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .single();

    if (betError) {
      console.error(`❌ User bet not found:`, betError.message);
      return res.status(400).json({ error: 'No valid bet found for this tournament' });
    }
    console.log(`✅ User bet found, total_damage = ${userBet.total_damage}`);

    // 2. Баланс
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('coins, tickets')
      .eq('id', userId)
      .single();
    if (userError) throw userError;
    if (user.coins < betAmount || user.tickets < 1) {
      console.log(`💰 Insufficient funds: coins=${user.coins}, tickets=${user.tickets}`);
      return res.status(400).json({ error: 'Not enough coins or tickets' });
    }

    // Списание
    await supabase.from('users')
      .update({ coins: user.coins - betAmount, tickets: user.tickets - 1 })
      .eq('id', userId);
    console.log(`💰 Spent ${betAmount} coins and 1 ticket`);

    // 3. Поиск соперников
    console.log(`🔍 Querying rivals: tournament_id = ${tournamentId}, exclude user_id = "${userId}"`);
    const { data: rivals, error: rivalError } = await supabase
      .from('bets')
      .select('user_id, total_damage, selections')
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .neq('user_id', userId);

    if (rivalError) {
      console.error(`❌ Rivals query error:`, rivalError);
      throw rivalError;
    }

    console.log(`👥 Rivals found: ${rivals?.length || 0}`);
    if (rivals && rivals.length > 0) {
      rivals.forEach((r, i) => console.log(`   ${i+1}. user_id="${r.user_id}", total_damage=${r.total_damage}`));
    }

    if (!rivals || rivals.length === 0) {
      // Возврат
      await supabase.from('users')
        .update({ coins: user.coins, tickets: user.tickets })
        .eq('id', userId);
      console.log(`↩️ No rivals, refunded coins and ticket`);
      return res.status(400).json({ error: 'No opponents available' });
    }

    // 4. Выбор ближайшего по total_damage
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
    console.log(`🤝 Selected rival: "${bestRival.user_id}" (damage diff = ${minDiff})`);

    // 5. Профиль соперника
    const { data: rivalProfile } = await supabase
      .from('users')
      .select('username, photo_url')
      .eq('id', bestRival.user_id)
      .single();
    console.log(`👤 Rival profile: ${rivalProfile?.username || 'not found'}`);

    // 6. Симуляция
    const userCards = userBet.selections;
    const rivalCards = bestRival.selections;
    const userTotal = userCards.reduce((sum, c) => sum + (c.fighter['Total Damage'] || 0), 0);
    const rivalTotal = rivalCards.reduce((sum, c) => sum + (c.fighter['Total Damage'] || 0), 0);

    let result, resultType, winnerId = null;
    if (userTotal > rivalTotal) {
      result = 'win';
      winnerId = userId;
      resultType = (userTotal - rivalTotal >= 100) ? 'decision-unanimous' : 'decision-split';
    } else if (rivalTotal > userTotal) {
      result = 'loss';
      winnerId = bestRival.user_id;
      resultType = (rivalTotal - userTotal >= 100) ? 'decision-unanimous' : 'decision-split';
    } else {
      result = 'draw';
    }

    // 7. Награды
    let coinsReward = 0, expReward = 0;
    if (result === 'win') {
      coinsReward = resultType === 'decision-unanimous' ? Math.ceil(betAmount * 1.5) : Math.ceil(betAmount * 1.2);
      expReward = resultType === 'decision-unanimous' ? 7 : 5;
    } else if (result === 'loss') {
      expReward = resultType === 'decision-unanimous' ? 2 : 3;
    } else if (result === 'draw') {
      coinsReward = betAmount;
      expReward = 4;
    }

    if (winnerId) {
      const { data: winner } = await supabase.from('users').select('coins, experience').eq('id', winnerId).single();
      await supabase.from('users')
        .update({ coins: winner.coins + coinsReward, experience: winner.experience + expReward })
        .eq('id', winnerId);
      console.log(`🏆 Winner ${winnerId} awarded ${coinsReward} coins, ${expReward} exp`);
    }

    // 8. Запись боя
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

    console.log('✅ PvP battle recorded successfully');
    console.log('═══════════════════════════════════════');

    const battleScript = {
      rounds: 1,
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
        username: rivalProfile?.username || 'Opponent',
        photoUrl: rivalProfile?.photo_url,
        selections: rivalCards
      }
    });
  } catch (err) {
    console.error('❌ PvP fatal error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));