const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const { MongoClient } = require('mongodb');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  jidNormalizedUser
} = require('baileys');

// ---------------- CONFIG ----------------

const config = {
  PREFIX: '/',
  MAX_RETRIES: 3,
  BOT_NAME: 'RAVIYA MD',
  BOT_FOOTER: 'GROUP MANAGEMENT MINI BOT',
  IMAGE_URL: 'https://i.ibb.co/4wGBd0Z7/Rashmika-Ofc.jpg',
  OWNER_NUMBER: '94778430626@s.whatsapp.net',
  DEFAULT_MODE: 'public' // Default mode as public
};

// ---------------- MONGO SETUP ----------------

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://raviya:raviyafree@dtzraviya.klutf2r.mongodb.net/?appName=dtzraviya';
const MONGO_DB = process.env.MONGO_DB || 'MY_TEST';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, configsCol, chatStatsCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch(e){}
  mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  sessionsCol = mongoDB.collection('sessions');
  numbersCol = mongoDB.collection('numbers');
  configsCol = mongoDB.collection('configs');
  chatStatsCol = mongoDB.collection('chat_stats_final'); 

  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  await chatStatsCol.createIndex({ userGroupKey: 1 }, { unique: true });
  console.log('✅ MongoDB connected and indexes ready for RAVIYAMD');
}

// ---------------- HELPERS ----------------

async function saveCredsToMongo(number, creds, keys = null) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await sessionsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, creds, keys, updatedAt: new Date() } }, { upsert: true }); } catch (e) {}
}
async function loadCredsFromMongo(number) { try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); return await sessionsCol.findOne({ number: sanitized }); } catch (e) { return null; } }
async function addNumberToMongo(number) { try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true }); } catch (e) {} }

async function getBotConfig(number) {
    try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); const doc = await configsCol.findOne({ number: sanitized }); return doc ? doc.data : { mode: config.DEFAULT_MODE }; } catch (e) { return { mode: config.DEFAULT_MODE }; }
}
async function updateBotConfig(number, data) {
    try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, data, updatedAt: new Date() } }, { upsert: true }); } catch (e) {}
}

// ---------------- COMMAND HANDLERS ----------------

function setupCommandHandlers(socket, botSessionNumber) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast') return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    const senderJid = jidNormalizedUser(msg.key.fromMe ? socket.user.id : (msg.key.participant || msg.key.remoteJid));
    const botNumber = jidNormalizedUser(socket.user.id);
    const isOwner = senderJid === config.OWNER_NUMBER || msg.key.fromMe;

    // Fetch Mode Status
    const botStatus = await getBotConfig(botSessionNumber);
    if (botStatus.mode === 'self' && !isOwner) return;

    // 📊 RANK TRACKING SYSTEM (DB Auto-Save)
    if (!msg.key.fromMe && isGroup && senderJid) {
        try {
            const momentNow = moment().tz('Asia/Colombo');
            const hrK = momentNow.format('YYYY-MM-DD-HH');
            const dK = momentNow.format('YYYY-MM-DD');
            const wK = momentNow.format('YYYY-WW');
            const mK = momentNow.format('YYYY-MM');
            const userGroupKey = `${senderJid}_${from}`;

            await chatStatsCol.updateOne(
                { userGroupKey: userGroupKey },
                { 
                    $inc: { total: 1, points: 10, [`hourly.${hrK}`]: 1, [`daily.${dK}`]: 1, [`weekly.${wK}`]: 1, [`monthly.${mK}`]: 1 },
                    $set: { jid: senderJid, groupId: from, pushName: msg.pushName || "User", lastActive: new Date() }
                },
                { upsert: true }
            );
        } catch (e) {}
    }

    const type = getContentType(msg.message);
    let body = "";
    if (type === 'conversation') body = msg.message.conversation;
    else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
    else if (type === 'interactiveResponseMessage') body = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id;

    const prefix = config.PREFIX;
    if (!body || !body.startsWith(prefix)) return;

    const command = body.slice(prefix.length).trim().split(' ').shift().toLowerCase();
    const args = body.trim().split(/ +/).slice(1);
    const text = args.join(" ");

    const reply = async (teks) => await socket.sendMessage(from, { text: teks }, { quoted: msg });
    const react = async (emoji) => await socket.sendMessage(from, { react: { text: emoji, key: msg.key } });

    // Admin Check Logic
    let groupMetadata, groupMembers, groupAdmins, isBotAdmin, isUserAdmin;
    if (isGroup) {
        try {
            groupMetadata = await socket.groupMetadata(from);
            groupMembers = groupMetadata.participants;
            groupAdmins = groupMembers.filter(v => v.admin !== null).map(v => v.id);
            isBotAdmin = groupAdmins.includes(botNumber);
            isUserAdmin = groupAdmins.includes(senderJid);
        } catch (e) { isBotAdmin = false; isUserAdmin = false; }
    }

    try {
      switch (command) {
        // --- MODE COMMAND ---
        case 'mode': {
            if (!isOwner) return react("🚫");
            if (!text || (text !== 'public' && text !== 'self')) return reply(`❌ Usage: ${prefix}mode public/self`);
            await updateBotConfig(botSessionNumber, { mode: text });
            await react("⚙️");
            reply(`✅ Bot Mode changed to: *${text.toUpperCase()}*`);
            break;
        }

        // --- ALIVE COMMAND ---
        case 'alive': {
            await react("🌟");
            const uptime = process.uptime();
            const h = Math.floor(uptime / 3600);
            const m = Math.floor((uptime % 3600) / 60);
            const aliveMsg = `╭━━━〔 🌟 *RAVIYAMD ONLINE* 🌟 〕━━━┈\n┃\n┃ 🤖 *BOT:* ${config.BOT_NAME}\n┃ ⚙️ *MODE:* ${botStatus.mode.toUpperCase()}\n┃ ⏱️ *UPTIME:* ${h}h ${m}m\n┃ ⚡ *STATUS:* Stable\n┃\n╰━━━━━━━━━━━━━━━━━━━━━━━━┈\n> ${config.BOT_FOOTER}`;
            await socket.sendMessage(from, { image: { url: config.IMAGE_URL }, caption: aliveMsg }, { quoted: msg });
            break;
        }

        // --- MENU COMMAND ---
        case 'menu': {
            await react("📜");
            const menu = `╭━━━〔 🛡️ *${config.BOT_NAME}* 〕━━━◎
┃ 👋 *Hello ${msg.pushName || 'User'}!*
┃ ⚙️ *Mode:* ${botStatus.mode.toUpperCase()}
┃
┃ 🏆 *RANKING SYSTEM:*
┃ ➜ ${prefix}rank - Stats
┃ ➜ ${prefix}top - Daily
┃ ➜ ${prefix}topweekly
┃ ➜ ${prefix}topmonthly
┃ ➜ ${prefix}tophourly
┃ ➜ ${prefix}topall
┃
┃ ⚙️ *GROUP MANAGEMENT:*
┃ ➜ ${prefix}kick | ${prefix}add
┃ ➜ ${prefix}promote | ${prefix}demote
┃ ➜ ${prefix}mute | ${prefix}unmute
┃ ➜ ${prefix}tagall | ${prefix}hidetag
┃ ➜ ${prefix}link | ${prefix}revoke
┃
╰━━━━━━━━━━━━━━━━━━◎\n> ${config.BOT_FOOTER}`;
            await socket.sendMessage(from, { image: { url: config.IMAGE_URL }, caption: menu }, { quoted: msg });
            break;
        }

        // --- RANKING COMMANDS ---
        case 'rank': {
            if (!isGroup) return react("⚠️");
            await react("🎯");
            const st = await chatStatsCol.findOne({ userGroupKey: `${senderJid}_${from}` });
            if (!st) return reply("❌ No data recorded yet.");
            const now = moment().tz('Asia/Colombo');
            reply(`╭━━━〔 🎯 *RANKING* 〕━━━◎\n┃ 👤 *User:* ${st.pushName}\n┃ 🕒 *Hourly:* ${st.hourly?.[now.format('YYYY-MM-DD-HH')] || 0}\n┃ 📅 *Today:* ${st.daily?.[now.format('YYYY-MM-DD')] || 0}\n┃ 🏆 *Total:* ${st.total}\n┃ ⭐ *Points:* ${st.points || 0}\n╰━━━━━━━━━━━━━━◎`);
            break;
        }

        case 'top': {
            if (!isGroup) return react("⚠️");
            await react("🏆");
            const dK = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
            const top = await chatStatsCol.find({ groupId: from, [`daily.${dK}`]: { $gt: 0 } }).sort({ [`daily.${dK}`]: -1 }).limit(10).toArray();
            let txt = `🏆 *TOP 10 TODAY (${dK})*\n\n`;
            top.forEach((u, i) => txt += `${i+1}. ${u.pushName} - ${u.daily[dK]} msgs\n`);
            reply(txt);
            break;
        }

        case 'topweekly': {
            if (!isGroup) return;
            const wK = moment().tz('Asia/Colombo').format('YYYY-WW');
            const top = await chatStatsCol.find({ groupId: from, [`weekly.${wK}`]: { $gt: 0 } }).sort({ [`weekly.${wK}`]: -1 }).limit(10).toArray();
            let txt = `📅 *TOP 10 THIS WEEK*\n\n`;
            top.forEach((u, i) => txt += `${i+1}. ${u.pushName} - ${u.weekly[wK]} msgs\n`);
            reply(txt);
            break;
        }

        case 'tophourly': {
            if (!isGroup) return;
            const hK = moment().tz('Asia/Colombo').format('YYYY-MM-DD-HH');
            const top = await chatStatsCol.find({ groupId: from, [`hourly.${hK}`]: { $gt: 0 } }).sort({ [`hourly.${hK}`]: -1 }).limit(10).toArray();
            let txt = `🕒 *TOP 10 THIS HOUR*\n\n`;
            top.forEach((u, i) => txt += `${i+1}. ${u.pushName} - ${u.hourly[hK]} msgs\n`);
            reply(txt);
            break;
        }

        case 'topall': {
            if (!isGroup) return;
            const top = await chatStatsCol.find({ groupId: from }).sort({ total: -1 }).limit(10).toArray();
            let txt = `👑 *ALL TIME TOP 10*\n\n`;
            top.forEach((u, i) => txt += `${i+1}. ${u.pushName} - ${u.total} msgs\n`);
            reply(txt);
            break;
        }

        // --- GROUP MANAGEMENT COMMANDS ---
        case 'kick': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            const target = msg.message.extendedTextMessage?.contextInfo?.participant || msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return reply("❌ Tag a user!");
            await react("🚫");
            await socket.groupParticipantsUpdate(from, [target], "remove");
            break;
        }

        case 'add': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            if (!text) return reply("❌ Enter number!");
            await react("➕");
            const target = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            await socket.groupParticipantsUpdate(from, [target], "add");
            break;
        }

        case 'promote': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            const target = msg.message.extendedTextMessage?.contextInfo?.participant || msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return;
            await react("⬆️");
            await socket.groupParticipantsUpdate(from, [target], "promote");
            break;
        }

        case 'demote': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            const target = msg.message.extendedTextMessage?.contextInfo?.participant || msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
            if (!target) return;
            await react("⬇️");
            await socket.groupParticipantsUpdate(from, [target], "demote");
            break;
        }

        case 'mute': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            await react("🔇");
            await socket.groupSettingUpdate(from, 'announcement');
            reply("🔇 Group Muted.");
            break;
        }

        case 'unmute': {
            if (!isGroup || (!isUserAdmin && !isOwner) || !isBotAdmin) return react("⚠️");
            await react("🔊");
            await socket.groupSettingUpdate(from, 'not_announcement');
            reply("🔊 Group Unmuted.");
            break;
        }

        case 'tagall': {
            if (!isGroup || (!isUserAdmin && !isOwner)) return react("⚠️");
            await react("📢");
            let tTxt = `📢 *ATTENTION EVERYONE*\n\n${text}\n\n`;
            groupMembers.forEach(v => tTxt += `@${v.id.split('@')[0]} `);
            socket.sendMessage(from, { text: tTxt, mentions: groupMembers.map(v => v.id) });
            break;
        }

        case 'hidetag': {
            if (!isGroup || (!isUserAdmin && !isOwner)) return react("⚠️");
            await react("🫣");
            socket.sendMessage(from, { text: text || '', mentions: groupMembers.map(v => v.id) });
            break;
        }

        case 'link': {
            if (!isGroup || !isBotAdmin) return react("⚠️");
            const code = await socket.groupInviteCode(from);
            reply(`https://chat.whatsapp.com/${code}`);
            break;
        }
      }
    } catch (e) { console.error(e); }
  });
}

// ---------------- CONNECTION LOGIC ----------------

async function EmpirePair(number, res) {
  const sanitized = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
  await initMongo();
  const doc = await loadCredsFromMongo(sanitized);
  if (doc) { fs.ensureDirSync(sessionPath); fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(doc.creds)); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const socket = makeWASocket({ 
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({level:'fatal'})) }, 
    printQRInTerminal: false,
    browser: ["RAVIYAMD", "Chrome", "1.0.0"]
  });

  setupCommandHandlers(socket, sanitized);

  if (!socket.authState.creds.registered) {
    await delay(2000);
    const code = await socket.requestPairingCode(sanitized);
    if (!res.headersSent) res.send({ code });
  }

  socket.ev.on('creds.update', async () => { 
    await saveCreds(); 
    const c = JSON.parse(fs.readFileSync(path.join(sessionPath, 'creds.json'))); 
    await saveCredsToMongo(sanitized, c, state.keys); 
  });

  socket.ev.on('connection.update', async (s) => {
    if (s.connection === 'open') {
        await addNumberToMongo(sanitized);
        const welcome = `╭━━━〔 🛡️ *RAVIYAMD* 〕━━━◎\n┃ ✅ Connected Successfully!\n┃ 🤖 Bot: RAVIYAMD\n┃ ⚙️ Mode: PUBLIC\n╰━━━━━━━━━━━━━━━━━━◎\n> ${config.BOT_FOOTER}`;
        await socket.sendMessage(sanitized + '@s.whatsapp.net', { image: { url: config.IMAGE_URL }, caption: welcome });
    }
    if (s.connection === 'close') {
        if (s.lastDisconnect?.error?.output?.statusCode !== 401) EmpirePair(sanitized, { headersSent:true, send:()=>{} });
    }
  });
}

router.get('/', async (req, res) => { if (req.query.number) await EmpirePair(req.query.number, res); });
module.exports = router;