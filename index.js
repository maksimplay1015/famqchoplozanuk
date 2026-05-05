require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { google } = require('googleapis');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

const PREFIX = '?';
const REQUIRED_ROLE = 'Отдел Кадрового Обеспечение';

const RANKS = [
  'Лебедка[1]',
  'Шнырь[2]',
  'Приближённый[3]',
  'Бригадир[4]',
  'Положенец[5]',
  'Левая Рука[6]',
  'Босс[7]',
];

const FIRED_ROLE = 'Уволен';
const REBUKE_LOG_CHANNEL = 'дисциплинарные-взыскания';
const UNREBUKE_LOG_CHANNEL = 'снятие-дисциплинарных-взысканий';
const SHEET_ID = '1Ky08aLep4_dvZfgZmcv98qsphepAP-Nw1-rhZd0E-0w';
const SHEET_TAB = 'oak';
const APP_LOG_CHANNEL = 'запрос-роли';

const appCooldowns = new Map();
const COOLDOWN_MS = 60_000;
const rebukeHistory = {};

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheets() {
  const c = await auth.getClient();
  return google.sheets({ version: 'v4', auth: c });
}

async function findRowByDiscordId(sheets, discordId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:G`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][2] === discordId) return i + 1;
  }
  return null;
}

async function appendHireRow(sheets, id, username, discordId, date, hiredBy) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:G`,
    valueInputOption: 'RAW',
    requestBody: { values: [[id, username, discordId, date, hiredBy, 'Нанят', RANKS[0]]] },
  });
}

async function updateStatus(sheets, rowNumber, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!F${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] },
  });
}

async function updateRank(sheets, rowNumber, rank) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!G${rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[rank]] },
  });
}

function buildCadetModal() {
  return new ModalBuilder()
    .setCustomId('modal_cadet')
    .setTitle('заявка на получение роли')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('firstName').setLabel('Имя')
          .setPlaceholder('Введите ваше имя').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('lastName').setLabel('Фамилия')
          .setPlaceholder('Введите вашу фамилию').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('staticId').setLabel('Статик ID')
          .setPlaceholder('Введите 6 цифр (пример: 537123)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('reason').setLabel('Причина')
          .setPlaceholder('Электронная заявка / собеседование').setStyle(TextInputStyle.Paragraph).setRequired(true)
      ),
    );
}

async function refreshPanel(logChannel) {
  const messages = await logChannel.messages.fetch({ limit: 50 });
  const panelMsg = messages.find(m => m.author.id === client.user.id && m.components.length > 0);
  if (panelMsg) await panelMsg.delete().catch(() => {});

  const panelEmbed = new EmbedBuilder()
    .setTitle('Подача заявки')
    .setDescription(
      '**Выберите тип заявки:**\n\n' +
      '🟢 **Курсант** — зачисление в академию\n\n' +
      '⏱ Новую заявку можно отправить через 60 сек. Хранение: 7 дней.'
    )
    .setColor(0x2b2d31);

  const panelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('app_cadet').setLabel('Курсант')
      .setStyle(ButtonStyle.Success).setEmoji('🟢'),
  );

  await logChannel.send({ embeds: [panelEmbed], components: [panelRow] });
}

client.once('ready', () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId !== 'app_cadet') return;
    const now = Date.now();
    const userId = interaction.user.id;
    if (appCooldowns.has(userId) && now - appCooldowns.get(userId) < COOLDOWN_MS) {
      const left = Math.ceil((COOLDOWN_MS - (now - appCooldowns.get(userId))) / 1000);
      return interaction.reply({ content: `⏳ Подожди ещё **${left} сек.** перед следующей заявкой.`, flags: 64 });
    }
    appCooldowns.set(userId, now);
    return interaction.showModal(buildCadetModal());
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId !== 'modal_cadet') return;
    const { fields, user, guild } = interaction;
    const firstName = fields.getTextInputValue('firstName');
    const lastName  = fields.getTextInputValue('lastName');
    const staticId  = fields.getTextInputValue('staticId');
    const reason    = fields.getTextInputValue('reason');

    const embed = new EmbedBuilder()
      .setTitle('🟢 Курсант')
      .setColor(0x57f287)
      .addFields(
        { name: 'Имя',       value: firstName, inline: true },
        { name: 'Фамилия',   value: lastName,  inline: true },
        { name: 'Статик ID', value: staticId,  inline: true },
        { name: 'Причина',   value: reason },
        { name: 'Статус',    value: '⏳ Ожидает рассмотрения' },
      )
      .setFooter({ text: user.tag, iconURL: user.displayAvatarURL() })
      .setTimestamp();

    const logChannel = guild.channels.cache.find(c => c.name === APP_LOG_CHANNEL);
    if (logChannel) {
      await logChannel.send({ embeds: [embed] });
      await refreshPanel(logChannel);
    }
    return interaction.reply({ content: '✅ Заявка отправлена! Ожидайте решения.', flags: 64 });
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ?заявки — refresh application panel
  if (command === 'заявки') {
    const hasPermission = message.member.roles.cache.some(r => r.name === REQUIRED_ROLE);
    if (!hasPermission) return message.reply('❌ У тебя нет прав для использования этой команды.');
    const logChannel = message.guild.channels.cache.find(c => c.name === APP_LOG_CHANNEL);
    if (logChannel) await refreshPanel(logChannel);
    await message.delete().catch(() => {});
    return;
  }

  const validCommands = ['hire', 'verify', 'unverify', 'fire', 'rebuke', 'unrebuke', 'rebukes'];
  if (!validCommands.includes(command)) return;

  const hasPermission = message.member.roles.cache.some(r => r.name === REQUIRED_ROLE);
  if (!hasPermission) return message.reply('❌ У тебя нет прав для использования этой команды.');

  const guild = message.guild;
  const getRole = (name) => guild.roles.cache.find(r => r.name === name);
  const getChannel = (name) => guild.channels.cache.find(c => c.name === name);

  // All commands need a mention — get it once here
  const target = message.mentions.members.first();

  // ?rebukes — only needs mention, no extra args
  if (command === 'rebukes') {
    if (!target) return message.reply('❌ Укажи пользователя. Пример: `?rebukes @user`');
    const history = rebukeHistory[target.id] || [];
    if (history.length === 0) return message.reply(`📋 У ${target} нет выговоров.`);
    const historyEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📋 История выговоров — ${target.user.username}`)
      .setDescription(`Активных выговоров: **${history.length}/3**`)
      .setThumbnail(target.user.displayAvatarURL())
      .setTimestamp()
      .setFooter({ text: guild.name, iconURL: guild.iconURL() });
    history.forEach((entry, index) => {
      historyEmbed.addFields({
        name: `Выговор #${index + 1} — ${entry.date}`,
        value: `📝 Причина: ${entry.reason}\n🛡️ Выдал: ${entry.issuedBy}`,
      });
    });
    return message.reply({ embeds: [historyEmbed] });
  }

  // ?rebuke @user reason
  if (command === 'rebuke') {
    if (!target) return message.reply('❌ Укажи пользователя. Пример: `?rebuke @user причина`');
    if (target.roles.cache.some(r => r.name === 'Авторитет[8]'))
      return message.reply('❌ Нельзя выдать выговор **Авторитету[8]**.');

    const reason = args.slice(1).join(' ') || 'Причина не указана';
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    if (!rebukeHistory[target.id]) rebukeHistory[target.id] = [];
    rebukeHistory[target.id].push({ reason, issuedBy: message.author.tag, date: dateStr });

    const count = rebukeHistory[target.id].length;
    let actionText = 'Без действий';
    let embedColor = 0xFFA500;

    if (count === 2) {
      embedColor = 0xFF4500;
      let idx = -1;
      for (let i = RANKS.length - 1; i >= 0; i--) {
        if (target.roles.cache.some(r => r.name === RANKS[i])) { idx = i; break; }
      }
      if (idx > 0) {
        const oldRole = getRole(RANKS[idx]);
        const newRole = getRole(RANKS[idx - 1]);
        if (oldRole) await target.roles.remove(oldRole).catch(() => {});
        if (newRole) await target.roles.add(newRole).catch(() => {});
        actionText = `Понижен до **${RANKS[idx - 1]}**`;
        try {
          const sheets = await getSheets();
          const rowNum = await findRowByDiscordId(sheets, target.id);
          if (rowNum) await updateRank(sheets, rowNum, RANKS[idx - 1]);
        } catch (e) { console.error('Sheets error:', e.message); }
      } else {
        actionText = 'Понижение невозможно — низшее звание';
      }
    }

    if (count >= 3) {
      embedColor = 0xFF0000;
      for (const rankName of RANKS) {
        const role = getRole(rankName);
        if (role && target.roles.cache.has(role.id)) await target.roles.remove(role).catch(() => {});
      }
      const firedRole = getRole(FIRED_ROLE);
      if (firedRole) await target.roles.add(firedRole).catch(() => {});
      rebukeHistory[target.id] = [];
      actionText = '🔴 Уволен из семьи';
      try {
        const sheets = await getSheets();
        const rowNum = await findRowByDiscordId(sheets, target.id);
        if (rowNum) { await updateStatus(sheets, rowNum, 'Уволен (3 выговора)'); await updateRank(sheets, rowNum, '-'); }
      } catch (e) { console.error('Sheets error:', e.message); }
      await target.send(`🔴 Вы были уволены из семьи после **3 выговоров**.\nПричина последнего выговора: ${reason}`).catch(() => {});
    }

    const rebukeEmbed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('⚠️ Был выдан Выговор')
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '👤 Сотрудник', value: `${target}`, inline: true },
        { name: '🛡️ Выдал', value: `${message.author}`, inline: true },
        { name: '📝 Причина', value: reason },
        { name: '📊 Выговоров', value: `**${count >= 3 ? '3 (сброшено)' : count}/3**`, inline: true },
        { name: '⚡ Действие', value: actionText, inline: true },
        { name: '🕐 Дата', value: dateStr, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: guild.name, iconURL: guild.iconURL() });

    await target.send({ embeds: [rebukeEmbed] }).catch(() => {});
    const logChannel = getChannel(REBUKE_LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [rebukeEmbed] });
    return message.reply(`⚠️ Выговор выдан ${target}. Причина: **${reason}**. Выговоров: **${count >= 3 ? '3 → сброшено' : count}/3**.`);
  }

  // ?unrebuke @user
  if (command === 'unrebuke') {
    if (!target) return message.reply('❌ Укажи пользователя. Пример: `?unrebuke @user`');
    const history = rebukeHistory[target.id] || [];
    if (history.length === 0) return message.reply(`ℹ️ У ${target} нет выговоров.`);
    const removed = rebukeHistory[target.id].pop();
    const newCount = rebukeHistory[target.id].length;
    const unrebukeEmbed = new EmbedBuilder()
      .setColor(0x00C853)
      .setTitle('✅ Выговор снят')
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '👤 Сотрудник', value: `${target}`, inline: true },
        { name: '🛡️ Снял', value: `${message.author}`, inline: true },
        { name: '📝 Снятый выговор', value: removed.reason },
        { name: '📊 Осталось выговоров', value: `**${newCount}/3**`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: guild.name, iconURL: guild.iconURL() });
    await target.send({ embeds: [unrebukeEmbed] }).catch(() => {});
    const logChannel = getChannel(UNREBUKE_LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [unrebukeEmbed] });
    return message.reply(`✅ С ${target} снят один выговор. Осталось: **${newCount}/3**.`);
  }

  // All rank commands need a target
  if (!target) return message.reply('❌ Укажи пользователя.');

  const isAvtoritet = () => target.roles.cache.some(r => r.name === 'Авторитет[8]');
  const getCurrentRank = () => {
    for (let i = RANKS.length - 1; i >= 0; i--)
      if (target.roles.cache.some(r => r.name === RANKS[i])) return i;
    return -1;
  };

  // ?hire @user ID
  if (command === 'hire') {
    const rawId = args[1];
    if (!rawId) return message.reply('❌ Укажи ID. Пример: `?hire @user 123456` или `?hire @user 123-456`');
    const idClean = rawId.replace('-', '');
    if (!/^\d{6}$/.test(idClean)) return message.reply('❌ Неверный формат ID. Используй 6 цифр: `123456` или `123-456`');
    const normalizedId = rawId.includes('-') ? rawId : `${rawId.slice(0, 3)}-${rawId.slice(3)}`;

    const role = getRole(RANKS[0]);
    if (!role) return message.reply(`❌ Роль \`${RANKS[0]}\` не найдена на сервере.`);
    const firedRole = getRole(FIRED_ROLE);
    if (firedRole && target.roles.cache.has(firedRole.id)) await target.roles.remove(firedRole).catch(() => {});
    await target.roles.add(role);
    const sostav = getRole('Состав ЧОП Лозанук');
    if (sostav) await target.roles.add(sostav).catch(() => {});
    const akademiya = getRole('Академия ЧОП Лозанук');
    if (akademiya) await target.roles.add(akademiya).catch(() => {});

    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    try {
      const sheets = await getSheets();
      await appendHireRow(sheets, normalizedId, target.user.username, target.id, dateStr, message.author.tag);
    } catch (e) { console.error('Sheets error:', e.message); }

    return message.reply(`✅ ${target} принят в семью. ID: **${normalizedId}**. Звание: **${RANKS[0]}**.`);
  }

  // ?verify
  if (command === 'verify') {
    const currentIndex = getCurrentRank();
    if (currentIndex === -1) return message.reply(`⚠️ У ${target} нет звания. Сначала используй \`?hire\`.`);
    if (currentIndex === RANKS.length - 1) return message.reply(`⚠️ ${target} достиг максимального звания. Авторитет выдаётся только вручную.`);
    const oldRole = getRole(RANKS[currentIndex]);
    const newRole = getRole(RANKS[currentIndex + 1]);
    if (!newRole) return message.reply(`❌ Роль \`${RANKS[currentIndex + 1]}\` не найдена.`);
    await target.roles.remove(oldRole).catch(() => {});
    await target.roles.add(newRole);
    try {
      const sheets = await getSheets();
      const rowNum = await findRowByDiscordId(sheets, target.id);
      if (rowNum) await updateRank(sheets, rowNum, RANKS[currentIndex + 1]);
    } catch (e) { console.error('Sheets error:', e.message); }
    return message.reply(`⬆️ ${target} повышен до **${RANKS[currentIndex + 1]}**.`);
  }

  // ?unverify
  if (command === 'unverify') {
    if (isAvtoritet()) return message.reply(`❌ Нельзя понизить **Авторитет[8]** через команду.`);
    const currentIndex = getCurrentRank();
    if (currentIndex === -1) return message.reply(`⚠️ У ${target} нет звания для понижения.`);
    if (currentIndex === 0) return message.reply(`⚠️ ${target} уже на низшем звании. Используй \`?fire\`.`);
    const oldRole = getRole(RANKS[currentIndex]);
    const newRole = getRole(RANKS[currentIndex - 1]);
    if (!newRole) return message.reply(`❌ Роль \`${RANKS[currentIndex - 1]}\` не найдена.`);
    await target.roles.remove(oldRole).catch(() => {});
    await target.roles.add(newRole);
    try {
      const sheets = await getSheets();
      const rowNum = await findRowByDiscordId(sheets, target.id);
      if (rowNum) await updateRank(sheets, rowNum, RANKS[currentIndex - 1]);
    } catch (e) { console.error('Sheets error:', e.message); }
    return message.reply(`⬇️ ${target} понижен до **${RANKS[currentIndex - 1]}**.`);
  }

  // ?fire @user reason
  if (command === 'fire') {
    if (isAvtoritet()) return message.reply(`❌ Нельзя уволить **Авторитет[8]** через команду.`);
    const reason = args.slice(1).join(' ') || 'Причина не указана';
    for (const rankName of RANKS) {
      const role = getRole(rankName);
      if (role && target.roles.cache.has(role.id)) await target.roles.remove(role).catch(() => {});
    }
    const firedRole = getRole(FIRED_ROLE);
    if (!firedRole) return message.reply(`❌ Роль \`${FIRED_ROLE}\` не найдена.`);
    await target.roles.add(firedRole);
    const sostav = getRole('Состав ЧОП Лозанук');
    if (sostav) await target.roles.remove(sostav).catch(() => {});
    const akademiya = getRole('Академия ЧОП Лозанук');
    if (akademiya) await target.roles.remove(akademiya).catch(() => {});
    try {
      const sheets = await getSheets();
      const rowNum = await findRowByDiscordId(sheets, target.id);
      if (rowNum) { await updateStatus(sheets, rowNum, 'Уволен'); await updateRank(sheets, rowNum, '-'); }
    } catch (e) { console.error('Sheets error:', e.message); }
    await target.send(`🔴 Вы были уволены из семьи.\n📝 Причина: ${reason}`).catch(() => {});
    return message.reply(`🔴 ${target} был уволен из семьи. Причина: **${reason}**.`);
  }
});

client.login(process.env.BOT_TOKEN);
