require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const POINTS_PER_HOUR = 5;
const DATA_FILE    = './data/members.json';
const BOARD_FILE   = './data/board.json';

function ensureDir() { if (!fs.existsSync('./data')) fs.mkdirSync('./data'); }
function loadJSON(file) {
  ensureDir();
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

const loadData  = () => loadJSON(DATA_FILE);
const saveData  = (d) => saveJSON(DATA_FILE, d);
const loadBoard = () => loadJSON(BOARD_FILE);
const saveBoard = (d) => saveJSON(BOARD_FILE, d);

function getMember(data, userId) {
  if (!data[userId]) data[userId] = {
    userId, username: '',
    tasks:  {},
    points: { total: 0, weekly: {}, monthly: {} },
    stats:  { totalHours: 0, tasksCompleted: 0 },
  };
  const m = data[userId];
  if (!m.tasks)          m.tasks          = {};
  if (!m.points)         m.points         = { total: 0, weekly: {}, monthly: {} };
  if (!m.points.weekly)  m.points.weekly  = {};
  if (!m.points.monthly) m.points.monthly = {};
  if (!m.stats)          m.stats          = { totalHours: 0, tasksCompleted: 0 };
  return m;
}

function getToday()   { return new Date().toISOString().split('T')[0]; }
function getWeekKey() {
  const d = new Date(), m = new Date(d);
  m.setDate(d.getDate() - (d.getDay() === 0 ? 6 : d.getDay() - 1));
  return m.toISOString().split('T')[0];
}
function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
const weekPts  = (m) => m.points?.weekly?.[getWeekKey()]   || 0;
const monthPts = (m) => m.points?.monthly?.[getMonthKey()] || 0;

function addPoints(member, pts, hours) {
  member.points.total += pts;
  member.points.weekly[getWeekKey()]   = (member.points.weekly[getWeekKey()]   || 0) + pts;
  member.points.monthly[getMonthKey()] = (member.points.monthly[getMonthKey()] || 0) + pts;
  member.stats.totalHours     += hours;
  member.stats.tasksCompleted += 1;
}
function deductPoints(member, pts, hours) {
  const wk = getWeekKey(), mo = getMonthKey();
  member.points.total         = Math.max(0, member.points.total - pts);
  member.points.weekly[wk]    = Math.max(0, (member.points.weekly[wk]  || 0) - pts);
  member.points.monthly[mo]   = Math.max(0, (member.points.monthly[mo] || 0) - pts);
  member.stats.totalHours     = Math.max(0, member.stats.totalHours    - hours);
  member.stats.tasksCompleted = Math.max(0, member.stats.tasksCompleted - 1);
}

// ─── Build the server-wide daily board ────────────────────────────────────
function buildDailyBoard(allData, date) {
  const members = Object.values(allData).filter(m => m.tasks?.[date]?.length > 0);

  if (members.length === 0) {
    return new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋  Daily Task Board  —  ${date}`)
      .setDescription('No tasks added yet today.\nUse `!addtask <name> <hours>` to get started!')
      .setTimestamp();
  }

  const lines = members.map(m => {
    const tasks   = m.tasks[date];
    const done    = tasks.filter(t => t.done).length;
    const total   = tasks.length;
    const pts     = tasks.filter(t => t.done).reduce((s,t) => s+(t.points||0), 0);
    const pct     = total > 0 ? Math.round((done/total)*100) : 0;
    const filled  = Math.round(pct/10);
    const bar     = '█'.repeat(filled) + '░'.repeat(10-filled);

    const taskLines = tasks.map(t => {
      const icon = t.done ? '✅' : '⬜';
      return `  ${icon} ${t.name} *(${t.hours}h · ${t.hours*POINTS_PER_HOUR}pts)*`;
    }).join('\n');

    return `**${m.username || m.userId}**  ${bar}  ${done}/${total} · **${pts}pts**\n${taskLines}`;
  }).join('\n\n');

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋  Daily Task Board  —  ${date}`)
    .setDescription(lines)
    .setFooter({ text: '⬜ Pending  ✅ Done  |  Click your task buttons below to mark complete' })
    .setTimestamp();
}

async function updateDailyBoard(guild) {
  const ch = guild.channels.cache.find(c => c.name === 'progress-report' && c.isTextBased());
  if (!ch) return;
  const today   = getToday();
  const allData = loadData();
  const embed   = buildDailyBoard(allData, today);
  const board   = loadBoard();

  if (board[today]?.messageId) {
    try {
      const msg = await ch.messages.fetch(board[today].messageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch {}
  }
  const msg = await ch.send({ embeds: [embed] });
  try { await msg.pin(); } catch {}
  board[today] = { messageId: msg.id };
  saveBoard(board);
}

// ─── Per-member task panel ─────────────────────────────────────────────────
function buildMemberPanel(member, tasks, username, date) {
  const done        = tasks.filter(t => t.done);
  const earnedPts   = done.reduce((s,t) => s+(t.points||0), 0);
  const possiblePts = tasks.reduce((s,t) => s+(t.hours*POINTS_PER_HOUR), 0);
  const pct    = possiblePts > 0 ? Math.round((earnedPts/possiblePts)*100) : 0;
  const filled = Math.round(pct/10);
  const bar    = '█'.repeat(filled) + '░'.repeat(10-filled);

  const rows = [
    '`  #   Task                      Hrs    Pts    Status  `',
    '`───────────────────────────────────────────────────────`',
  ];
  tasks.forEach((t, i) => {
    const num  = String(i+1).padStart(2,' ');
    const name = t.name.length > 22 ? t.name.slice(0,21)+'…' : t.name.padEnd(22,' ');
    const hrs  = String(t.hours).padEnd(5,' ');
    const pts  = String(t.hours*POINTS_PER_HOUR).padEnd(5,' ');
    const status = t.done ? '✅ Done  ' : '⬜ Open  ';
    rows.push(`\`  ${num}   ${name}  ${hrs}  ${pts}  \`${status}`);
  });
  rows.push('`───────────────────────────────────────────────────────`');

  return new EmbedBuilder()
    .setColor(done.length === tasks.length && tasks.length > 0 ? 0x57f287 : 0x5865f2)
    .setAuthor({ name: `${username}'s Task Panel — ${date}` })
    .setDescription(rows.join('\n'))
    .addFields(
      { name: 'Progress',  value: `${bar}  ${pct}%`,                       inline: false },
      { name: '⚡ Earned', value: `**${earnedPts}** / ${possiblePts} pts`, inline: true  },
      { name: '✅ Done',   value: `**${done.length}** / ${tasks.length}`,  inline: true  },
      { name: '🏆 Total',  value: `**${member.points.total} pts**`,        inline: true  },
    )
    .setFooter({ text: 'Click a button below to mark a task as complete' })
    .setTimestamp();
}

function buildTickButtons(tasks) {
  const open = tasks.filter(t => !t.done);
  if (open.length === 0) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('all_done').setLabel('All tasks done! 🎉').setStyle(ButtonStyle.Success).setDisabled(true)
    )];
  }
  const rows = [];
  for (let i = 0; i < Math.min(open.length, 25); i += 5) {
    const row = new ActionRowBuilder();
    open.slice(i, i+5).forEach(t => {
      const label = t.name.length > 18 ? t.name.slice(0,17)+'…' : t.name;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`tick_${t.id}`)
          .setLabel(`${label} (${t.hours}h)`)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }
  return rows;
}

async function postOrUpdatePanel(guild, userId, username) {
  const ch = guild.channels.cache.find(c => c.name === 'progress-report' && c.isTextBased());
  if (!ch) return;
  const data   = loadData();
  const member = getMember(data, userId);
  const today  = getToday();
  const tasks  = member.tasks[today] || [];
  const embed  = buildMemberPanel(member, tasks, username, today);
  const rows   = buildTickButtons(tasks);
  const board  = loadBoard();
  const key    = `panel_${userId}_${today}`;

  if (board[key]) {
    try {
      const msg = await ch.messages.fetch(board[key]);
      await msg.edit({ embeds: [embed], components: rows });
      return msg;
    } catch {}
  }
  const msg = await ch.send({ content: `<@${userId}>`, embeds: [embed], components: rows });
  board[key] = msg.id;
  saveBoard(board);
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUTTON HANDLER — instant approval, no AI
// ═══════════════════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('tick_')) return;

  const taskId = interaction.customId.replace('tick_', '');
  const userId = interaction.user.id;
  const today  = getToday();
  const data   = loadData();
  const member = getMember(data, userId);
  const tasks  = member.tasks[today] || [];
  const task   = tasks.find(t => t.id === taskId);

  if (!task)     return interaction.reply({ content: '⚠️ Task not found.', ephemeral: true });
  if (task.done) return interaction.reply({ content: '✅ Already completed!', ephemeral: true });

  const pts = Math.round(task.hours * POINTS_PER_HOUR);
  task.done       = true;
  task.points     = pts;
  task.verifiedAt = new Date().toISOString();
  addPoints(member, pts, task.hours);
  saveData(data);

  await updateDailyBoard(interaction.guild);
  await postOrUpdatePanel(interaction.guild, userId, member.username || interaction.user.username);

  return interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅  Task Complete!')
      .setDescription(`**"${task.name}"** marked as done!`)
      .addFields({ name: '⚡ Points Awarded', value: `**+${pts} pts**  (${task.hours}h × ${POINTS_PER_HOUR})  |  Total: **${member.points.total} pts**` })
      .setFooter({ text: 'Admin can unverify with !unverify if proof is not posted' })
      .setTimestamp()
    ],
    ephemeral: true,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const args   = message.content.trim().split(/\s+/);
  const cmd    = args[0].toLowerCase();
  const data   = loadData();
  const member = getMember(data, message.author.id);
  member.username = message.member?.displayName || message.author.username;

  // ── !addtask ───────────────────────────────────────────────────────────
  if (cmd === '!addtask') {
    const mentioned = message.mentions.users.first();

    if (mentioned) {
      if (!message.member.permissions.has('ManageGuild'))
        return message.reply('❌ Manage Server permission required.');
      const filtered = args.slice(1).filter(a => !a.startsWith('<@'));
      const hrs  = parseFloat(filtered[filtered.length-1]);
      if (isNaN(hrs) || hrs <= 0) return message.reply('❌ Usage: `!addtask @user <name> <hours>`');
      const name = filtered.slice(0, filtered.length-1).join(' ').trim();
      if (!name) return message.reply('❌ Include a task name.');
      const td = loadData(); const tm = getMember(td, mentioned.id);
      tm.username = mentioned.username;
      const today = getToday();
      if (!tm.tasks[today]) tm.tasks[today] = [];
      tm.tasks[today].push({ id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, name, hours: hrs, done: false, points: 0, addedAt: new Date().toISOString(), addedBy: message.author.username });
      saveData(td);
      await updateDailyBoard(message.guild);
      await postOrUpdatePanel(message.guild, mentioned.id, tm.username);
      return message.reply(`✅ Added **"${name}"** (${hrs}h = **${hrs*POINTS_PER_HOUR}pts**) for **${mentioned.username}**`);
    }

    const hrs  = parseFloat(args[args.length-1]);
    if (isNaN(hrs) || hrs <= 0) return message.reply('❌ Usage: `!addtask <name> <hours>`\nExample: `!addtask Write report 2`');
    const name = args.slice(1, args.length-1).join(' ').trim();
    if (!name) return message.reply('❌ Include a task name.');
    const today = getToday();
    if (!member.tasks[today]) member.tasks[today] = [];
    member.tasks[today].push({ id: `${Date.now()}_${Math.random().toString(36).slice(2,6)}`, name, hours: hrs, done: false, points: 0, addedAt: new Date().toISOString() });
    saveData(data);
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, message.author.id, member.username);
    return message.reply(`✅ **"${name}"** added — ${hrs}h = **${hrs*POINTS_PER_HOUR}pts** on completion`);
  }

  // ── !tasks ─────────────────────────────────────────────────────────────
  if (cmd === '!tasks') {
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, message.author.id, member.username);
    return message.reply('📋 Board and panel refreshed!');
  }

  // ── !removetask ────────────────────────────────────────────────────────
  if (cmd === '!removetask') {
    const today = getToday(); const tasks = member.tasks[today] || [];
    const idx = parseInt(args[1]) - 1;
    if (isNaN(idx) || idx < 0 || idx >= tasks.length)
      return message.reply(`❌ Usage: \`!removetask <number>\`\nYour tasks: ${tasks.map((t,i)=>`${i+1}. ${t.name}`).join(', ')||'none'}`);
    if (tasks[idx].done) return message.reply('❌ Cannot remove a completed task.');
    const removed = tasks.splice(idx, 1)[0];
    saveData(data);
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, message.author.id, member.username);
    return message.reply(`🗑️ Removed **"${removed.name}"**`);
  }

  // ── !updatehours ───────────────────────────────────────────────────────
  if (cmd === '!updatehours') {
    const today = getToday(); const tasks = member.tasks[today] || [];
    const idx = parseInt(args[1]) - 1; const hrs = parseFloat(args[2]);
    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
      const list = tasks.map((t,i)=>`${i+1}. ${t.name} (${t.hours}h)`).join('\n')||'No tasks today.';
      return message.reply(`❌ Usage: \`!updatehours <task#> <hours>\`\n\n**Your tasks:**\n${list}`);
    }
    if (isNaN(hrs) || hrs <= 0) return message.reply('❌ Invalid hours.');
    if (tasks[idx].done) return message.reply('❌ Task already completed. Ask admin to unverify first.');
    const old = tasks[idx].hours; tasks[idx].hours = hrs; saveData(data);
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, message.author.id, member.username);
    return message.reply(`✅ **"${tasks[idx].name}"**: ${old}h → **${hrs}h** (${old*POINTS_PER_HOUR} → **${hrs*POINTS_PER_HOUR}pts**)`);
  }

  // ── !progress ──────────────────────────────────────────────────────────
  if (cmd === '!progress') {
    const today = getToday(); const tt = member.tasks[today] || [];
    const done  = tt.filter(t=>t.done);
    const allD  = loadData();
    const mxW   = Math.max(...Object.values(allD).map(m=>weekPts(m)), 1);
    const mxM   = Math.max(...Object.values(allD).map(m=>monthPts(m)), 1);
    const bar   = (c,x) => { const p=Math.round((c/x)*100), f=Math.round(p/10); return '█'.repeat(f)+'░'.repeat(10-f)+`  **${c}pts**`; };
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: `${member.username}'s Progress` })
      .setTitle('📊  Progress Report')
      .addFields(
        { name: '🌅 Today',       value: `${done.length}/${tt.length} tasks  •  **${done.reduce((s,t)=>s+(t.points||0),0)}pts**`, inline: false },
        { name: '📅 This Week',   value: bar(weekPts(member), mxW),  inline: false },
        { name: '🗓️ This Month', value: bar(monthPts(member), mxM), inline: false },
        { name: '🏆 All Time',    value: `**${member.points.total}pts**  •  ${member.stats.tasksCompleted} tasks  •  ${member.stats.totalHours}h logged`, inline: false },
      )
      .setFooter({ text: `${POINTS_PER_HOUR}pts per hour` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── !leaderboard ───────────────────────────────────────────────────────
  if (cmd === '!leaderboard') {
    const allD = loadData();
    const entries = await Promise.all(Object.values(allD).map(async m => {
      let username = m.username || m.userId;
      if (!m.username) { try { const u = await client.users.fetch(m.userId); username = u.username; } catch {} }
      return { username, total: m.points?.total||0, weekly: weekPts(m), monthly: monthPts(m), tasks: m.stats?.tasksCompleted||0, hours: m.stats?.totalHours||0 };
    }));
    const medals = ['🥇','🥈','🥉'];
    const fmt = (arr,key) => arr.slice(0,5).map((e,i)=>`${medals[i]||`\`${i+1}.\``}  **${e.username}**  —  ${e[key].toLocaleString()}pts`).join('\n')||'_No data yet_';
    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🏆  Leaderboard')
      .setDescription('Live rankings — updated as tasks are completed.')
      .addFields(
        { name: '⚡ This Week',   value: fmt([...entries].sort((a,b)=>b.weekly-a.weekly),   'weekly'),  inline: false },
        { name: '\u200B',         value: '\u200B', inline: false },
        { name: '📅 This Month',  value: fmt([...entries].sort((a,b)=>b.monthly-a.monthly), 'monthly'), inline: false },
        { name: '\u200B',         value: '\u200B', inline: false },
        { name: '🏅 All Time',    value: fmt([...entries].sort((a,b)=>b.total-a.total),     'total'),   inline: false },
        { name: '\u200B',         value: '\u200B', inline: false },
        { name: '⏱️ Most Hours', value: [...entries].sort((a,b)=>b.hours-a.hours).slice(0,3).map((e,i)=>`${medals[i]}  **${e.username}**  —  ${e.hours}h  •  ${e.tasks} tasks`).join('\n')||'_No data yet_', inline: false },
      )
      .setFooter({ text: `${POINTS_PER_HOUR}pts/hour` })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── !verify @user <task#> [date] ──────────────────────────────────────
  if (cmd === '!verify') {
    if (!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.');
    const target = message.mentions.users.first();
    if (!target) return message.reply('Usage: `!verify @user <task#> [YYYY-MM-DD]`');
    const td = loadData(); const tm = getMember(td, target.id);
    const dateReg = /^\d{4}-\d{2}-\d{2}$/; const last = args[args.length-1];
    const date = dateReg.test(last) ? last : getToday();
    const idx  = parseInt(args[2]) - 1;
    const tasks = tm.tasks[date] || [];
    if (isNaN(idx) || idx < 0 || idx >= tasks.length) {
      const list = tasks.map((t,i)=>`${i+1}. ${t.name} (${t.hours}h) ${t.done?'✅':'⬜'}`).join('\n')||`No tasks on ${date}.`;
      return message.reply(`Usage: \`!verify @user <task#> [YYYY-MM-DD]\`\n\n**${target.username} on ${date}:**\n${list}`);
    }
    const task = tasks[idx];
    if (task.done) return message.reply('✅ Already completed.');
    const pts = task.hours * POINTS_PER_HOUR;
    task.done = true; task.points = pts; task.verifiedAt = new Date().toISOString();
    task.note = `Manually verified by ${message.author.username}`;
    addPoints(tm, pts, task.hours);
    saveData(td);
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, target.id, tm.username || target.username);
    return message.reply(`✅ Verified **"${task.name}"** for ${target.username} on ${date} — **+${pts}pts**`);
  }

  // ── !unverify @user <task#> [date] ────────────────────────────────────
  if (cmd === '!unverify') {
    if (!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.');
    const target = message.mentions.users.first();
    if (!target) return message.reply('Usage: `!unverify @user <task#> [YYYY-MM-DD]`');
    const td = loadData(); const tm = getMember(td, target.id);
    const dateReg = /^\d{4}-\d{2}-\d{2}$/; const last = args[args.length-1];
    const date = dateReg.test(last) ? last : getToday();
    const idx  = parseInt(args[2]) - 1;
    const tasks = tm.tasks[date] || [];
    if (isNaN(idx) || idx < 0 || idx >= tasks.length)
      return message.reply(`No task #${idx+1} found on ${date}.`);
    const task = tasks[idx];
    if (!task.done) return message.reply('⚠️ Task is not completed yet.');
    const pts = task.points || 0;
    task.done = false; task.points = 0; task.verifiedAt = null;
    if (pts > 0) deductPoints(tm, pts, task.hours);
    saveData(td);
    await updateDailyBoard(message.guild);
    await postOrUpdatePanel(message.guild, target.id, tm.username || target.username);
    return message.reply(`❌ Unverified **"${task.name}"** for ${target.username}${pts > 0 ? ` — **-${pts}pts** deducted` : ''}`);
  }

  // ── !givepoints @user <pts> [reason] ─────────────────────────────────
  if (cmd === '!givepoints') {
    if (!message.member.permissions.has('ManageGuild')) return message.reply('❌ Manage Server required.');
    const target = message.mentions.users.first();
    if (!target) return message.reply('Usage: `!givepoints @user <points> [reason]`');
    const pts = parseInt(args[2]);
    if (isNaN(pts) || pts === 0) return message.reply('❌ Provide a valid number (negative to deduct).');
    const reason = args.slice(3).join(' ') || 'Bonus from admin';
    const td = loadData(); const tm = getMember(td, target.id);
    tm.username = target.username;
    const wk = getWeekKey(), mo = getMonthKey();
    tm.points.total       = Math.max(0, tm.points.total + pts);
    tm.points.weekly[wk]  = Math.max(0, (tm.points.weekly[wk]  || 0) + pts);
    tm.points.monthly[mo] = Math.max(0, (tm.points.monthly[mo] || 0) + pts);
    saveData(td);
    return message.reply(`${pts>0?'🎁':'📉'} **${pts>0?'+'+pts:pts}pts** for **${target.username}**\n📝 ${reason}\n🏆 New total: **${tm.points.total}pts**`);
  }

  // ── !help ──────────────────────────────────────────────────────────────
  if (cmd === '!help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📖  Progress Bot — Commands')
      .setDescription(`**${POINTS_PER_HOUR}pts per hour of work**\n\nAdd your tasks → click the buttons to mark complete → points awarded instantly`)
      .addFields(
        { name: '`!addtask <name> <hours>`',          value: 'Add a task to your board\nExample: `!addtask Write report 2`',        inline: false },
        { name: '`!tasks`',                           value: 'Refresh your task panel and the daily board',                         inline: false },
        { name: '`!removetask <#>`',                  value: 'Remove an incomplete task',                                           inline: false },
        { name: '`!updatehours <#> <hours>`',         value: 'Update hours before completing\nExample: `!updatehours 1 3`',         inline: false },
        { name: '`!progress`',                        value: 'Your full stats — today, weekly, monthly, all time',                  inline: false },
        { name: '`!leaderboard`',                     value: 'Weekly / monthly / all-time rankings',                                inline: false },
        { name: '\u200B', value: '**─── Admin Commands ───**',                                                                      inline: false },
        { name: '`!addtask @user <name> <hours>`',    value: 'Add a task for a specific member',                                    inline: false },
        { name: '`!verify @user <#> [date]`',         value: 'Mark a task as complete manually\nExample: `!verify @John 1`',        inline: false },
        { name: '`!unverify @user <#> [date]`',       value: 'Reverse a completion and deduct points',                              inline: false },
        { name: '`!givepoints @user <pts> [reason]`', value: 'Award or deduct points manually\nExample: `!givepoints @John 20 Bonus`', inline: false },
      )
      .setFooter({ text: 'Admin can always reverse completions with !unverify if proof was not posted' })
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }
});

client.on('ready', () => {
  console.log(`✅ Progress Bot online as ${client.user.tag}`);
  setInterval(() => console.log(`[alive] ${new Date().toISOString()}`), 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
