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
  DisconnectReason
} = require('baileys');

// ---------------- CONFIG ----------------

const config = {
  PREFIX: '.',
  MAX_RETRIES: 3,
  NEWSLETTER_JID: '120363419758690313@newsletter',
  BOT_NAME: 'RAVIYA MD',
  BOT_FOOTER: 'RANKING MINI BOT',
  IMAGE_URL: 'https://i.ibb.co/4wGBd0Z7/Rashmika-Ofc.jpg'
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
  chatStatsCol = mongoDB.collection('chat_stats');

  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  await chatStatsCol.createIndex({ jid: 1 }, { unique: true });
  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo helpers ----------------

async function saveCredsToMongo(number, creds, keys = null) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = { number: sanitized, creds, keys, updatedAt: new Date() };
    await sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
  } catch (e) {}
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await sessionsCol.findOne({ number: sanitized });
    return doc || null;
  } catch (e) { return null; }
}

async function removeSessionFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.deleteOne({ number: sanitized });
  } catch (e) {}
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
  } catch (e) {}
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
  } catch (e) {}
}

async function getAllNumbersFromMongo() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { return []; }
}

function getSriLankaTimestamp(){ return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss'); }

const activeSockets = new Map();
const socketCreationTime = new Map();

// ---------------- command handlers (Ranking + Names + Essential Commands) ----------------

function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

    const from = msg.key.remoteJid;
    const sender = from;
    const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = (nowsender || '').split('@')[0];
    const isGroup = from.endsWith('@g.us');

    // ==========================================
    // 📊 CHAT RANKING SYSTEM: MESSAGE TRACKER
    // ==========================================
    if (!msg.key.fromMe && nowsender && !nowsender.includes('newsletter')) {
        try {
            const momentNow = moment().tz('Asia/Colombo');
            const hrKey = momentNow.format('YYYY-MM-DD-HH');
            const dKey = momentNow.format('YYYY-MM-DD');
            const wKey = momentNow.format('YYYY-WW');
            const mKey = momentNow.format('YYYY-MM');
            
            const pushName = msg.pushName || "Unknown User";

            const updateDoc = {
                $inc: {
                    total: 1,
                    [`hourly.${hrKey}`]: 1,
                    [`daily.${dKey}`]: 1,
                    [`weekly.${wKey}`]: 1,
                    [`monthly.${mKey}`]: 1
                },
                $set: { pushName: pushName, lastActive: new Date() }
            };
            
            if (chatStatsCol) {
                await chatStatsCol.updateOne({ jid: nowsender }, updateDoc, { upsert: true });
            }
        } catch (e) {
            console.error('Chat Stat tracking error:', e);
        }
    }
    // ==========================================

    const body = (type === 'conversation') ? msg.message.conversation
      : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
      : (type === 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage?.selectedButtonId
      : (type === 'listResponseMessage') ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
      : (type === 'templateButtonReplyMessage') ? msg.message.templateButtonReplyMessage?.selectedId
      : (type === 'interactiveResponseMessage') ? JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id
      : '';

    if (!body || typeof body !== 'string') return;

    const prefix = config.PREFIX;
    const isCmd = body && body.startsWith && body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    if (!command) return;

    try {
      const botName = config.BOT_NAME;
      const botFooter = config.BOT_FOOTER;

      switch (command) {
        
        // ==================== ALIVE ====================
        case 'alive': {
            await socket.sendMessage(sender, { react: { text: "👾", key: msg.key } });
            const { performance } = require('perf_hooks');
            
            const start = performance.now();
            const end = performance.now();
            const ping = (end - start).toFixed(2);
            
            const aliveMsg = `╭━━━〔 *👾 SYSTEM ONLINE* 〕━━━┈\n┃\n┃ 🤖 *Bot Name:* ${botName}\n┃ ⚡ *Ping:* ${ping} ms\n┃\n╰━━━━━━━━━━━━━━━━━━┈\n> ${botFooter}`;
            
            await socket.sendMessage(sender, {
                image: { url: config.IMAGE_URL },
                caption: aliveMsg
            }, { quoted: msg });
            break;
        }

        // ==================== PING ====================
        case 'ping': {
            await socket.sendMessage(sender, { react: { text: "⚡", key: msg.key } });
            const { performance } = require('perf_hooks');
            const start = performance.now();
            const end = performance.now();
            const ping = (end - start).toFixed(2);
            await socket.sendMessage(sender, { text: `🚀 *Pong!*\n*Speed:* ${ping}ms\n\n> ${botFooter}` }, { quoted: msg });
            break;
        }

        // ==================== MENU ====================
        case 'menu':
        case 'panel':
        case 'help': {
            await socket.sendMessage(sender, { react: { text: "🤖", key: msg.key } });

            const menuText = `╭━━━〔 🎀 *${botName}* 〕━━━◎
┃
┃ 👋 *Welcome!*
┃ 👤 *User:* ${msg.pushName || 'User'}
┃
┃ 🏆 *RANKING COMMANDS:*
┃ ➜ .rank - Show your chat rank
┃ ➜ .top - View leaderboards
┃ ➜ .alive - Check bot status
┃ ➜ .ping - Check bot speed
┃
╰━━━━━━━━━━━━━━━━━━◎`;

            const msgParams = {
                viewOnceMessage: {
                    message: {
                        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                        interactiveMessage: {
                            body: { text: menuText },
                            footer: { text: `> ${botFooter}` },
                            header: { 
                                title: "", 
                                subtitle: "", 
                                hasMediaAttachment: true,
                                imageMessage: await (await makeWASocket({}).sendMessage(sender, { image: { url: config.IMAGE_URL } }, { generateHighQualityLinkPreview: true })).message.imageMessage 
                            },
                            nativeFlowMessage: {
                                buttons: [
                                    {
                                        name: "single_select",
                                        buttonParamsJson: JSON.stringify({
                                            title: "🏆 LEADERBOARDS",
                                            sections: [
                                                {
                                                    title: "📊 Ranking Categories",
                                                    rows: [
                                                        { header: "Hourly Rank", title: "Top Hourly", id: `${prefix}top hourly` },
                                                        { header: "Daily Rank", title: "Top Daily", id: `${prefix}top daily` },
                                                        { header: "Weekly Rank", title: "Top Weekly", id: `${prefix}top weekly` },
                                                        { header: "Monthly Rank", title: "Top Monthly", id: `${prefix}top monthly` },
                                                        { header: "All-Time Rank", title: "Top All-Time", id: `${prefix}top all` }
                                                    ]
                                                }
                                            ]
                                        })
                                    },
                                    {
                                        name: "quick_reply",
                                        buttonParamsJson: JSON.stringify({ display_text: "🎯 MY RANK", id: `${prefix}rank` })
                                    }
                                ]
                            }
                        }
                    }
                }
            };
            
            // Send standard text with image if native flow message fails
            try {
                await socket.relayMessage(sender, msgParams, { quoted: msg });
            } catch (err) {
                await socket.sendMessage(sender, { image: { url: config.IMAGE_URL }, caption: menuText + `\n\n> ${botFooter}` }, { quoted: msg });
            }
            break;
        }

        // ==================== MY RANK ====================
        case 'rank':
        case 'myrank': {
            await socket.sendMessage(sender, { react: { text: "🎯", key: msg.key } });
            
            const momentNow = moment().tz('Asia/Colombo');
            const hrKey = momentNow.format('YYYY-MM-DD-HH');
            const dKey = momentNow.format('YYYY-MM-DD');
            const wKey = momentNow.format('YYYY-WW');
            const mKey = momentNow.format('YYYY-MM');

            if (!chatStatsCol) return;
            const userStats = await chatStatsCol.findOne({ jid: nowsender });

            if (!userStats) {
                return await socket.sendMessage(sender, { text: "❌ *No messages recorded for you yet! Start chatting!*\n\n> " + botFooter }, { quoted: msg });
            }

            const msgsHourly = userStats.hourly?.[hrKey] || 0;
            const msgsDaily = userStats.daily?.[dKey] || 0;
            const msgsWeekly = userStats.weekly?.[wKey] || 0;
            const msgsMonthly = userStats.monthly?.[mKey] || 0;
            const msgsTotal = userStats.total || 0;

            const txt = `╭━━━〔 🎯 *YOUR RANKING* 〕━━━◎
┃
┃ 👤 *Name:* ${userStats.pushName || msg.pushName || 'Unknown'}
┃ 📱 *Number:* @${nowsender.split('@')[0]}
┃
┃ 🕒 *Hourly:* ${msgsHourly} msgs
┃ 📅 *Daily:* ${msgsDaily} msgs
┃ 🗓️ *Weekly:* ${msgsWeekly} msgs
┃ 🈷️ *Monthly:* ${msgsMonthly} msgs
┃ 🏆 *All-Time:* ${msgsTotal} msgs
┃
╰━━━━━━━━━━━━━━━━━━◎
> ${botFooter}`;

            await socket.sendMessage(sender, { text: txt, mentions: [nowsender] }, { quoted: msg });
            break;
        }

        // ==================== LEADERBOARD ====================
        case 'top':
        case 'leaderboard': {
            await socket.sendMessage(sender, { react: { text: "🏆", key: msg.key } });
            
            const period = args[0] || 'all'; 
            const momentNow = moment().tz('Asia/Colombo');
            let sortField = 'total';
            let title = 'ALL-TIME';

            if (period === 'daily') { sortField = `daily.${momentNow.format('YYYY-MM-DD')}`; title = 'DAILY'; }
            else if (period === 'weekly') { sortField = `weekly.${momentNow.format('YYYY-WW')}`; title = 'WEEKLY'; }
            else if (period === 'monthly') { sortField = `monthly.${momentNow.format('YYYY-MM')}`; title = 'MONTHLY'; }
            else if (period === 'hourly') { sortField = `hourly.${momentNow.format('YYYY-MM-DD-HH')}`; title = 'HOURLY'; }

            if (!chatStatsCol) return;
            const topUsers = await chatStatsCol.find({ [sortField]: { $exists: true, $gt: 0 } }).sort({ [sortField]: -1 }).limit(10).toArray();

            if (!topUsers || topUsers.length === 0) {
                return await socket.sendMessage(sender, { text: `❌ *No messages recorded for the ${title} leaderboard yet!*\n\n> ` + botFooter }, { quoted: msg });
            }

            let txt = `╭━━━〔 🏆 *${title} LEADERBOARD* 〕━━━◎\n┃\n`;
            const mentions = [];

            topUsers.forEach((u, idx) => {
                let actualCount = 0;
                if (sortField === 'total') actualCount = u.total;
                else { actualCount = u[sortField.split('.')[0]]?.[sortField.split('.')[1]] || 0; }

                const displayName = u.pushName || "Unknown User";
                txt += `┃ *${idx + 1}.* ${displayName} (@${u.jid.split('@')[0]}) - ${actualCount} msgs\n`;
                mentions.push(u.jid);
            });

            txt += `┃\n╰━━━━━━━━━━━━━━━━━━◎\n> ${botFooter}`;

            await socket.sendMessage(sender, { text: txt, mentions: mentions }, { quoted: msg });
            break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
    }
  });
}

// ---------------- EmpirePair (pairing, temp dir, persist to Mongo) ----------------

async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  
  try {
    const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
    }
  } catch (e) { }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'fatal' });

  try {
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    socketCreationTime.set(sanitizedNumber, Date.now());
    setupCommandHandlers(socket, sanitizedNumber);

    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      while (retries > 0) {
        try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; }
        catch (error) { retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
      }
      if (!res.headersSent) res.send({ code });
    }

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const credsPath = path.join(sessionPath, 'creds.json');
        if (!fs.existsSync(credsPath)) return;
        const fileContent = await fs.readFile(credsPath, 'utf8');
        let credsObj = JSON.parse(fileContent);
        const keysObj = state.keys || null;
        await saveCredsToMongo(sanitizedNumber, credsObj, keysObj);
      } catch (err) { }
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'open') {
        try {
          await delay(3000);
          activeSockets.set(sanitizedNumber, socket);
          await addNumberToMongo(sanitizedNumber);
          console.log(`✅ Session connected: ${sanitizedNumber}`);

          // ==========================================
          // 📱 CONNECTION SUCCESS MESSAGE
          // ==========================================
          const connectMsg = `╭━━━〔 🎀 *${config.BOT_NAME}* 〕━━━◎
┃
┃ ✅ *Successfully Connected!*
┃ 🤖 *Bot Name:* ${config.BOT_NAME}
┃ 📱 *Number:* +${sanitizedNumber}
┃
┃ ➜ Type *.menu* to get started.
┃
╰━━━━━━━━━━━━━━━━━━◎
> ${config.BOT_FOOTER}`;

          await socket.sendMessage(sanitizedNumber + '@s.whatsapp.net', {
              image: { url: config.IMAGE_URL },
              caption: connectMsg
          });
          // ==========================================

        } catch (e) { console.error('Error sending connect message:', e); }
      }
      if (connection === 'close') {
        const isLoggedOut = (lastDisconnect?.error?.output?.statusCode === 401) || (lastDisconnect?.reason === DisconnectReason?.loggedOut);
        if (isLoggedOut) {
          console.log(`User ${sanitizedNumber} logged out. Cleaning up...`);
          try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
          activeSockets.delete(sanitizedNumber);
          socketCreationTime.delete(sanitizedNumber);
          try { await removeSessionFromMongo(sanitizedNumber); await removeNumberFromMongo(sanitizedNumber); } catch(e){}
        } else {
          console.log(`Connection closed for ${sanitizedNumber}. Reconnecting...`);
          try { 
              await delay(10000); 
              activeSockets.delete(sanitizedNumber); 
              socketCreationTime.delete(sanitizedNumber); 
              const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; 
              await EmpirePair(sanitizedNumber, mockRes); 
          } catch(e){}
        }
      }
    });

    activeSockets.set(sanitizedNumber, socket);

  } catch (error) {
    socketCreationTime.delete(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
}

// ---------------- endpoints ----------------

router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({ botName: config.BOT_NAME, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getSriLankaTimestamp() });
});

router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: config.BOT_NAME, activesession: activeSockets.size });
});

router.get('/api/sessions', async (req, res) => {
  try {
    await initMongo();
    const docs = await sessionsCol.find({}, { projection: { number: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ ok: true, sessions: docs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

router.post('/api/session/delete', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const running = activeSockets.get(sanitized);
    if (running) {
      try { if (typeof running.logout === 'function') await running.logout().catch(()=>{}); } catch(e){}
      try { running.ws?.close(); } catch(e){}
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
    }
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);
    try { const sessTmp = path.join(os.tmpdir(), `session_${sanitized}`); if (fs.existsSync(sessTmp)) fs.removeSync(sessTmp); } catch(e){}
    res.json({ ok: true, message: `Session ${sanitized} removed` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});

process.on('exit', () => {
  activeSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
    try { fs.removeSync(path.join(os.tmpdir(), `session_${number}`)); } catch(e){}
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

initMongo().catch(err => console.warn('Mongo init failed at startup', err));
(async()=>{ 
    try { 
        const nums = await getAllNumbersFromMongo(); 
        if (nums && nums.length) { 
            for (const n of nums) { 
                if (!activeSockets.has(n)) { 
                    const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; 
                    await EmpirePair(n, mockRes); 
                    await delay(500); 
                } 
            } 
        } 
    } catch(e){} 
})();

module.exports = router;