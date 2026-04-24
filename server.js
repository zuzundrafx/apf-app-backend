// server.js – ПОЛНЫЙ ФАЙЛ с пересчётом урона и бонусами (на основе вашей версии)
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

// Коэффициенты урона (как в парсере)
const KD_COEF = 25.0;
const TD_COEF = 10.0;
const SUB_COEF = 15.0;
const HEAD_COEF = 1.0;
const BODY_COEF = 0.9;
const LEG_COEF = 0.8;
const WIN_COEF = 1.0;
const LOSE_COEF = 0.7;
const DRAW_COEF = 0.9;

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
      user: {
        ...existingUser,
        level,
        currentExp,
        nextLevelExp
      }
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
    res.json({
      ...user,
      level,
      currentExp,
      nextLevelExp
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СТИЛЬ ПОЛЬЗОВАТЕЛЯ ----------
app.get('/api/user/style', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('style')
      .eq('id', req.user.userId)
      .single();
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
      .from('users')
      .select('style')
      .eq('id', req.user.userId)
      .single();
    if (userError) throw userError;
    
    if (user.style) {
      return res.status(400).json({ error: 'Style already chosen' });
    }
    
    const { error: updateError } = await supabase
      .from('users')
      .update({ style })
      .eq('id', req.user.userId);
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

      const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
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
    const { level, currentExp, nextLevelExp } = calculateLevel(updatedUser.experience);
    res.json({
      success: true,
      newCoins: updatedUser.coins,
      newTickets: updatedUser.tickets,
      newExp: updatedUser.experience,
      level,
      currentExp,
      nextLevelExp
    });
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
      .from('notifications')
      .select('*')
      .eq('id', notificationId)
      .eq('user_id', userId)
      .eq('claimed', false)
      .single();
    
    if (notifError) throw notifError;
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    if (notification.type !== 'tournament_reward') {
      return res.status(400).json({ error: 'Not a reward notification' });
    }

    const { coins, tickets, experience } = notification.data;
    
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('coins, tickets, experience, level, exp_points')
      .eq('id', userId)
      .single();
    if (userError) throw userError;

    const newCoins = user.coins + (coins || 0);
    const newTickets = user.tickets + (tickets || 0);
    const newExp = user.experience + (experience || 0);

    const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
    let newExpPoints = user.exp_points;
    if (level > user.level) newExpPoints += (level - user.level);

    await supabase.from('users').update({
      coins: newCoins,
      tickets: newTickets,
      experience: newExp,
      level: level,
      exp_points: newExpPoints
    }).eq('id', userId);

    await supabase.from('notifications').update({ claimed: true }).eq('id', notificationId);

    res.json({
      success: true,
      newCoins,
      newTickets,
      newExp,
      level,
      currentExp,
      nextLevelExp,
      expPoints: newExpPoints
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

// ---------- ЛИДЕРБОРД ----------
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

    if (fighters && fighters.length > 0) {
  console.log('📋 Sample fighter data from parser:');
  const sample = fighters[0];
  console.log(`  Fighter: ${sample.Fighter}`);
  console.log(`  Head: ${sample.Head}, Body: ${sample.Body}, Leg: ${sample.Leg}, Kd: ${sample.Kd}`);
  console.log(`  Total Damage: ${sample['Total Damage']}`);
  console.log('  Full keys:', Object.keys(sample).join(', '));
}

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
      const { data: existing } = await supabase
        .from('fighters')
        .select('id')
        .eq('tournament_id', dbTournament.id)
        .eq('fighter_name', f.Fighter)
        .maybeSingle();

      const fighterData = {
        tournament_id: dbTournament.id,
        fighter_name: f.Fighter,
        weight_class: f['Weight class'],
        fight_id: safeNumber(f.Fight_ID),
        wl: f['W/L']?.toLowerCase() || null,
        total_damage: Math.round(safeNumber(f['Total Damage'])),
        method: f.Method || '',
        round: safeNumber(f.Round),
        time: f.Time || '',
        str: safeNumber(f.Str),
        td: safeNumber(f.Td),
        sub: safeNumber(f.Sub),
        head: safeNumber(f.Head),
        body: safeNumber(f.Body),
        leg: safeNumber(f.Leg),
        kd: safeNumber(f.Kd)
      };

      if (existing) {
        const { error } = await supabase
          .from('fighters')
          .update(fighterData)
          .eq('id', existing.id);
        if (!error) insertedCount++;
      } else {
        const { error } = await supabase
          .from('fighters')
          .insert([fighterData]);
        if (!error) insertedCount++;
      }
    }
    console.log(`✅ Inserted/updated ${insertedCount} fighters`);

    if (is_completed) {
      console.log('🏁 Tournament completed, processing bets...');
      const { data: bets } = await supabase
        .from('bets').select('*')
        .eq('tournament_id', dbTournament.id)
        .eq('cancelled', false);

      for (const bet of bets) {
        if (bet.rewards_created) continue;

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
                'Total Damage': Math.round(safeNumber(fighterData['Total Damage'])),
                Method: fighterData.Method,
                Round: fighterData.Round,
                Time: fighterData.Time,
                Str: fighterData.Str,
                Td: fighterData.Td,
                Sub: fighterData.Sub
              }
            };
            updatedSelections.push(enriched);
            totalDamage += Math.round(safeNumber(fighterData['Total Damage']));
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
            selections: updatedSelections,
            rewards_created: true
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

// ---------- ФУНКЦИЯ ОПРЕДЕЛЕНИЯ СТИЛЯ БОЙЦА ----------
function getFighterStyle(str, td, sub) {
  const tdSubSum = td + sub;
  if (tdSubSum >= 2 && str < 50) return 'grappler';
  if (str >= 50 && tdSubSum < 2) return 'striker';
  if (str >= 50 && tdSubSum >= 2) return 'universal';
  return 'simple';
}

// ---------- ФУНКЦИЯ РАСЧЁТА БАЗОВОГО УРОНА ----------
function calculateBaseDamage(fighterData, customHeadCoef = null, customBodyCoef = null, customLegCoef = null) {
  const kd = safeNumber(fighterData.Kd);
  const td = safeNumber(fighterData.Td);
  const sub = safeNumber(fighterData.Sub);
  const head = safeNumber(fighterData.Head);
  const body = safeNumber(fighterData.Body);
  const leg = safeNumber(fighterData.Leg);
  const wl = fighterData['W/L'] || 'lose';
  const method = (fighterData.Method || '').toUpperCase();
  
  // Бонусы за способ завершения
  let kdBonus = 0;
  let subBonus = 0;
  
  if (wl === 'win') {
    if (method.includes('KO') || method.includes('TKO')) {
      kdBonus = 65 - KD_COEF;
    } else if (method.includes('SUB')) {
      subBonus = 50 - SUB_COEF;
    }
  }
  
  // Коэффициент результата
  let wkCoef = LOSE_COEF;
  if (wl === 'win') wkCoef = WIN_COEF;
  else if (wl === 'draw') wkCoef = DRAW_COEF;
  
  const headCoef = customHeadCoef !== null ? customHeadCoef : HEAD_COEF;
  const bodyCoef = customBodyCoef !== null ? customBodyCoef : BODY_COEF;
  const legCoef = customLegCoef !== null ? customLegCoef : LEG_COEF;
  
  const total = (
    kd * KD_COEF + kdBonus +
    td * TD_COEF +
    sub * SUB_COEF + subBonus +
    head * headCoef +
    body * bodyCoef +
    leg * legCoef
  ) * wkCoef * (safeNumber(fighterData['Weight Coefficient']) || 1.0);
  
  return Math.round(total);
}

// ---------- ФУНКЦИЯ ПРИМЕНЕНИЯ PASSIVE СПОСОБНОСТЕЙ ----------
function applyPassiveAbilities(cards, userAbilities, fightersData) {
  if (!userAbilities || userAbilities.length === 0) {
    console.log('⚠️ No abilities to apply');
    return { cards, healthBonus: 0 };
  }
  
  let healthBonus = 0;
  
  // Собираем бонусы от всех PASSIVE способностей
  const bonuses = {
    strikerDamageBonus: 0,
    headDamageBonus: 0,
    grapplerDamageBonus: 0,
    healthBonus: 0
  };
  
  console.log('🔧 Collecting bonuses from abilities:');
  userAbilities.forEach(ability => {
    if (ability.type === 'passive' && ability.level_data) {
      const data = ability.level_data;
      console.log(`  📋 ${ability.name} (level ${ability.current_level}):`, {
        striker_damage_bonus: data.striker_damage_bonus,
        head_damage_bonus: data.head_damage_bonus,
        grappler_damage_bonus: data.grappler_damage_bonus,
        health_bonus: data.health_bonus
      });
      
      if (data.striker_damage_bonus) {
        bonuses.strikerDamageBonus += data.striker_damage_bonus;
        console.log(`    ✅ strikerDamageBonus +${data.striker_damage_bonus}% = ${bonuses.strikerDamageBonus}%`);
      }
      if (data.head_damage_bonus) {
        bonuses.headDamageBonus += data.head_damage_bonus;
        console.log(`    ✅ headDamageBonus +${data.head_damage_bonus}% = ${bonuses.headDamageBonus}%`);
      }
      if (data.grappler_damage_bonus) {
        bonuses.grapplerDamageBonus += data.grappler_damage_bonus;
        console.log(`    ✅ grapplerDamageBonus +${data.grappler_damage_bonus}% = ${bonuses.grapplerDamageBonus}%`);
      }
      if (data.health_bonus) {
        bonuses.healthBonus += data.health_bonus;
        console.log(`    ✅ healthBonus +${data.health_bonus}% = ${bonuses.healthBonus}%`);
      }
    }
  });
  
  console.log('📦 Total bonuses collected:', bonuses);
  
  // Применяем бонусы к кардам
  const modifiedCards = cards.map(selection => {
    const fighter = { ...selection.fighter };
    
    // Определяем стиль бойца
    const str = safeNumber(fighter.Str);
    const td = safeNumber(fighter.Td);
    const sub = safeNumber(fighter.Sub);
    const fighterStyle = getFighterStyle(str, td, sub);
    
    // Находим полные данные бойца из БД
    const fullFighterData = fightersData?.find(f => f.fighter_name === fighter.Fighter) || fighter;
    
    // Рассчитываем базовый урон
    const baseTotalDamage = calculateBaseDamage(fullFighterData);
    
    // Модифицируем коэффициенты с учётом бонусов
    let customHeadCoef = null;
    
    if (bonuses.headDamageBonus > 0) {
      customHeadCoef = HEAD_COEF * (1 + bonuses.headDamageBonus / 100);
      console.log(`  ✅ Head coefficient: ${HEAD_COEF} -> ${customHeadCoef.toFixed(2)} (+${bonuses.headDamageBonus}%)`);
    }
    
    // Пересчитываем урон с модифицированными коэффициентами
    let totalDamage = calculateBaseDamage(fullFighterData, customHeadCoef);
    
    console.log(`🔎 Fighter ${fighter.Fighter}: Str=${str}, Td=${td}, Sub=${sub}, style=${fighterStyle}, baseDamage=${baseTotalDamage}, afterCoef=${totalDamage}`);
    
    // Применяем стилевые бонусы к ИТОГОВОМУ урону
    if (fighterStyle === 'striker' && bonuses.strikerDamageBonus > 0) {
      const oldDamage = totalDamage;
      totalDamage = Math.round(totalDamage * (1 + bonuses.strikerDamageBonus / 100));
      console.log(`  ✅ Striker bonus: ${oldDamage} -> ${totalDamage} (+${bonuses.strikerDamageBonus}%)`);
    } else if (fighterStyle === 'grappler' && bonuses.grapplerDamageBonus > 0) {
      const oldDamage = totalDamage;
      totalDamage = Math.round(totalDamage * (1 + bonuses.grapplerDamageBonus / 100));
      console.log(`  ✅ Grappler bonus: ${oldDamage} -> ${totalDamage} (+${bonuses.grapplerDamageBonus}%)`);
    } else if (fighterStyle === 'universal' && (bonuses.strikerDamageBonus > 0 || bonuses.grapplerDamageBonus > 0)) {
      const halfStriker = (bonuses.strikerDamageBonus || 0) / 2;
      const halfGrappler = (bonuses.grapplerDamageBonus || 0) / 2;
      const totalBonus = halfStriker + halfGrappler;
      const oldDamage = totalDamage;
      totalDamage = Math.round(totalDamage * (1 + totalBonus / 100));
      console.log(`  ✅ Universal bonus: ${oldDamage} -> ${totalDamage} (+${totalBonus}%)`);
    } else {
      console.log(`  ℹ️ Style: ${fighterStyle} — no style-specific damage bonus`);
    }
    
    const headDamage = safeNumber(fullFighterData.Head);
    const bodyDamage = safeNumber(fullFighterData.Body);
    const legDamage = safeNumber(fullFighterData.Leg);
    
    return {
      ...selection,
      fighter: {
        ...fighter,
        'Total Damage': totalDamage,
        'Head': headDamage,
        'Body': bodyDamage,
        'Leg': legDamage
      }
    };
  });
  
  healthBonus = bonuses.healthBonus;
  
  return { cards: modifiedCards, healthBonus };
}

// ---------- ФУНКЦИЯ ГЕНЕРАЦИИ СЦЕНАРИЯ БОЯ ----------
function calculateBattleScript(userCards, rivalCards, allTournamentWeightClasses, userHealthBonus = 0, rivalHealthBonus = 0) {
  const events = [];
  
  // Базовое здоровье с бонусами
  const baseHealth = 1000;
  let currentUserHealth = baseHealth + Math.round(baseHealth * (userHealthBonus / 100));
  let currentRivalHealth = baseHealth + Math.round(baseHealth * (rivalHealthBonus / 100));
  
  console.log(`❤️ User health: ${currentUserHealth} (base: ${baseHealth}, bonus: ${userHealthBonus}%)`);
  console.log(`❤️ Rival health: ${currentRivalHealth} (base: ${baseHealth}, bonus: ${rivalHealthBonus}%)`);
  
  let currentUserCards = [];
  let currentRivalCards = [];
  let availableClasses = [...allTournamentWeightClasses];
  let usedClasses = [];

  events.push({ type: 'countdown' });

  for (let round = 1; round <= 5; round++) {
    events.push({ type: 'round-start', round });

    if (availableClasses.length === 0) break;

    const randomIndex = Math.floor(Math.random() * availableClasses.length);
    const selectedClass = availableClasses[randomIndex];
    usedClasses.push(selectedClass);
    availableClasses = availableClasses.filter((_, i) => i !== randomIndex);

    const newUserFighters = userCards.filter(
      sel => sel.weightClass === selectedClass && !currentUserCards.some(c => c.fighter.Fighter === sel.fighter.Fighter)
    );
    const newRivalFighters = rivalCards.filter(
      sel => sel.weightClass === selectedClass && !currentRivalCards.some(c => c.fighter.Fighter === sel.fighter.Fighter)
    );

    const userSlots = 5 - currentUserCards.length;
    const userCardsToAdd = newUserFighters.slice(0, userSlots);
    const rivalSlots = 5 - currentRivalCards.length;
    const rivalCardsToAdd = newRivalFighters.slice(0, rivalSlots);

    if (userCardsToAdd.length > 0) currentUserCards = [...currentUserCards, ...userCardsToAdd];
    if (rivalCardsToAdd.length > 0) currentRivalCards = [...currentRivalCards, ...rivalCardsToAdd];

    events.push({
      type: 'card-appear',
      round,
      weightClass: selectedClass,
      userActiveCards: currentUserCards.map(c => ({ ...c, fighter: { ...c.fighter } })),
      rivalActiveCards: currentRivalCards.map(c => ({ ...c, fighter: { ...c.fighter } }))
    });

    const userTotalDamage = currentUserCards.reduce((sum, card) => sum + Math.round(card.fighter['Total Damage']), 0);
    const rivalTotalDamage = currentRivalCards.reduce((sum, card) => sum + Math.round(card.fighter['Total Damage']), 0);

    currentRivalHealth = Math.max(0, currentRivalHealth - userTotalDamage);
    currentUserHealth = Math.max(0, currentUserHealth - rivalTotalDamage);

    events.push({
      type: 'damage',
      round,
      userDamage: userTotalDamage,
      rivalDamage: rivalTotalDamage,
      userHealthAfter: currentUserHealth,
      rivalHealthAfter: currentRivalHealth
    });

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
  if (currentUserHealth > currentRivalHealth) {
    result = { isOpen: true, result: 'win', resultType: healthDiff >= 100 ? 'decision-unanimous' : 'decision-split' };
  } else if (currentRivalHealth > currentUserHealth) {
    result = { isOpen: true, result: 'loss', resultType: healthDiff >= 100 ? 'decision-unanimous' : 'decision-split' };
  } else {
    result = { isOpen: true, result: 'draw' };
  }
  events.push({ type: 'battle-end', result });
  return { events, winningRound: 5 };
}

// ---------- PVP ----------
app.post('/api/pvp/start', authenticate, async (req, res) => {
  try {
    const { tournamentId, betAmount } = req.body;
    const userId = req.user.userId;

    console.log(`🎮 PvP start: userId=${userId}, tournamentId=${tournamentId}, betAmount=${betAmount}`);

    // 1. Получаем ставку пользователя
    const { data: userBet, error: betError } = await supabase
      .from('bets')
      .select('total_damage, selections')
      .eq('user_id', userId)
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .single();
    if (betError) {
      console.error('❌ User bet error:', betError);
      return res.status(400).json({ error: 'No valid bet found for this tournament' });
    }

    // 2. Проверяем баланс
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('coins, tickets')
      .eq('id', userId)
      .single();
    if (userError) throw userError;
    if (user.coins < betAmount || user.tickets < 1) {
      return res.status(400).json({ error: 'Not enough coins or tickets' });
    }

    // 3. Списываем валюту
    await supabase.from('users')
      .update({ coins: user.coins - betAmount, tickets: user.tickets - 1 })
      .eq('id', userId);

    // 4. Получаем способности пользователя
    const { data: userAbilitiesData, error: userAbilitiesError } = await supabase
      .from('user_abilities')
      .select(`
        ability_id,
        current_level,
        abilities!inner (
          id,
          name,
          style,
          type,
          max_level
        )
      `)
      .eq('user_id', userId)
      .gt('current_level', 0);
      
    if (userAbilitiesError) {
      console.error('Error loading user abilities:', userAbilitiesError);
    }
    
    // Получаем уровни способностей
    let userAbilities = [];
    if (userAbilitiesData && userAbilitiesData.length > 0) {
      const abilityIds = userAbilitiesData.map(ua => ua.ability_id);
      const { data: levels } = await supabase
        .from('ability_levels')
        .select('*')
        .in('ability_id', abilityIds);
      
      userAbilities = userAbilitiesData.map(ua => ({
        ...ua.abilities,
        current_level: ua.current_level,
        level_data: levels?.find(l => l.ability_id === ua.ability_id && l.level === ua.current_level) || null
      }));
    }
    
    console.log(`🎯 User abilities: ${userAbilities.length}`);
    console.log('🔍 USER ABILITIES DETAIL:');
    userAbilities.forEach(ua => {
      console.log(`  - ${ua.name} (${ua.type}) level ${ua.current_level}/${ua.max_level}:`, ua.level_data);
    });

    // 5. Получаем весовые категории турнира
    const { data: tournamentFighters, error: fightersError } = await supabase
      .from('fighters')
      .select('weight_class')
      .eq('tournament_id', tournamentId);
    if (fightersError) throw fightersError;
    
    const allWeightClasses = [...new Set(tournamentFighters.map(f => f.weight_class))];
    console.log(`📊 Weight classes:`, allWeightClasses);

    // 6. Ищем соперника
    const { data: rivals, error: rivalError } = await supabase
      .from('bets')
      .select('user_id, total_damage, selections')
      .eq('tournament_id', tournamentId)
      .eq('cancelled', false)
      .neq('user_id', userId);

    if (rivalError) throw rivalError;
    if (!rivals || rivals.length === 0) {
      await supabase.from('users')
        .update({ coins: user.coins, tickets: user.tickets })
        .eq('id', userId);
      return res.status(400).json({ error: 'No opponents available' });
    }

    // Выбираем ближайшего по урону соперника
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

    // 7. Получаем профиль и способности соперника
    const { data: rivalProfile } = await supabase
      .from('users')
      .select('username, photo_url')
      .eq('id', bestRival.user_id)
      .single();

    // Получаем способности соперника
    const { data: rivalAbilitiesData } = await supabase
      .from('user_abilities')
      .select(`
        ability_id,
        current_level,
        abilities!inner (
          id,
          name,
          style,
          type,
          max_level
        )
      `)
      .eq('user_id', bestRival.user_id)
      .gt('current_level', 0);
    
    let rivalAbilities = [];
    if (rivalAbilitiesData && rivalAbilitiesData.length > 0) {
      const abilityIds = rivalAbilitiesData.map(ua => ua.ability_id);
      const { data: levels } = await supabase
        .from('ability_levels')
        .select('*')
        .in('ability_id', abilityIds);
      
      rivalAbilities = rivalAbilitiesData.map(ua => ({
        ...ua.abilities,
        current_level: ua.current_level,
        level_data: levels?.find(l => l.ability_id === ua.ability_id && l.level === ua.current_level) || null
      }));
    }
    
    console.log(`🎯 Rival abilities: ${rivalAbilities.length}`);
    console.log('🔍 RIVAL ABILITIES DETAIL:');
    rivalAbilities.forEach(ua => {
      console.log(`  - ${ua.name} (${ua.type}) level ${ua.current_level}/${ua.max_level}:`, ua.level_data);
    });

    // 8. Загружаем полные данные бойцов из БД
    const userCards = userBet.selections;
    const rivalCards = bestRival.selections;
    
    const allFighterNames = [...userCards.map(c => c.fighter.Fighter), ...rivalCards.map(c => c.fighter.Fighter)];
    const { data: fightersData } = await supabase
      .from('fighters')
      .select('*')
      .in('fighter_name', allFighterNames)
      .eq('tournament_id', tournamentId);

    console.log(`📊 Loaded ${fightersData?.length || 0} fighters data for damage calculation`);
    
    console.log('📊 USER CARDS BEFORE BONUSES:');
    userCards.forEach(c => console.log(`  ${c.fighter.Fighter}: damage=${c.fighter['Total Damage']}, Str=${c.fighter.Str}, Td=${c.fighter.Td}, Sub=${c.fighter.Sub}`));
    
    console.log('📊 RIVAL CARDS BEFORE BONUSES:');
    rivalCards.forEach(c => console.log(`  ${c.fighter.Fighter}: damage=${c.fighter['Total Damage']}, Str=${c.fighter.Str}, Td=${c.fighter.Td}, Sub=${c.fighter.Sub}`));
    
    const { cards: enhancedUserCards, healthBonus: userHealthBonus } = 
      applyPassiveAbilities(userCards, userAbilities, fightersData);
    const { cards: enhancedRivalCards, healthBonus: rivalHealthBonus } = 
      applyPassiveAbilities(rivalCards, rivalAbilities, fightersData);

    console.log(`💪 User health bonus: +${userHealthBonus}%`);
    console.log(`💪 Rival health bonus: +${rivalHealthBonus}%`);
    
    console.log('📊 USER CARDS AFTER BONUSES:');
    enhancedUserCards.forEach(c => console.log(`  ${c.fighter.Fighter}: damage=${c.fighter['Total Damage']}`));
    
    console.log('📊 RIVAL CARDS AFTER BONUSES:');
    enhancedRivalCards.forEach(c => console.log(`  ${c.fighter.Fighter}: damage=${c.fighter['Total Damage']}`));

    // 9. Генерируем сценарий боя с учётом бонусов
    const { events: battleEvents, winningRound } = calculateBattleScript(
      enhancedUserCards, 
      enhancedRivalCards, 
      allWeightClasses,
      userHealthBonus,
      rivalHealthBonus
    );

    // 10. Рассчитываем результаты
    const lastEvent = battleEvents[battleEvents.length - 1];
    const { result, resultType } = lastEvent.result;

    let baseCoeff = 0;
    if (result === 'win') {
      if (resultType === 'ko') baseCoeff = 2.0;
      else if (resultType === 'decision-unanimous') baseCoeff = 1.5;
      else if (resultType === 'decision-split') baseCoeff = 1.2;
    } else if (result === 'draw') {
      baseCoeff = 1.0;
    }

    let winCoefficient = baseCoeff;
    if (result === 'win' && resultType === 'ko' && winningRound < 5) {
      const roundsNotFought = 5 - winningRound;
      winCoefficient = baseCoeff + roundsNotFought * 0.1;
    }

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

    // 11. Обновляем победителя
    const winnerId = result === 'win' ? userId : (result === 'loss' ? bestRival.user_id : null);
    let updatedWinner = null;
    if (winnerId) {
      const { data: winner } = await supabase
        .from('users')
        .select('coins, experience, level, exp_points')
        .eq('id', winnerId)
        .single();
      
      const newExp = winner.experience + expReward;
      const newCoins = winner.coins + coinsReward;
      
      const { level, currentExp, nextLevelExp } = calculateLevel(newExp);
      let newExpPoints = winner.exp_points;
      if (level > winner.level) {
        newExpPoints += (level - winner.level);
      }
      
      await supabase.from('users')
        .update({
          coins: newCoins,
          experience: newExp,
          level: level,
          exp_points: newExpPoints
        })
        .eq('id', winnerId);
      
      updatedWinner = {
        userId: winnerId,
        coins: newCoins,
        totalExp: newExp,
        level,
        currentExp,
        nextLevelExp,
        expPoints: newExpPoints
      };
    }

    // 12. Сохраняем историю боя
    await supabase.from('pvp_battles').insert({
      user_id: userId,
      rival_id: bestRival.user_id,
      tournament_id: tournamentId,
      bet_amount: betAmount,
      result: result,
      winner_id: winnerId,
      user_total_damage: enhancedUserCards.reduce((s, c) => s + c.fighter['Total Damage'], 0),
      rival_total_damage: enhancedRivalCards.reduce((s, c) => s + c.fighter['Total Damage'], 0)
    });

    const { data: updatedUser } = await supabase
      .from('users')
      .select('coins, tickets')
      .eq('id', userId)
      .single();

    res.json({
      success: true,
      battleScript: { events: battleEvents },
      rewards: { coins: coinsReward, experience: expReward },
      rival: {
        username: rivalProfile?.username || 'Opponent',
        photoUrl: rivalProfile?.photo_url,
        selections: rivalCards
      },
      healthBonuses: {
        user: userHealthBonus,
        rival: rivalHealthBonus
      },
      updatedBalance: {
        coins: updatedUser.coins,
        tickets: updatedUser.tickets
      },
      updatedWinner: updatedWinner
    });
  } catch (err) {
    console.error('❌ PvP error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- СПОСОБНОСТИ ----------

// Получение способностей для стиля
app.get('/api/abilities/:style', authenticate, async (req, res) => {
  try {
    const { style } = req.params;
    const userId = req.user.userId;
    
    if (!['striker', 'grappler'].includes(style)) {
      return res.status(400).json({ error: 'Invalid style' });
    }
    
    // Получаем способности
    const { data: abilities, error: abilitiesError } = await supabase
      .from('abilities')
      .select('*')
      .eq('style', style)
      .order('row_position', { ascending: true })
      .order('col_position', { ascending: true });
      
    if (abilitiesError) throw abilitiesError;
    
    // Получаем уровни для каждой способности
    const abilityIds = abilities.map(a => a.id);
    const { data: levels, error: levelsError } = await supabase
      .from('ability_levels')
      .select('*')
      .in('ability_id', abilityIds)
      .order('level', { ascending: true });
      
    if (levelsError) throw levelsError;
    
    // Группируем уровни по ability_id
    const levelsByAbility = levels.reduce((acc, level) => {
      if (!acc[level.ability_id]) acc[level.ability_id] = [];
      acc[level.ability_id].push(level);
      return acc;
    }, {});
    
    // Добавляем уровни к способностям
    const abilitiesWithLevels = abilities.map(ability => ({
      ...ability,
      levels: levelsByAbility[ability.id] || []
    }));
    
    // Получаем изученные способности пользователя
    const { data: userAbilities, error: userError } = await supabase
      .from('user_abilities')
      .select('ability_id, current_level')
      .eq('user_id', userId);
      
    if (userError) throw userError;
    
    res.json({
      abilities: abilitiesWithLevels,
      userAbilities: userAbilities || []
    });
  } catch (err) {
    console.error('Error loading abilities:', err);
    res.status(500).json({ error: err.message });
  }
});

// Изучение/улучшение способности
app.post('/api/abilities/learn', authenticate, async (req, res) => {
  try {
    const { ability_id, level } = req.body;
    const userId = req.user.userId;
    
    // Получаем информацию о способности
    const { data: ability, error: abilityError } = await supabase
      .from('abilities')
      .select('*')
      .eq('id', ability_id)
      .single();
      
    if (abilityError) throw abilityError;
    
    // Получаем данные уровня
    const { data: levelData, error: levelError } = await supabase
      .from('ability_levels')
      .select('*')
      .eq('ability_id', ability_id)
      .eq('level', level)
      .single();
      
    if (levelError) throw levelError;
    
    // Проверяем уровень игрока
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('level, exp_points')
      .eq('id', userId)
      .single();
      
    if (userError) throw userError;
    
    if (user.level < ability.min_level) {
      return res.status(400).json({ error: 'Player level too low' });
    }
    
    // Проверяем родительскую способность
    if (ability.parent_ability_id) {
      const { data: parentAbility, error: parentError } = await supabase
        .from('user_abilities')
        .select('current_level')
        .eq('user_id', userId)
        .eq('ability_id', ability.parent_ability_id)
        .single();
        
      if (parentError || !parentAbility || parentAbility.current_level === 0) {
        return res.status(400).json({ error: 'Parent ability not learned' });
      }
    }
    
    // Проверяем EXP points
    if (user.exp_points < levelData.cost) {
      return res.status(400).json({ error: 'Not enough EXP points' });
    }
    
    // Обновляем EXP points
    const { error: updateError } = await supabase
      .from('users')
      .update({ exp_points: user.exp_points - levelData.cost })
      .eq('id', userId);
      
    if (updateError) throw updateError;
    
    // Сохраняем/обновляем способность пользователя
    const { data: existing, error: existingError } = await supabase
      .from('user_abilities')
      .select('id')
      .eq('user_id', userId)
      .eq('ability_id', ability_id)
      .single();
      
    if (existingError && existingError.code !== 'PGRST116') throw existingError;
    
    if (existing) {
      const { error: updateAbilityError } = await supabase
        .from('user_abilities')
        .update({ current_level: level, updated_at: new Date() })
        .eq('id', existing.id);
        
      if (updateAbilityError) throw updateAbilityError;
    } else {
      const { error: insertError } = await supabase
        .from('user_abilities')
        .insert([{
          user_id: userId,
          ability_id: ability_id,
          current_level: level
        }]);
        
      if (insertError) throw insertError;
    }
    
    res.json({ 
      success: true, 
      new_exp_points: user.exp_points - levelData.cost 
    });
  } catch (err) {
    console.error('Error learning ability:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));