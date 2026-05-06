require('dotenv').config();
const { 
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes
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

const GUILD_ID = '1472199797287944384';
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
    if (String(rows[i][2]).replace(/^'/, '') === String(discordId)) return i + 1;
  }
  return null;
}

async function appendHireRow(sheets, id, username, discordId, date, hiredBy) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[id, username, "'" + discordId, date, hiredBy, 'Нанят', RANKS[0]]] },
  });
}

async function updateStatus(sheets, rowNumber, status) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!F${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[status]] },
  });
}

async function updateRank(sheets, rowNumber, rank) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!G${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
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

const slashCommands = [
  new SlashCommandBuilder()
    .setName('hire')
    .setDescription('Принять сотрудника в семью')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true))
    .addStringOption(o => o.setName('id').setDescription('6-значный ID (123456 или 123-456)').setRequired(true)),

  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Повысить сотрудника на один ранг')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unverify')
    .setDescription('Понизить сотрудника на один ранг')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true)),

  new SlashCommandBuilder()
    .setName('fire')
    .setDescription('Уволить сотрудника')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина увольнения').setRequired(false)),

  new SlashCommandBuilder()
    .setName('rebuke')
    .setDescription('Выдать выговор сотруднику')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Причина выговора').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unrebuke')
    .setDescription('Снять выговор с сотрудника')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true)),

  new SlashCommandBuilder()
    .setName('rebukes')
    .setDescription('История выговоров сотрудника')
    .addUserOption(o => o.setName('user').setDescription('Пользователь').setRequired(true)),

  new SlashCommandBuilder()
    .setName('заявки')
    .setDescription('Обновить панель заявок'),
].map(c => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
  try {
    // Guild registration = instant
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID),
      { body: slashCommands }
    );
    console.log('✅ Slash команды зарегистрированы (мгновенно)');
  } catch (e) {
    console.error('❌ Ошибка регистрации команд:', e);
  }
});

client.on('interactionCreate', async (interaction) => {

  // Button
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

  // Modal
  if (interaction.isModalSubmit()) {
    if (interaction.customId !== 'modal_cadet') return;
    const { fields, user, guild } = interaction;
    const embed = new EmbedBuilder()
      .setTitle('🟢 Курсант')
      .setColor(0x57f287)
      .addFields(
        { name: 'Имя',       value: fields.getTextInputValue('firstName'), inline: true },
        { name: 'Фамилия',   value: fields.getTextInputValue('lastName'),  inline: true },
        { name: 'Статик ID', value: fields.getTextInputValue('staticId'),  inline: true },
        { name: 'Причина',   value: fields.getTextInputValue('reason') },
        { name: 'Статус',    value: '⏳ Ожидает рассмотрения' },
      )
      .setFooter({ text: user.tag, iconURL: user.displayAvatarURL() })
      .setTimestamp();
    const logChannel = guild.channels.cache.find(c => c.name === APP_LOG_CHANNEL);
    if (logChannel) { await logChannel.send({ embeds: [embed] }); await refreshPanel(logChannel); }
    return interaction.reply({ content: '✅ Заявка отправлена! Ожидайте решения.', flags: 64 });
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, guild, member } = interaction;

  const hasPermission = member.roles.cache.some(r => r.name === REQUIRED_ROLE);
  if (!hasPermission) {
    return interaction.reply({ content: '❌ У тебя нет прав для использования этой команды.', flags: 64 });
  }

  const getRole = (name) => guild.roles.cache.find(r => r.name === name);
  const getChannel = (name) => guild.channels.cache.find(c => c.name === name);

  await interaction.deferReply();

  // /заявки
  if (commandName === 'заявки') {
    const logChannel = guild.channels.cache.find(c => c.name === APP_LOG_CHANNEL);
    if (logChannel) await refreshPanel(logChannel);
    return interaction.editReply('✅ Панель обновлена.');
  }

  // /rebukes
  if (commandName === 'rebukes') {
    const target = interaction.options.getMember('user');
    const history = rebukeHistory[target.id] || [];
    if (history.length === 0) return interaction.editReply(`📋 У ${target} нет истории выговоров.`);
    const activeCount = history.filter(e => !e.fired && !e.removed).length;
    const isFired = history.some(e => e.fired);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📋 История выговоров — ${target.user.username}`)
      .setDescription(isFired
        ? `Активных выговоров: **${activeCount}/3**\n🔴 **Уволен** — история сохранена`
        : `Активных выговоров: **${activeCount}/3**`)
      .setThumbnail(target.user.displayAvatarURL())
      .setTimestamp()
      .setFooter({ text: guild.name, iconURL: guild.iconURL() });
    history.forEach((e, i) => {
      let label, note;
      if (e.fired) { label = '🗂️ Архив'; note = '\n🔴 Выдан до увольнения'; }
      else if (e.removed) { label = '✅ Снят'; note = `\n✅ Снял: ${e.removedBy} — ${e.removedDate}`; }
      else { label = '⚠️ Активен'; note = ''; }
      embed.addFields({ name: `${label} | Выговор #${i + 1} — ${e.date}`, value: `📝 ${e.reason}\n🛡️ Выдал: ${e.issuedBy}${note}` });
    });
    return interaction.editReply({ embeds: [embed] });
  }

  // /rebuke
  if (commandName === 'rebuke') {
    const target = interaction.options.getMember('user');
    if (target.roles.cache.some(r => r.name === 'Авторитет[8]'))
      return interaction.editReply('❌ Нельзя выдать выговор **Авторитету[8]**.');

    const reason = interaction.options.getString('reason') || 'Причина не указана';
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

    if (!rebukeHistory[target.id]) rebukeHistory[target.id] = [];
    rebukeHistory[target.id].push({ reason, issuedBy: interaction.user.tag, date: dateStr });

    const count = rebukeHistory[target.id].filter(e => !e.fired && !e.removed).length;
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
      rebukeHistory[target.id] = rebukeHistory[target.id].map(e => ({ ...e, fired: true }));
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
        { name: '🛡️ Выдал', value: `${interaction.user}`, inline: true },
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
    return interaction.editReply(`⚠️ Выговор выдан ${target}. Причина: **${reason}**. Выговоров: **${count >= 3 ? '3 → сброшено' : count}/3**.`);
  }

  // /unrebuke
  if (commandName === 'unrebuke') {
    const target = interaction.options.getMember('user');
    const history = rebukeHistory[target.id] || [];
    const activeRebukes = history.filter(e => !e.fired && !e.removed);
    if (activeRebukes.length === 0) return interaction.editReply(`ℹ️ У ${target} нет активных выговоров.`);
    // Mark last active rebuke as removed instead of deleting it
    const lastActiveIdx = rebukeHistory[target.id].reduce((acc, e, i) => (!e.fired && !e.removed ? i : acc), -1);
    const removed = rebukeHistory[target.id][lastActiveIdx];
    rebukeHistory[target.id][lastActiveIdx] = { ...removed, removed: true, removedBy: interaction.user.tag, removedDate: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) };
    const newCount = rebukeHistory[target.id].filter(e => !e.fired && !e.removed).length;
    const unrebukeEmbed = new EmbedBuilder()
      .setColor(0x00C853)
      .setTitle('✅ Выговор снят')
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '👤 Сотрудник', value: `${target}`, inline: true },
        { name: '🛡️ Снял', value: `${interaction.user}`, inline: true },
        { name: '📝 Снятый выговор', value: removed.reason },
        { name: '📊 Осталось выговоров', value: `**${newCount}/3**`, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: guild.name, iconURL: guild.iconURL() });
    await target.send({ embeds: [unrebukeEmbed] }).catch(() => {});
    const logChannel = getChannel(UNREBUKE_LOG_CHANNEL);
    if (logChannel) await logChannel.send({ embeds: [unrebukeEmbed] });
    return interaction.editReply(`✅ С ${target} снят один выговор. Осталось: **${newCount}/3**.`);
  }

  // /hire
  if (commandName === 'hire') {
    const target = interaction.options.getMember('user');
    const rawId = interaction.options.getString('id');
    const idClean = rawId.replace('-', '');
    if (!/^\d{6}$/.test(idClean)) return interaction.editReply('❌ Неверный формат ID. Используй 6 цифр: `123456` или `123-456`');
    const normalizedId = rawId.includes('-') ? rawId : `${rawId.slice(0, 3)}-${rawId.slice(3)}`;

    const role = getRole(RANKS[0]);
    if (!role) return interaction.editReply(`❌ Роль \`${RANKS[0]}\` не найдена на сервере.`);
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
      await appendHireRow(sheets, normalizedId, target.user.username, target.id, dateStr, interaction.user.tag);
    } catch (e) { console.error('Sheets error:', e.message); }

    return interaction.editReply(`✅ ${target} принят в семью. ID: **${normalizedId}**. Звание: **${RANKS[0]}**.`);
  }

  // /verify
  if (commandName === 'verify') {
    const target = interaction.options.getMember('user');
    let currentIndex = -1;
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (target.roles.cache.some(r => r.name === RANKS[i])) { currentIndex = i; break; }
    }
    if (currentIndex === -1) return interaction.editReply(`⚠️ У ${target} нет звания. Сначала используй \`/hire\`.`);
    if (currentIndex === RANKS.length - 1) return interaction.editReply(`⚠️ ${target} на максимальном звании. Авторитет выдаётся только вручную.`);
    const oldRole = getRole(RANKS[currentIndex]);
    const newRole = getRole(RANKS[currentIndex + 1]);
    if (!newRole) return interaction.editReply(`❌ Роль \`${RANKS[currentIndex + 1]}\` не найдена.`);
    await target.roles.remove(oldRole).catch(() => {});
    await target.roles.add(newRole);
    try {
      const sheets = await getSheets();
      const rowNum = await findRowByDiscordId(sheets, target.id);
      if (rowNum) await updateRank(sheets, rowNum, RANKS[currentIndex + 1]);
    } catch (e) { console.error('Sheets error:', e.message); }
    return interaction.editReply(`⬆️ ${target} повышен до **${RANKS[currentIndex + 1]}**.`);
  }

  // /unverify
  if (commandName === 'unverify') {
    const target = interaction.options.getMember('user');
    if (target.roles.cache.some(r => r.name === 'Авторитет[8]'))
      return interaction.editReply(`❌ Нельзя понизить **Авторитет[8]** через команду.`);
    let currentIndex = -1;
    for (let i = RANKS.length - 1; i >= 0; i--) {
      if (target.roles.cache.some(r => r.name === RANKS[i])) { currentIndex = i; break; }
    }
    if (currentIndex === -1) return interaction.editReply(`⚠️ У ${target} нет звания для понижения.`);
    if (currentIndex === 0) return interaction.editReply(`⚠️ ${target} уже на низшем звании. Используй \`/fire\`.`);
    const oldRole = getRole(RANKS[currentIndex]);
    const newRole = getRole(RANKS[currentIndex - 1]);
    if (!newRole) return interaction.editReply(`❌ Роль \`${RANKS[currentIndex - 1]}\` не найдена.`);
    await target.roles.remove(oldRole).catch(() => {});
    await target.roles.add(newRole);
    try {
      const sheets = await getSheets();
      const rowNum = await findRowByDiscordId(sheets, target.id);
      if (rowNum) await updateRank(sheets, rowNum, RANKS[currentIndex - 1]);
    } catch (e) { console.error('Sheets error:', e.message); }
    return interaction.editReply(`⬇️ ${target} понижен до **${RANKS[currentIndex - 1]}**.`);
  }

  // /fire
  if (commandName === 'fire') {
    const target = interaction.options.getMember('user');
    if (target.roles.cache.some(r => r.name === 'Авторитет[8]'))
      return interaction.editReply(`❌ Нельзя уволить **Авторитет[8]** через команду.`);
    const reason = interaction.options.getString('reason') || 'Причина не указана';
    for (const rankName of RANKS) {
      const role = getRole(rankName);
      if (role && target.roles.cache.has(role.id)) await target.roles.remove(role).catch(() => {});
    }
    const firedRole = getRole(FIRED_ROLE);
    if (!firedRole) return interaction.editReply(`❌ Роль \`${FIRED_ROLE}\` не найдена.`);
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
    return interaction.editReply(`🔴 ${target} был уволен из семьи. Причина: **${reason}**.`);
  }
});

client.login(process.env.BOT_TOKEN);
