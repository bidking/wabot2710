// index.js (Versi Final: Paksa Unduh View Once dengan Quote)

require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  proto
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAIFetchError, GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const sharp = require('sharp');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Gunakan ffmpeg dari sistem (Termux) bukan dari package
const ffmpeg = 'ffmpeg';

// --- Konstanta untuk Pengingat Percakapan ---
const conversationMemory = new Map();
// ==============================

// ðŸ§  Cek API Key
if (!process.env.GEMINI_API_KEY) {
  console.error("âŒ Error: GEMINI_API_KEY tidak ditemukan di file .env");
  process.exit(1);
}

// ðŸš€ Inisialisasi Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SYSTEM_INSTRUCTION = `
Kamu adalah asisten AI bernama "Astro AI".
Kamu BUKAN Gemini. Identitasmu:
- Nama: Astro AI
- Owner: "Esta" (alias "Alga")
- Instagram: @astrolynx._

Jawab semua pertanyaan tentang siapa kamu menggunakan identitas ini.
`;
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: SYSTEM_INSTRUCTION
});

// === FUNGSI PENGINGAT PERCAKAPAN ===
function getMemoryKey(jid) {
  return jid;
}

function getMemory(jid) {
  return conversationMemory.get(getMemoryKey(jid)) || [];
}

function setMemory(jid, memory) {
  conversationMemory.set(getMemoryKey(jid), memory);
}

function addMessageToMemory(jid, role, content) {
  const memory = getMemory(jid);
  memory.push({ role, content });
  if (memory.length > 20) {
    memory.shift();
  }
  setMemory(jid, memory);
}
// ==============================

// === FUNGSI GENERATE STIKER ===
async function createSticker(mediaBuffer, isVideo = false) {
  let tempInputPath = path.join(process.cwd(), `temp_${Date.now()}.${isVideo ? 'mp4' : 'jpg'}`);
  let outputPath = path.join(process.cwd(), `temp_${Date.now()}.webp`);

  try {
    await fs.writeFile(tempInputPath, mediaBuffer);

    if (isVideo) {
      await execPromise(`${ffmpeg} -i ${tempInputPath} -vf "fps=15,scale=512:512:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -y ${outputPath}`);
    } else {
      await sharp(mediaBuffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 80 })
        .toFile(outputPath);
    }

    const stickerBuffer = await fs.readFile(outputPath);
    return stickerBuffer;
  } catch (error) {
    console.error("Gagal membuat stiker:", error);
    throw error;
  } finally {
    try {
      await fs.unlink(tempInputPath);
      await fs.unlink(outputPath);
    } catch (e) {
      // Abaikan error jika file tidak ditemukan
    }
  }
}
// ==============================

async function connectToWhatsApp() {
  const authFolder = path.join(process.cwd(), 'auth_info_baileys');
  try {
    await fs.mkdir(authFolder, { recursive: true });
  } catch (e) {
    console.error('âŒ Gagal membuat folder:', e);
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ["Astro-AI-Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('âŒ Logout! Hapus folder auth_info_baileys lalu scan ulang QR.');
        process.exit(1);
      } else {
        console.log(`âš ï¸ Koneksi terputus (${code}), menyambung ulang...`);
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') console.log('âœ… Bot Astro AI berhasil tersambung!');
  });

  // === EVENT UNTUK MENANGANI PEMBARUAN PESAN (VIEW ONCE) ===
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (update.message && !key.fromMe) {
        const viewOnceTypes = ['viewOnceMessageV2', 'viewOnceMessageV2Extension'];
        let viewOncePayload = null;
        for (const type of viewOnceTypes) {
          if (update.message[type]) {
            viewOncePayload = update.message[type];
            break;
          }
        }

        if (viewOncePayload?.message) {
          const fullMsg = {
            key: key,
            message: update.message,
            pushName: "Pengguna",
            messageTimestamp: Date.now()
          };
          await handleViewOnceMessage(sock, fullMsg);
        }
      }
    }
  });

  // --- FUNGSI UNTUK MENGAMBIL METADATA GRUP DENGAN AMAN ---
  async function safeGroupMetadata(sock, jid) {
    try {
      return await sock.groupMetadata(jid);
    } catch (e) {
      console.error(`âŒ Gagal mengambil metadata grup untuk ${jid}:`, e);
      return null;
    }
  }

  // --- FUNGSI UNTUK MENANGANI PESAN VIEW ONCE ---
  async function handleViewOnceMessage(sock, msg) {
    const senderJid = msg.key.remoteJid;
    const senderName = msg.pushName || "Pengguna";
    const messageId = msg.key.id;

    if (global.viewOnceCache && global.viewOnceCache.has(messageId)) {
      return;
    }

    console.log(`\n---------------------------------`);
    console.log(`ðŸ“¸ [KONTEN 1x LIHAT DITEMUKAN & DIPROSES]`);
    console.log(`  > Dari: ${senderName} (${senderJid})`);
    console.log(`  > ID Pesan: ${messageId}`);

    if (!global.viewOnceCache) {
      global.viewOnceCache = new Map();
    }
    global.viewOnceCache.set(messageId, {
      senderJid: senderJid,
      msg: msg
    });

    console.log(`  >  Pesan 1x lihat (ID: ${messageId}) berhasil diarsipkan di memori sementara.`);
    await sock.sendMessage(senderJid, {
      text: `… Foto/Video sekali lihat berhasil saya simpan.\n\nBalas pesan ini dengan .rvo untuk melihatnya lagi.`
    });
    console.log(`---------------------------------`);
  }

  // === EVENT UNTUK MENANGANI PESAN BARU ===
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg?.message) return;

    const senderJid = msg.key.remoteJid;
    const senderName = msg.pushName || "Pengguna";
    const isFromMe = msg.key.fromMe;

    // --- LOGIKA UNTUK MENANGANI PESAN KOSONG YANG MERUPAKAN VIEW ONCE ---
    // Ini adalah solusi untuk kasus di mana pesan view once datang sebagai pesan kosong
    if (
      !msg.message.conversation &&
      !msg.message.extendedTextMessage &&
      !msg.message.imageMessage &&
      !msg.message.videoMessage &&
      msg.key.id // Pastikan ada ID pesan
    ) {
      console.log(`\n[DEBUG] Menerima pesan kosong dengan ID: ${msg.key.id} dari ${senderJid}. Mungkin ini view once bermasalah. Mencoba memaksa konten dengan quote...`);
      
      try {
        // Paksa bot untuk me-reply pesan kosong ini untuk memancing konten
        await sock.sendMessage(senderJid, {
          text: "â³ Mendeteksi media sekali liat, mohon tunggu...",
          quoted: msg
        });

        // Tunggu sebentar agar server WhatsApp punya waktu untuk merespons
        await new Promise(resolve => setTimeout(resolve, 1500)); 

        // Coba lagi untuk memproses pesan yang sama setelah di-quote
        // Kita tidak perlu melakukan apa-apa di sini, karena jika berhasil,
        // event 'messages.update' akan terpicu dan menangani sisanya.
        // Pesan "â³ Mendeteksi..." akan tertimpa oleh notifikasi sukses dari handleViewOnceMessage.
        console.log(`[DEBUG] Pesan telah di-quote. Menunggu event 'update'...`);
      } catch (error) {
        console.error("[DEBUG] Gagal meng-quote pesan kosong:", error);
      }
      // Jangan return di sini, biarkan flow berlanjut
    }

    // --- CEK VIEW ONCE YANG LENGKAP DI EVENT UPSERT ---
    const viewOnceTypes = ['viewOnceMessageV2', 'viewOnceMessageV2Extension'];
    let viewOncePayload = null;
    for (const type of viewOnceTypes) {
      if (msg.message[type]) {
        viewOncePayload = msg.message[type];
        break;
      }
    }

    if (viewOncePayload?.message) {
      await handleViewOnceMessage(sock, msg);
      return;
    }

    // --- SIMPAN PESAN TEKS KE MEMORY ---
    if (!isFromMe) {
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if(messageText) {
            addMessageToMemory(senderJid, 'user', messageText);
        }
    }

    // --- PROSES PERINTAH ---
    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!messageText) return;

    console.log(`\n---------------------------------`);
    console.log(`[PESAN MASUK]`);
    console.log(`  > Dari: ${senderName} (${senderJid})`);
    console.log(`  > Pesan: "${messageText}"`);
    console.log(`---------------------------------`);

    const command = messageText.toLowerCase().trim();

    // === .rvo untuk buka ulang view once atau media biasa ===
    if (command.toLowerCase().startsWith('.rvo')) {
      const quotedMsgInfo = msg.message.extendedTextMessage?.contextInfo;
      if (!quotedMsgInfo || !quotedMsgInfo.quotedMessage) {
          await sock.sendMessage(senderJid, { text: "❌ Silahkan reply media View Once Kak!" }, { quoted: msg });
          return;
      }
  
      try {
          const messageToDownload = {
              key: {
                  remoteJid: senderJid,
                  id: quotedMsgInfo.stanzaId,
                  participant: quotedMsgInfo.participant
              },
              message: quotedMsgInfo.quotedMessage
          };
          
          const buffer = await downloadMediaMessage(messageToDownload, 'buffer', {});
  
          let typeMessage = quotedMsgInfo.quotedMessage;
          // Handle view once messages, they have an inner message
          if (typeMessage.viewOnceMessageV2) {
              typeMessage = typeMessage.viewOnceMessageV2.message;
          } else if (typeMessage.viewOnceMessageV2Extension) {
              typeMessage = typeMessage.viewOnceMessageV2Extension.message;
          } else if (typeMessage.viewOnceMessage) {
              typeMessage = typeMessage.viewOnceMessage.message;
          }
  
          const type = Object.keys(typeMessage)[0];
          const sendOptions = { quoted: msg };
          const caption = "✅ Berhasil!";
  
          if (type === "videoMessage") {
              await sock.sendMessage(senderJid, { video: buffer, caption }, sendOptions);
          } else if (type === "imageMessage") {
              await sock.sendMessage(senderJid, { image: buffer, caption }, sendOptions);
          } else if (type === "audioMessage") {
              await sock.sendMessage(senderJid, {
                  audio: buffer,
                  mimetype: "audio/mpeg",
                  ptt: false
              }, sendOptions);
          } else {
              await sock.sendMessage(senderJid, { text: "❌ Yahh, media View Once yang Kakak reply tidak didukung." }, { quoted: msg });
          }
      } catch (err) {
          console.error(err);
          await sock.sendMessage(senderJid, { text: "❌ Terjadi kesalahan saat membuka media Kak." }, { quoted: msg });
      }
      return;
    }

    // === /str untuk generate stiker ===
    if (command === '/str') {
      let mediaToConvert = null;
      let isVideo = false;

      const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMsg) {
        if (quotedMsg.imageMessage) {
          mediaToConvert = quotedMsg.imageMessage;
        } else if (quotedMsg.videoMessage) {
          mediaToConvert = quotedMsg.videoMessage;
          isVideo = true;
        }
      } else {
        if (msg.message.imageMessage) {
          mediaToConvert = msg.message.imageMessage;
        } else if (msg.message.videoMessage) {
          mediaToConvert = msg.message.videoMessage;
          isVideo = true;
        }
      }

      if (!mediaToConvert) {
        await sock.sendMessage(senderJid, { text: "âŒ Kirim atau reply sebuah gambar/video (maks 5 detik) dengan caption /str." });
        return;
      }

      if (isVideo && mediaToConvert.seconds > 5) {
        await sock.sendMessage(senderJid, { text: "âŒ Durasi video maksimal adalah 5 detik." });
        return;
      }

      try {
        await sock.sendMessage(senderJid, { react: { text: "â³", key: msg.key } });
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        const stickerBuffer = await createSticker(buffer, isVideo);
        await sock.sendMessage(senderJid, { sticker: stickerBuffer }, { quoted: msg });
        console.log(`Stiker berhasil dikirim ke ${senderJid}`);
      } catch (error) {
        console.error("Gagal membuat stiker:", error);
        await sock.sendMessage(senderJid, { text: "âš ï¸ Gagal membuat stiker. Pastikan media valid." });
      } finally {
        await sock.sendMessage(senderJid, { react: { text: "", key: msg.key } });
      }
      return;
    }

    // === /ingat, /apa, /lupa untuk pengingat percakapan ===
    if (command.startsWith('/ingat')) {
        const factToRemember = messageText.slice(7).trim();
        if (!factToRemember) {
            await sock.sendMessage(senderJid, { text: "âš™ï¸ Gunakan format: /ingat <informasi yang ingin diingat>" });
            return;
        }
        addMessageToMemory(senderJid, 'system', factToRemember);
        await sock.sendMessage(senderJid, { text: "âœ… Baik, saya akan ingat itu." });
        return;
    }

    if (command === '/apa') {
        const memory = getMemory(senderJid);
        if (memory.length === 0) {
            await sock.sendMessage(senderJid, { text: "Saya tidak ingat apa-apa tentang obrolan ini." });
            return;
        }
        const memoryText = memory.map(m => `- ${m.role === 'system' ? 'INFO' : m.role.toUpperCase()}: ${m.content}`).join('\n');
        await sock.sendMessage(senderJid, { text: `Ini yang saya ingat dari obrolan kita:\n\n${memoryText}` });
        return;
    }

    if (command === '/lupa') {
        setMemory(senderJid, []);
        await sock.sendMessage(senderJid, { text: "ðŸ—‘ï¸ Oke, saya sudah lupa semua yang kita bicarakan." });
        return;
    }

    // === Fitur @all (dengan teks tambahan) ===
    if (messageText.toLowerCase().includes('@all')) {
        const from = msg.key.remoteJid || msg.key.participant || '';
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: ' Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
            return;
        }

        // Ambil teks setelah @all
        const extraText = messageText.replace(/^@all\s*/i, '').trim() || '';
        const finalMessage = extraText
            ? `@all ${extraText}`
            : '@all';

        // Sistem cooldown per grup
        if (!global.allCooldown) global.allCooldown = new Map();
        const now = Date.now();
        const lastUsed = global.allCooldown.get(from);
        if (lastUsed && now - lastUsed < 10000) { // cooldown 10 detik
            // console.log(`â³ [@all] Diblokir sementara di ${from}`); // Reduced logging
            return;
        }
        global.allCooldown.set(from, now);

        try {
            // Fungsi ambil metadata grup aman
            const groupMetadata = await safeGroupMetadata(sock, from);
            if (!groupMetadata) {
                await sock.sendMessage(from, { text: 'âš ï¸ Gagal mengambil data anggota grup. Coba lagi nanti.' }, { quoted: msg });
                return;
            }

            const participants = groupMetadata.participants.map(p => p.id);
            // console.log(`ðŸ‘¥ Ditemukan ${participants.length} anggota di grup "${groupMetadata.subject}"`); // Reduced logging

            await sock.sendMessage(from, {
                text: finalMessage,
                mentions: participants,
                contextInfo: { mentionedJid: participants }
            });

            console.log(`âœ… [@all] Selesai menandai ${participants.length} anggota di "${groupMetadata.subject}" dengan hidetag.`);
        } catch (err) {
            console.error(' [@all] Error:', err);
            await sock.sendMessage(from, { text: 'âš ï¸ Terjadi kesalahan saat menandai anggota. Coba lagi nanti.' }, { quoted: msg });
        }

        return;
    }

    // === /ai untuk interaksi dengan Gemini ===
    if (command.startsWith('/ai')) {
      const prompt = messageText.replace(/^\/ai\s*/i, '').trim();
      if (!prompt) {
        await sock.sendMessage(senderJid, { text: ' Gunakan format: /ai <pertanyaan kamu>' });
        return;
      }

      const memory = getMemory(senderJid);
      const history = memory.map(m => ({ role: m.role, parts: [{ text: m.content }] }));

      console.log(`â³ [PROSES AI] "${prompt}" dengan ${history.length} konteks memori.`);
      try {
        await sock.sendMessage(senderJid, { react: { text: "â°", key: msg.key } });
        await sock.sendPresenceUpdate('composing', senderJid);
        
        const chat = model.startChat({ history });
        const result = await chat.sendMessage(prompt);
        const aiReply = result.response.text() || "Maaf, Astro tidak dirancang untuk menjawab itu.";
        
        await sock.sendMessage(senderJid, { text: aiReply }, { quoted: msg });
        
        addMessageToMemory(senderJid, 'user', prompt);
        addMessageToMemory(senderJid, 'model', aiReply);

        console.log(`ðŸ“¤ [BALASAN AI TERKIRIM]`);
      } catch (error) {
        let errMsg = 'âš ï¸ Maaf, terjadi kesalahan internal.';
        if (error instanceof GoogleGenerativeAIFetchError) {
          errMsg = `âš ï¸ Gagal menghubungi model: ${error.message}`;
        }
        console.error(error);
        await sock.sendMessage(senderJid, { text: errMsg }, { quoted: msg });
      } finally {
        try {
          await sock.sendMessage(senderJid, { react: { text: "", key: msg.key } });
        } catch {}
      }
    }
  });

  return sock;
}

connectToWhatsApp().catch(e => console.error("âŒ Gagal terhubung ke WhatsApp:", e));