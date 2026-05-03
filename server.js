// server.js – ПОЛНЫЙ ФАЙЛ с исправленной формулой PvP урона и начислением опыта
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

const safeNumber = (val) => {
  if (val === null || val === undefined || val === '') return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
};

// Глобальный кэш коэффициентов
let COEFFICIENTS = {};

async function loadCoefficients() {
  try {
    const { data, error } = await supabase
      .from('base_coefficients')
      .select('coef_key, coef_value');
    
    if (error) {
      console.error('❌ Failed to load coefficients:', error);
      return;
    }
    
    COEFFICIENTS = {};
    
    data.forEach(row => {
      COEFFICIENTS[row.coef_key] = parseFloat(row.coef_value);
    });
    
    console.log(`✅ Loaded ${Object.keys(COEFFICIENTS).length} coefficients from DB`);
  } catch (err) {
    console.error('❌ Error loading coefficients:', err);
  }
}

loadCoefficients();
setInterval(loadCoefficients, 5 * 60 * 1000);

app.get('/api/coefficients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('base_coefficients')
      .select('*')
      .order('coef_key');
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function getCoef(key) {
  return COEFFICIENTS[key] !== undefined ? COEFFICIENTS[key] : 0;
}

function getWeightCoefficient(weightClass) {
  if (!weightClass) return 1.0;
  const key = `weight_${weightClass}`;
  return getCoef(key) || 1.0;
}

const LEVEL_THRESHOLDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 0];

function calculateLevel(totalExp) {
  let remainingExp = totalExp;
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length - 1; i++) {
    const expNeeded = LEVEL_THRESHOLDS[i];
    if (remainingExp >= expNeeded) {
      remainingExp -= expNeeded;
      level = i + 2;
    } else break;
  }
  const nextLevelExp = level < 10 ? LEVEL_THRESHOLDS[level - 1] : 0;
  return { level, currentExp: remainingExp, nextLevelExp };
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
          id: userId, username, photo_url: photoUrl, level: 1,
          experience: 0, exp_points: 1, coins: 100, tickets: 0, ton: 0,
          style: null
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
    const { level, currentExp, nextLevelExp } = calculateLevel(existingUser.experience);
    res.json({
      token,
      user: { ...existingUser, level, currentExp, nextLevelExp }
    });
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
    const { level, currentExp, nextLevelExp } = calculateLevel(user.experience);
    res.json({ ...user, level, currentExp, nextLevelExp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СТИЛЬ ПОЛЬЗОВАТЕЛЯ ----------
app.get('/api/user/style', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users').select('style').eq('id', req.user.userId).single();
    if (error) throw error;
    res.json({ style: user.style });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/style', authenticate, async (req, res) => {
  try {
    const { style } = req.body;
    if (!style || (style !== 'striker' && style !== 'grappler')) {
      return res.status(400).json({ error: 'Invalid style' });
    }
    const { data: user, error: userError } = await supabase
      .from('users').select('style').eq('id', req.user.userId).single();
    if (userError) throw userError;
    if (user.style) return res.status(400).json({ error: 'Style already chosen' });
    const { error: updateError } = await supabase
      .from('users').update({ style }).eq('id', req.user.userId);
    if (updateError) throw updateError;
    res.json({ success: true, style });
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
    if (user.coins < betAmount) return res.status(400).json({ error: 'Not enough coins' });

    await supabase.from('users').update({ coins: user.coins - betAmount }).eq('id', userId);

    const totalDamage = selections.reduce((sum, sel) => {
      const dmg = calculateBaseDamage({
        Kd: sel.fighter.Kd || 0, Td: sel.fighter.Td || 0, Sub: sel.fighter.Sub || 0,
        Head: sel.fighter.Head || 0, Body: sel.fighter.Body || 0, Leg: sel.fighter.Leg || 0,
        'W/L': sel.fighter['W/L'] || 'lose', Method: sel.fighter.Method || '',
        weight_class: sel.weightClass
      });
      return sum + dmg;
    }, 0);

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
      .from('bets').select('*').eq('user_id', userId).eq('tournament_id', tournamentId).single();
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
      .from('notifications').select('*').eq('user_id', userId).eq('claimed', false);
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
        .from('users').select('coins, tickets, experience, level, exp_points').eq('id', userId).single();
      if (userError) throw userError;

      const newCoins = user.coins + totalCoins;
      const newTickets = user.tickets + totalTickets;
      const newExp = user.experience + totalExp;

      const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
      let newExpPoints = user.exp_points;
      if (level > user.level) newExpPoints += (level - user.level);

      await supabase.from('users').update({
        coins: newCoins, tickets: newTickets, experience: newExp,
        level: level, exp_points: newExpPoints
      }).eq('id', userId);
    }

    const ids = notifications.map(n => n.id);
    if (ids.length > 0) await supabase.from('notifications').update({ claimed: true }).in('id', ids);

    const { data: updatedUser } = await supabase
      .from('users').select('coins, tickets, experience').eq('id', userId).single();
    const { level, currentExp, nextLevelExp } = calculateLevel(updatedUser.experience);
    res.json({ success: true, newCoins: updatedUser.coins, newTickets: updatedUser.tickets, newExp: updatedUser.experience, level, currentExp, nextLevelExp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/claim', authenticate, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.userId;

    const { data: notification, error: notifError } = await supabase
      .from('notifications').select('*').eq('id', notificationId).eq('user_id', userId).eq('claimed', false).single();
    if (notifError) throw notifError;
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    if (notification.type !== 'tournament_reward') return res.status(400).json({ error: 'Not a reward notification' });

    const { coins, tickets, experience } = notification.data;
    const { data: user, error: userError } = await supabase
      .from('users').select('coins, tickets, experience, level, exp_points').eq('id', userId).single();
    if (userError) throw userError;

    const newCoins = user.coins + (coins || 0);
    const newTickets = user.tickets + (tickets || 0);
    const newExp = user.experience + (experience || 0);

    const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
    let newExpPoints = user.exp_points;
    if (level > user.level) newExpPoints += (level - user.level);

    await supabase.from('users').update({
      coins: newCoins, tickets: newTickets, experience: newExp,
      level: level, exp_points: newExpPoints
    }).eq('id', userId);

    await supabase.from('notifications').update({ claimed: true }).eq('id', notificationId);

    res.json({ success: true, newCoins, newTickets, newExp, level, currentExp, nextLevelExp, expPoints: newExpPoints });
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
      .from('notifications').select('*').eq('id', notificationId).eq('user_id', userId).single();
    if (notifError) throw notifError;
    if (notification.type !== 'bet_cancelled') return res.status(400).json({ error: 'Not a refund notification' });

    const refundAmount = notification.data.refundAmount || 0;
    if (refundAmount > 0) await supabase.rpc('increment_coins', { user_id: userId, amount: refundAmount });
    await supabase.from('notifications').update({ claimed: true }).eq('id', notificationId);
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
    const { data: bets, error: betsError } = await supabase
      .from('bets').select('user_id, total_damage, created_at')
      .eq('tournament_id', tournamentId).eq('cancelled', false)
      .order('total_damage', { ascending: false }).limit(100);
    if (betsError) throw betsError;

    const userIds = bets.map(b => b.user_id);
    const { data: users } = await supabase.from('users').select('id, username').in('id', userIds);
    const userMap = new Map(users.map(u => [u.id, u.username]));

    const leaderboard = bets.map((bet, index) => ({
      rank: index + 1, userId: bet.user_id,
      username: userMap.get(bet.user_id) || 'Unknown',
      totalDamage: bet.total_damage, timestamp: bet.created_at
    }));
    res.json(leaderboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СИНХРОНИЗАЦИЯ ----------
app.post('/api/tournaments/sync', async (req, res) => {
  try {
    const { tournament, fighters, is_completed } = req.body;
    console.log(`📥 Sync request for "${tournament.name}", fighters: ${fighters?.length || 0}, completed: ${is_completed}`);

    let { data: dbTournament, error: findError } = await supabase
      .from('tournaments').select('*').eq('name', tournament.name).single();
    if (findError && findError.code !== 'PGRST116') throw findError;

    if (!dbTournament) {
      const { data: newT, error: insertError } = await supabase
        .from('tournaments').insert([{ ...tournament, status: is_completed ? 'completed' : 'upcoming' }]).select().single();
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
      const { data: existing } = await supabase
        .from('fighters').select('id').eq('tournament_id', dbTournament.id).eq('fighter_name', f.Fighter).maybeSingle();

      const totalDamage = calculateBaseDamage({
        Kd: f.Kd || 0, Td: f.Td || 0, Sub: f.Sub || 0,
        Head: f.Head || 0, Body: f.Body || 0, Leg: f.Leg || 0,
        'W/L': f['W/L'] || 'lose', Method: f.Method || '',
        weight_class: f['Weight class'] || ''
      });

      const fighterData = {
        tournament_id: dbTournament.id, fighter_name: f.Fighter, weight_class: f['Weight class'],
        fight_id: safeNumber(f.Fight_ID), wl: f['W/L']?.toLowerCase() || null,
        total_damage: totalDamage, method: f.Method || '',
        round: safeNumber(f.Round), time: f.Time || '',
        str: safeNumber(f.Str), td: safeNumber(f.Td), sub: safeNumber(f.Sub),
        head: safeNumber(f.Head), body: safeNumber(f.Body), leg: safeNumber(f.Leg), kd: safeNumber(f.Kd)
      };

      if (existing) {
        const { error } = await supabase.from('fighters').update(fighterData).eq('id', existing.id);
        if (!error) insertedCount++;
      } else {
        const { error } = await supabase.from('fighters').insert([fighterData]);
        if (!error) insertedCount++;
      }
    }
    console.log(`✅ Inserted/updated ${insertedCount} fighters`);

    // Обработка замен бойцов
    console.log('🔍 Checking for fighter replacements...');
    const { data: activeBets, error: betsError } = await supabase
      .from('bets').select('*').eq('tournament_id', dbTournament.id).eq('cancelled', false);

    if (betsError) {
      console.error('Error loading active bets:', betsError);
    } else if (activeBets && activeBets.length > 0) {
      for (const bet of activeBets) {
        if (bet.rewards_created) continue;
        const selections = bet.selections;
        let hasReplacement = false;
        const replacedFighters = [];
        for (const sel of selections) {
          const fighterExists = fighters.find(f => f.Fighter === sel.fighter.Fighter);
          if (!fighterExists) {
            hasReplacement = true;
            replacedFighters.push({ originalFighter: sel.fighter.Fighter, weightClass: sel.weightClass });
          }
        }
        if (hasReplacement) {
          console.log(`  ⚠️ Bet ${bet.id} has ${replacedFighters.length} replaced fighter(s)`);
          await supabase.from('bets').update({ cancelled: true }).eq('id', bet.id);
          await supabase.from('notifications').insert({
            user_id: bet.user_id, type: 'bet_cancelled', tournament_name: dbTournament.name,
            data: { refundAmount: bet.bet_amount, cancelledFighters: replacedFighters, message: 'Fighter(s) have been replaced. Please make a new bet.' }
          });
          console.log(`  ✅ Bet ${bet.id} cancelled, refund: ${bet.bet_amount} coins`);
        }
      }
    }

    if (is_completed) {
      console.log('🏁 Tournament completed, processing bets...');
      const { data: completedBets } = await supabase
        .from('bets').select('*').eq('tournament_id', dbTournament.id).eq('cancelled', false);

      for (const bet of completedBets) {
        if (bet.rewards_created) continue;
        const selections = bet.selections;
        let winners = 0, totalDamage = 0;
        const updatedSelections = [];
        for (const sel of selections) {
          const fighterData = fighters.find(f => f.Fighter === sel.fighter.Fighter);
          if (fighterData) {
            const newTotalDamage = calculateBaseDamage({
              Kd: fighterData.Kd || 0, Td: fighterData.Td || 0, Sub: fighterData.Sub || 0,
              Head: fighterData.Head || 0, Body: fighterData.Body || 0, Leg: fighterData.Leg || 0,
              'W/L': fighterData['W/L'] || 'lose', Method: fighterData.Method || '',
              weight_class: fighterData['Weight class'] || ''
            });
            updatedSelections.push({ ...sel, fighter: { ...sel.fighter, 'W/L': fighterData['W/L']?.toLowerCase(), 'Total Damage': newTotalDamage, Method: fighterData.Method, Round: fighterData.Round, Time: fighterData.Time, Str: fighterData.Str, Td: fighterData.Td, Sub: fighterData.Sub } });
            totalDamage += newTotalDamage;
            if (fighterData['W/L']?.toLowerCase() === 'win') winners++;
          }
        }
        if (updatedSelections.length === 5) {
          const coins = winners * Math.floor(bet.bet_amount * 2 / 5);
          const exp = winners * 5;
          const tickets = winners;
          await supabase.from('notifications').insert({
            user_id: bet.user_id, type: 'tournament_reward', tournament_name: dbTournament.name,
            data: { coins, tickets, experience: exp, winners: updatedSelections.filter(s => s.fighter['W/L'] === 'win'), allSelections: updatedSelections }
          });
          await supabase.from('bets').update({ total_damage: totalDamage, reward_coins: coins, reward_exp: exp, selections: updatedSelections, rewards_created: true }).eq('id', bet.id);
        } else {
          await supabase.from('bets').update({ cancelled: true }).eq('id', bet.id);
          await supabase.from('notifications').insert({
            user_id: bet.user_id, type: 'bet_cancelled', tournament_name: dbTournament.name,
            data: { refundAmount: bet.bet_amount, cancelledFighters: selections.filter(s => !fighters.find(f => f.Fighter === s.fighter.Fighter)).map(s => ({ originalFighter: s.fighter.Fighter, weightClass: s.weightClass })) }
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

// Пересчёт урона по имени турнира
app.post('/api/tournaments/recalculate', async (req, res) => {
  try {
    const { tournament_name } = req.body;
    if (!tournament_name) return res.status(400).json({ error: 'tournament_name is required' });

    console.log(`🔄 Recalculate requested for: "${tournament_name}"`);
    const { data: tournament, error: findError } = await supabase
      .from('tournaments').select('id').eq('name', tournament_name).single();
    if (findError || !tournament) return res.status(404).json({ error: 'Tournament not found' });

    const tournamentId = tournament.id;
    const { data: fighters, error: fightersError } = await supabase
      .from('fighters').select('*').eq('tournament_id', tournamentId);
    if (fightersError) throw fightersError;

    let updatedCount = 0;
    for (const fighter of fighters) {
      const newTotalDamage = calculateBaseDamage({
        Kd: fighter.kd, Td: fighter.td, Sub: fighter.sub,
        Head: fighter.head, Body: fighter.body, Leg: fighter.leg,
        'W/L': fighter.wl || 'lose', Method: fighter.method || '',
        weight_class: fighter.weight_class || ''
      });
      const { error: updateError } = await supabase
        .from('fighters').update({ total_damage: newTotalDamage }).eq('id', fighter.id);
      if (!updateError) updatedCount++;
    }
    console.log(`✅ Recalculated ${updatedCount}/${fighters.length} fighters`);

    const { data: bets } = await supabase
      .from('bets').select('id, selections').eq('tournament_id', tournamentId).eq('cancelled', false);
    for (const bet of bets) {
      const selections = bet.selections;
      let newTotalDamage = 0;
      const updatedSelections = [];
      for (const sel of selections) {
        const fighterData = fighters.find(f => f.fighter_name === sel.fighter.Fighter);
        if (fighterData) {
          const newFighterDamage = fighterData.total_damage;
          newTotalDamage += newFighterDamage;
          updatedSelections.push({ ...sel, fighter: { ...sel.fighter, 'Total Damage': newFighterDamage } });
        }
      }
      if (updatedSelections.length === 5) {
        await supabase.from('bets').update({ total_damage: newTotalDamage, selections: updatedSelections }).eq('id', bet.id);
      }
    }

    res.json({ success: true, updated: updatedCount, tournamentId });
  } catch (err) {
    console.error('❌ Recalculate error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tournaments/:id/recalculate', async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id);
    if (isNaN(tournamentId)) return res.status(400).json({ error: 'Invalid tournament id' });

    const { data: fighters, error: fightersError } = await supabase
      .from('fighters').select('*').eq('tournament_id', tournamentId);
    if (fightersError) throw fightersError;

    let updatedCount = 0;
    for (const fighter of fighters) {
      const newTotalDamage = calculateBaseDamage({
        Kd: fighter.kd, Td: fighter.td, Sub: fighter.sub,
        Head: fighter.head, Body: fighter.body, Leg: fighter.leg,
        'W/L': fighter.wl || 'lose', Method: fighter.method || '',
        weight_class: fighter.weight_class || ''
      });
      const { error: updateError } = await supabase
        .from('fighters').update({ total_damage: newTotalDamage }).eq('id', fighter.id);
      if (!updateError) updatedCount++;
    }
    console.log(`✅ Recalculated ${updatedCount}/${fighters.length} fighters`);

    const { data: bets } = await supabase
      .from('bets').select('id, selections').eq('tournament_id', tournamentId).eq('cancelled', false);
    for (const bet of bets) {
      const selections = bet.selections;
      let newTotalDamage = 0;
      const updatedSelections = [];
      for (const sel of selections) {
        const fighterData = fighters.find(f => f.fighter_name === sel.fighter.Fighter);
        if (fighterData) {
          const newFighterDamage = fighterData.total_damage;
          newTotalDamage += newFighterDamage;
          updatedSelections.push({ ...sel, fighter: { ...sel.fighter, 'Total Damage': newFighterDamage } });
        }
      }
      if (updatedSelections.length === 5) {
        await supabase.from('bets').update({ total_damage: newTotalDamage, selections: updatedSelections }).eq('id', bet.id);
      }
    }

    res.json({ success: true, updated: updatedCount });
  } catch (err) {
    console.error('❌ Recalculate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ФУНКЦИИ ----------
function getFighterStyle(str, td, sub) {
  const tdSubSum = td + sub;
  if (tdSubSum >= 2 && str < 50) return 'grappler';
  if (str >= 50 && tdSubSum < 2) return 'striker';
  if (str >= 50 && tdSubSum >= 2) return 'universal';
  return 'simple';
}

function calculateBaseDamage(fighterData, customHeadCoef = null, customBodyCoef = null, customLegCoef = null) {
  const kd = safeNumber(fighterData.Kd || fighterData.kd);
  const td = safeNumber(fighterData.Td || fighterData.td);
  const sub = safeNumber(fighterData.Sub || fighterData.sub);
  const head = safeNumber(fighterData.Head || fighterData.head);
  const body = safeNumber(fighterData.Body || fighterData.body);
  const leg = safeNumber(fighterData.Leg || fighterData.leg);
  const wl = (fighterData['W/L'] || fighterData.wl || 'lose').toLowerCase();
  const method = (fighterData.Method || fighterData.method || '').toUpperCase();
  const weightClass = fighterData.weight_class || fighterData['Weight class'] || '';
  
  if (head === 0 && body === 0 && leg === 0 && kd === 0 && td === 0 && sub === 0) {
    return safeNumber(fighterData['Total Damage'] || fighterData.total_damage);
  }
  
  const KD_COEF = getCoef('KD_COEF') || 25.0;
  const TD_COEF = getCoef('TD_COEF') || 10.0;
  const SUB_COEF = getCoef('SUB_COEF') || 15.0;
  const HEAD_COEF = getCoef('HEAD_COEF') || 1.0;
  const BODY_COEF = getCoef('BODY_COEF') || 0.9;
  const LEG_COEF = getCoef('LEG_COEF') || 0.8;
  const WIN_COEF = getCoef('WIN_COEF') || 1.0;
  const LOSE_COEF = getCoef('LOSE_COEF') || 0.7;
  const DRAW_COEF = getCoef('DRAW_COEF') || 0.9;
  const KD_BONUS_WIN = getCoef('KD_BONUS_WIN') || 40.0;
  const SUB_BONUS_WIN = getCoef('SUB_BONUS_WIN') || 35.0;
  
  let kdBonus = 0, subBonus = 0;
  if (wl === 'win') {
    if (method.includes('KO') || method.includes('TKO')) kdBonus = KD_BONUS_WIN;
    else if (method.includes('SUB')) subBonus = SUB_BONUS_WIN;
  }
  
  let wkCoef = LOSE_COEF;
  if (wl === 'win') wkCoef = WIN_COEF;
  else if (wl === 'draw') wkCoef = DRAW_COEF;
  
  const headCoef = customHeadCoef !== null ? customHeadCoef : HEAD_COEF;
  const bodyCoef = customBodyCoef !== null ? customBodyCoef : BODY_COEF;
  const legCoef = customLegCoef !== null ? customLegCoef : LEG_COEF;
  const weightCoef = getWeightCoefficient(weightClass);
  
  const total = (kd * KD_COEF + kdBonus + td * TD_COEF + sub * SUB_COEF + subBonus + head * headCoef + body * bodyCoef + leg * legCoef) * wkCoef * weightCoef;
  return Math.round(total);
}

// НОВАЯ ФУНКЦИЯ applyPassiveAbilities
function applyPassiveAbilities(cards, userAbilities, fightersData) {
  if (!userAbilities || userAbilities.length === 0) {
    return { cards, healthBonus: 0 };
  }
  
  const skillBonuses = {
    HEAD_COEF: 0,
    STYLE_STRIKER: 0,
    STYLE_GRAPPLER: 0,
    healthBonus: 0
  };
  
  userAbilities.forEach(ability => {
    if (ability.type === 'passive' && ability.level_data) {
      const data = ability.level_data;
      if (data.striker_damage_bonus) skillBonuses.STYLE_STRIKER += data.striker_damage_bonus;
      if (data.grappler_damage_bonus) skillBonuses.STYLE_GRAPPLER += data.grappler_damage_bonus;
      if (data.head_damage_bonus) skillBonuses.HEAD_COEF += data.head_damage_bonus;
      if (data.health_bonus) skillBonuses.healthBonus += data.health_bonus;
    }
  });
  
  const modifiedCards = cards.map(selection => {
    const fighter = { ...selection.fighter };
    const str = safeNumber(fighter.Str);
    const td = safeNumber(fighter.Td);
    const sub = safeNumber(fighter.Sub);
    const fighterStyle = getFighterStyle(str, td, sub);
    
    const fullFighterData = fightersData?.find(f => f.fighter_name === fighter.Fighter) || fighter;
    
    if (!fullFighterData || (safeNumber(fullFighterData.Head || fullFighterData.head) === 0 && 
        safeNumber(fullFighterData.Body || fullFighterData.body) === 0 && 
        safeNumber(fullFighterData.Leg || fullFighterData.leg) === 0)) {
      return selection;
    }
    
    const kd = safeNumber(fullFighterData.Kd || fullFighterData.kd);
    const fighterTd = safeNumber(fullFighterData.Td || fullFighterData.td);
    const fighterSub = safeNumber(fullFighterData.Sub || fullFighterData.sub);
    const head = safeNumber(fullFighterData.Head || fullFighterData.head);
    const body = safeNumber(fullFighterData.Body || fullFighterData.body);
    const leg = safeNumber(fullFighterData.Leg || fullFighterData.leg);
    const wl = (fullFighterData['W/L'] || fullFighterData.wl || 'lose').toLowerCase();
    const method = (fullFighterData.Method || fullFighterData.method || '').toUpperCase();
    const weightClass = fullFighterData.weight_class || fullFighterData['Weight class'] || '';
    
    // PvP HEAD_COEF
    const baseHeadCoef = getCoef('HEAD_COEF') || 1.0;
    const PvPHeadCoef = baseHeadCoef * (1 + skillBonuses.HEAD_COEF / 100);
    
    // Бонусы за завершение
    const baseKDBonus = getCoef('KD_BONUS_WIN') || 40.0;
    const baseSUBBonus = getCoef('SUB_BONUS_WIN') || 35.0;
    let PvPKdBonus = 0, PvPSubBonus = 0;
    if (wl === 'win') {
      if (method.includes('KO') || method.includes('TKO')) PvPKdBonus = baseKDBonus;
      else if (method.includes('SUB')) PvPSubBonus = baseSUBBonus;
    }
    
    // Коэффициент результата
    const baseWinCoef = getCoef('WIN_COEF') || 1.0;
    const baseLoseCoef = getCoef('LOSE_COEF') || 0.7;
    const baseDrawCoef = getCoef('DRAW_COEF') || 0.9;
    let PvPWkCoef = baseLoseCoef;
    if (wl === 'win') PvPWkCoef = baseWinCoef;
    else if (wl === 'draw') PvPWkCoef = baseDrawCoef;
    
    // Весовой коэффициент
    const PvPWeightCoef = getWeightCoefficient(weightClass);
    
    // Стилевой коэффициент
    let PvPStyleCoef = 1.0;
    if (fighterStyle === 'striker') {
      PvPStyleCoef = 1 + skillBonuses.STYLE_STRIKER / 100;
    } else if (fighterStyle === 'grappler') {
      PvPStyleCoef = 1 + skillBonuses.STYLE_GRAPPLER / 100;
    } else if (fighterStyle === 'universal') {
      PvPStyleCoef = 1 + (skillBonuses.STYLE_STRIKER + skillBonuses.STYLE_GRAPPLER) / 100;
    }
    
    const PvPTotal = Math.round((
      kd * (getCoef('KD_COEF') || 25.0) + PvPKdBonus +
      fighterTd * (getCoef('TD_COEF') || 10.0) +
      fighterSub * (getCoef('SUB_COEF') || 15.0) + PvPSubBonus +
      head * PvPHeadCoef +
      body * (getCoef('BODY_COEF') || 0.9) +
      leg * (getCoef('LEG_COEF') || 0.8)
    ) * PvPWkCoef * PvPWeightCoef * PvPStyleCoef);
    
    return {
      ...selection,
      fighter: {
        ...fighter,
        'Total Damage': PvPTotal,
        'Head': head,
        'Body': body,
        'Leg': leg
      }
    };
  });
  
  return { cards: modifiedCards, healthBonus: skillBonuses.healthBonus };
}

function calculateBattleScript(userCards, rivalCards, allTournamentWeightClasses, userHealthBonus = 0, rivalHealthBonus = 0) {
  const events = [];
  const baseHealth = 1000;
  let currentUserHealth = baseHealth + Math.round(baseHealth * (userHealthBonus / 100));
  let currentRivalHealth = baseHealth + Math.round(baseHealth * (rivalHealthBonus / 100));
  
  console.log(`❤️ User health: ${currentUserHealth} (base: ${baseHealth}, bonus: ${userHealthBonus}%)`);
  console.log(`❤️ Rival health: ${currentRivalHealth} (base: ${baseHealth}, bonus: ${rivalHealthBonus}%)`);
  
  let currentUserCards = [], currentRivalCards = [];
  let availableClasses = [...allTournamentWeightClasses], usedClasses = [];

  events.push({ type: 'countdown' });

  for (let round = 1; round <= 5; round++) {
    events.push({ type: 'round-start', round });
    if (availableClasses.length === 0) break;

    const randomIndex = Math.floor(Math.random() * availableClasses.length);
    const selectedClass = availableClasses[randomIndex];
    usedClasses.push(selectedClass);
    availableClasses = availableClasses.filter((_, i) => i !== randomIndex);

    const newUserFighters = userCards.filter(sel => sel.weightClass === selectedClass && !currentUserCards.some(c => c.fighter.Fighter === sel.fighter.Fighter));
    const newRivalFighters = rivalCards.filter(sel => sel.weightClass === selectedClass && !currentRivalCards.some(c => c.fighter.Fighter === sel.fighter.Fighter));

    const userSlots = 5 - currentUserCards.length;
    const userCardsToAdd = newUserFighters.slice(0, userSlots);
    const rivalSlots = 5 - currentRivalCards.length;
    const rivalCardsToAdd = newRivalFighters.slice(0, rivalSlots);

    if (userCardsToAdd.length > 0) currentUserCards = [...currentUserCards, ...userCardsToAdd];
    if (rivalCardsToAdd.length > 0) currentRivalCards = [...currentRivalCards, ...rivalCardsToAdd];

    events.push({
      type: 'card-appear', round, weightClass: selectedClass,
      userActiveCards: currentUserCards.map(c => ({ ...c, fighter: { ...c.fighter } })),
      rivalActiveCards: currentRivalCards.map(c => ({ ...c, fighter: { ...c.fighter } }))
    });

    const userTotalDamage = currentUserCards.reduce((sum, card) => sum + Math.round(card.fighter['Total Damage']), 0);
    const rivalTotalDamage = currentRivalCards.reduce((sum, card) => sum + Math.round(card.fighter['Total Damage']), 0);

    currentRivalHealth = Math.max(0, currentRivalHealth - userTotalDamage);
    currentUserHealth = Math.max(0, currentUserHealth - rivalTotalDamage);

    events.push({ type: 'damage', round, userDamage: userTotalDamage, rivalDamage: rivalTotalDamage, userHealthAfter: currentUserHealth, rivalHealthAfter: currentRivalHealth });

    if (currentRivalHealth <= 0 && currentUserHealth > 0) {
      events.push({ type: 'battle-end', result: { isOpen: true, result: 'win', resultType: 'ko' } });
      return { events, winningRound: round };
    }
    if (currentUserHealth <= 0 && currentRivalHealth > 0) {
      events.push({ type: 'battle-end', result: { isOpen: true, result: 'loss', resultType: 'ko' } });
      return { events, winningRound: round };
    }
    if (currentUserHealth <= 0 && currentRivalHealth <= 0) {
      events.push({ type: 'battle-end', result: { isOpen: true, result: 'draw' } });
      return { events, winningRound: round };
    }
    if (round < 5) events.push({ type: 'round-end', round });
  }

  const healthDiff = Math.abs(currentUserHealth - currentRivalHealth);
  let result;
  if (currentUserHealth > currentRivalHealth) result = { isOpen: true, result: 'win', resultType: healthDiff >= 100 ? 'decision-unanimous' : 'decision-split' };
  else if (currentRivalHealth > currentUserHealth) result = { isOpen: true, result: 'loss', resultType: healthDiff >= 100 ? 'decision-unanimous' : 'decision-split' };
  else result = { isOpen: true, result: 'draw' };
  events.push({ type: 'battle-end', result });
  return { events, winningRound: 5 };
}

// ---------- PVP ----------
app.post('/api/pvp/start', authenticate, async (req, res) => {
  try {
    const { tournamentId, betAmount } = req.body;
    const userId = req.user.userId;

    console.log(`🎮 PvP start: userId=${userId}, tournamentId=${tournamentId}, betAmount=${betAmount}`);

    const { data: userBet, error: betError } = await supabase
      .from('bets').select('total_damage, selections')
      .eq('user_id', userId).eq('tournament_id', tournamentId).eq('cancelled', false).single();
    if (betError) return res.status(400).json({ error: 'No valid bet found for this tournament' });

    const { data: user, error: userError } = await supabase
      .from('users').select('coins, tickets').eq('id', userId).single();
    if (userError) throw userError;
    if (user.coins < betAmount || user.tickets < 1) return res.status(400).json({ error: 'Not enough coins or tickets' });

    await supabase.from('users').update({ coins: user.coins - betAmount, tickets: user.tickets - 1 }).eq('id', userId);

    const { data: userAbilitiesData } = await supabase
      .from('user_abilities').select(`ability_id, current_level, abilities!inner (id, name, style, type, max_level)`)
      .eq('user_id', userId).gt('current_level', 0);
    
    let userAbilities = [];
    if (userAbilitiesData && userAbilitiesData.length > 0) {
      const abilityIds = userAbilitiesData.map(ua => ua.ability_id);
      const { data: levels } = await supabase.from('ability_levels').select('*').in('ability_id', abilityIds);
      userAbilities = userAbilitiesData.map(ua => ({
        ...ua.abilities, current_level: ua.current_level,
        level_data: levels?.find(l => l.ability_id === ua.ability_id && l.level === ua.current_level) || null
      }));
    }

    const { data: tournamentFighters } = await supabase
      .from('fighters').select('weight_class').eq('tournament_id', tournamentId);
    const allWeightClasses = [...new Set(tournamentFighters.map(f => f.weight_class))];

    const { data: rivals } = await supabase
      .from('bets').select('user_id, total_damage, selections')
      .eq('tournament_id', tournamentId).eq('cancelled', false).neq('user_id', userId);

    if (!rivals || rivals.length === 0) {
      await supabase.from('users').update({ coins: user.coins, tickets: user.tickets }).eq('id', userId);
      return res.status(400).json({ error: 'No opponents available' });
    }

    const userDamage = userBet.total_damage;
    let bestRival = rivals[0];
    let minDiff = Math.abs(userDamage - bestRival.total_damage);
    for (const r of rivals) {
      const diff = Math.abs(userDamage - r.total_damage);
      if (diff < minDiff) { minDiff = diff; bestRival = r; }
    }

    const { data: rivalProfile } = await supabase
      .from('users').select('username, photo_url').eq('id', bestRival.user_id).single();

    const { data: rivalAbilitiesData } = await supabase
      .from('user_abilities').select(`ability_id, current_level, abilities!inner (id, name, style, type, max_level)`)
      .eq('user_id', bestRival.user_id).gt('current_level', 0);
    
    let rivalAbilities = [];
    if (rivalAbilitiesData && rivalAbilitiesData.length > 0) {
      const abilityIds = rivalAbilitiesData.map(ua => ua.ability_id);
      const { data: levels } = await supabase.from('ability_levels').select('*').in('ability_id', abilityIds);
      rivalAbilities = rivalAbilitiesData.map(ua => ({
        ...ua.abilities, current_level: ua.current_level,
        level_data: levels?.find(l => l.ability_id === ua.ability_id && l.level === ua.current_level) || null
      }));
    }

    const userCards = userBet.selections;
    const rivalCards = bestRival.selections;
    
    const allFighterNames = [...userCards.map(c => c.fighter.Fighter), ...rivalCards.map(c => c.fighter.Fighter)];
    const { data: fightersData } = await supabase
      .from('fighters').select('*').in('fighter_name', allFighterNames).eq('tournament_id', tournamentId);
    
    const { cards: enhancedUserCards, healthBonus: userHealthBonus } = applyPassiveAbilities(userCards, userAbilities, fightersData);
    const { cards: enhancedRivalCards, healthBonus: rivalHealthBonus } = applyPassiveAbilities(rivalCards, rivalAbilities, fightersData);

    console.log(`💪 User health bonus: +${userHealthBonus}%`);
    console.log(`💪 Rival health bonus: +${rivalHealthBonus}%`);

    const { events: battleEvents, winningRound } = calculateBattleScript(enhancedUserCards, enhancedRivalCards, allWeightClasses, userHealthBonus, rivalHealthBonus);

    const lastEvent = battleEvents[battleEvents.length - 1];
    const { result, resultType } = lastEvent.result;

    let baseCoeff = 0;
    if (result === 'win') {
      if (resultType === 'ko') baseCoeff = 2.0;
      else if (resultType === 'decision-unanimous') baseCoeff = 1.5;
      else if (resultType === 'decision-split') baseCoeff = 1.2;
    } else if (result === 'draw') baseCoeff = 1.0;

    let winCoefficient = baseCoeff;
    if (result === 'win' && resultType === 'ko' && winningRound < 5) winCoefficient = baseCoeff + (5 - winningRound) * 0.1;

    console.log(`🏆 Result: ${result} ${resultType || ''}, round: ${winningRound}, coeff: ${winCoefficient}`);

    let coinsReward = 0, expReward = 0;
    if (result === 'win') {
      coinsReward = Math.ceil(betAmount * winCoefficient);
      expReward = resultType === 'ko' ? 10 : (resultType === 'decision-unanimous' ? 7 : 5);
    } else if (result === 'loss') {
      expReward = resultType === 'ko' ? 1 : (resultType === 'decision-unanimous' ? 2 : 3);
    } else if (result === 'draw') {
      coinsReward = betAmount;
      expReward = 4;
    }

    // Начисляем опыт ВСЕГДА (пользователю)
    const { data: currentUserData } = await supabase
      .from('users').select('experience, level, exp_points').eq('id', userId).single();
    const newUserExp = currentUserData.experience + expReward;
    const { level: userLevel, currentExp: userCurrentExp, nextLevelExp: userNextLevelExp } = calculateLevel(newUserExp);
    let newUserExpPoints = currentUserData.exp_points;
    if (userLevel > currentUserData.level) newUserExpPoints += (userLevel - currentUserData.level);
    
    await supabase.from('users')
      .update({ experience: newUserExp, level: userLevel, exp_points: newUserExpPoints })
      .eq('id', userId);

    // Обновляем победителя (монеты + опыт)
    const winnerId = result === 'win' ? userId : (result === 'loss' ? bestRival.user_id : null);
    let updatedWinner = null;
    if (winnerId) {
      const { data: winner } = await supabase
        .from('users').select('coins, experience, level, exp_points').eq('id', winnerId).single();
      const newExp = winner.experience + expReward;
      const newCoins = winner.coins + coinsReward;
      const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
      let newExpPoints = winner.exp_points;
      if (level > winner.level) newExpPoints += (level - winner.level);
      
      await supabase.from('users')
        .update({ coins: newCoins, experience: newExp, level: level, exp_points: newExpPoints })
        .eq('id', winnerId);
      
      updatedWinner = { userId: winnerId, coins: newCoins, totalExp: newExp, level, currentExp, nextLevelExp, expPoints: newExpPoints };
    }

    await supabase.from('pvp_battles').insert({
      user_id: userId, rival_id: bestRival.user_id, tournament_id: tournamentId,
      bet_amount: betAmount, result: result, winner_id: winnerId,
      user_total_damage: enhancedUserCards.reduce((s, c) => s + c.fighter['Total Damage'], 0),
      rival_total_damage: enhancedRivalCards.reduce((s, c) => s + c.fighter['Total Damage'], 0)
    });

    const { data: updatedUser } = await supabase.from('users').select('coins, tickets').eq('id', userId).single();

    res.json({
      success: true,
      battleScript: { events: battleEvents },
      rewards: { coins: coinsReward, experience: expReward },
      rival: { username: rivalProfile?.username || 'Opponent', photoUrl: rivalProfile?.photo_url, selections: rivalCards },
      healthBonuses: { user: userHealthBonus, rival: rivalHealthBonus },
      updatedBalance: { coins: updatedUser.coins, tickets: updatedUser.tickets },
      updatedWinner: updatedWinner
    });
  } catch (err) {
    console.error('❌ PvP error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СПОСОБНОСТИ ----------
app.get('/api/abilities/:style', authenticate, async (req, res) => {
  try {
    const { style } = req.params;
    const userId = req.user.userId;
    if (!['striker', 'grappler'].includes(style)) return res.status(400).json({ error: 'Invalid style' });
    
    const { data: abilities } = await supabase.from('abilities').select('*').eq('style', style).order('row_position').order('col_position');
    const abilityIds = abilities.map(a => a.id);
    const { data: levels } = await supabase.from('ability_levels').select('*').in('ability_id', abilityIds).order('level');
    
    const levelsByAbility = levels.reduce((acc, level) => {
      if (!acc[level.ability_id]) acc[level.ability_id] = [];
      acc[level.ability_id].push(level);
      return acc;
    }, {});
    
    const abilitiesWithLevels = abilities.map(ability => ({ ...ability, levels: levelsByAbility[ability.id] || [] }));
    const { data: userAbilities } = await supabase.from('user_abilities').select('ability_id, current_level').eq('user_id', userId);
    
    res.json({ abilities: abilitiesWithLevels, userAbilities: userAbilities || [] });
  } catch (err) {
    console.error('Error loading abilities:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/abilities/learn', authenticate, async (req, res) => {
  try {
    const { ability_id, level } = req.body;
    const userId = req.user.userId;
    
    const { data: ability } = await supabase.from('abilities').select('*').eq('id', ability_id).single();
    if (!ability) return res.status(404).json({ error: 'Ability not found' });
    
    const { data: levelData } = await supabase.from('ability_levels').select('*').eq('ability_id', ability_id).eq('level', level).single();
    if (!levelData) return res.status(404).json({ error: 'Level not found' });
    
    const { data: user } = await supabase.from('users').select('level, exp_points').eq('id', userId).single();
    if (user.level < ability.min_level) return res.status(400).json({ error: 'Player level too low' });
    
    if (ability.parent_ability_id) {
      const { data: parent } = await supabase.from('user_abilities').select('current_level').eq('user_id', userId).eq('ability_id', ability.parent_ability_id).single();
      if (!parent || parent.current_level === 0) return res.status(400).json({ error: 'Parent ability not learned' });
    }
    
    if (user.exp_points < levelData.cost) return res.status(400).json({ error: 'Not enough EXP points' });
    
    await supabase.from('users').update({ exp_points: user.exp_points - levelData.cost }).eq('id', userId);
    
    const { data: existing } = await supabase.from('user_abilities').select('id').eq('user_id', userId).eq('ability_id', ability_id).single();
    if (existing) {
      await supabase.from('user_abilities').update({ current_level: level, updated_at: new Date() }).eq('id', existing.id);
    } else {
      await supabase.from('user_abilities').insert([{ user_id: userId, ability_id: ability_id, current_level: level }]);
    }
    
    res.json({ success: true, new_exp_points: user.exp_points - levelData.cost });
  } catch (err) {
    console.error('Error learning ability:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));