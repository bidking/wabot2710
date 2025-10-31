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
async function createSticker(mediaBuffer, isVideo = false, pack = 'esta/alga', author = 'esta/alga') {
    const tempInputPath = path.join(process.cwd(), `temp_input_${Date.now()}.${isVideo ? 'mp4' : 'png'}`);
    const tempOutputPath = path.join(process.cwd(), `temp_output_${Date.now()}.webp`);
    const exifPath = path.join(process.cwd(), `temp_exif_${Date.now()}.exif`);

    try {
        await fs.writeFile(tempInputPath, mediaBuffer);

        if (isVideo) {
            await execPromise(
                `${ffmpeg} -i ${tempInputPath} -y -vcodec libwebp -filter:v fps=fps=15,scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white@0 -lossless 1 -loop 0 -preset default -an -vsync 0 ${tempOutputPath}`
            );
        } else {
            await sharp(tempInputPath)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .toFile(tempOutputPath);
        }

        const exifData = {
            'sticker-pack-id': `com.wabot.gemini.${Date.now()}`,
            'sticker-pack-name': pack,
            'sticker-pack-publisher': author,
        };

        const exifJson = JSON.stringify(exifData);
        const exifHeader = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
        const exifPayload = Buffer.from(exifJson, 'utf-8');
        const exifBuffer = Buffer.concat([exifHeader, exifPayload]);
        exifBuffer.writeUIntLE(exifPayload.length, 14, 4);
        await fs.writeFile(exifPath, exifBuffer);

        await execPromise(`webpmux -set exif ${exifPath} ${tempOutputPath} -o ${tempOutputPath}`);

        const stickerBuffer = await fs.readFile(tempOutputPath);
        return stickerBuffer;
    } catch (error) {
        console.error("Gagal membuat stiker:", error);
        throw error;
    } finally {
        try {
            await fs.unlink(tempInputPath);
            await fs.unlink(tempOutputPath);
            await fs.unlink(exifPath);
        } catch (e) {
            // Abaikan error
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

  const v2msg = msg.message.viewOnceMessageV2 || msg.message.viewOnceMessageV2Extension;
  const innerMsg = v2msg?.message || {};
  const captionText =
    innerMsg.imageMessage?.caption ||
    innerMsg.videoMessage?.caption ||
    "";

  // --- CEK JIKA VIEW ONCE BERISI /str ---
  if (captionText.toLowerCase().startsWith('/str')) {
    console.log(`ðŸŽ¨ View Once dengan caption /str terdeteksi dari ${senderName}, langsung generate stiker.`);
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {});
      const isVideo = !!innerMsg.videoMessage;

      const stickerBuffer = await createSticker(buffer, isVideo, 'esta/alga', 'esta/alga');
      await sock.sendMessage(senderJid, { sticker: stickerBuffer }, { quoted: msg });

      console.log(`âœ… Berhasil membuat stiker dari media sekali lihat dengan caption /str.`);
    } catch (err) {
      console.error("Gagal membuat stiker dari view once:", err);
      await sock.sendMessage(senderJid, { text: "âš ï¸ Gagal membuat stiker dari media sekali lihat." });
    }
    return; // langsung selesai, jangan disimpan ke cache
  }

  // --- PROSES NORMAL VIEW ONCE TANPA /str ---
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

  await sock.sendMessage(senderJid, {
    text: `âœ… Foto/Video sekali lihat berhasil saya simpan.\n\nBalas pesan ini dengan /op untuk melihatnya lagi.`
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
    // --- Tangkap juga caption dari media ---
    let messageText =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    if (!messageText.trim()) return;

    console.log(`\n---------------------------------`);
    console.log(`ðŸ’¬ [PESAN MASUK]`);
    console.log(`  > Dari: ${senderName} (${senderJid})`);
    console.log(`  > Pesan: "${messageText}"`);
    console.log(`---------------------------------`);

    const command = messageText.toLowerCase().trim();

    // === /op untuk buka ulang view once atau "mencuri" media biasa ===
    if (command === '/op') {
      const quotedMsgId = msg.message.extendedTextMessage?.contextInfo?.stanzaId;
      
      if (!quotedMsgId) {
        await sock.sendMessage(senderJid, { text: "âŒ Reply sebuah pesan yang berisi gambar/video, atau reply notifikasi dari bot, lalu ketik /op." });
        return;
      }

      if (global.viewOnceCache && global.viewOnceCache.has(quotedMsgId)) {
        const cachedData = global.viewOnceCache.get(quotedMsgId);
        if (cachedData.senderJid !== senderJid) {
          await sock.sendMessage(senderJid, { text: "âš ï¸ Anda tidak berhak membuka media ini." });
          return;
        }
        
        try {
          const fullMsg = cachedData.msg;
          const buffer = await downloadMediaMessage(fullMsg, 'buffer', {});
          const v2msg = fullMsg.message.viewOnceMessageV2 || fullMsg.message.viewOnceMessageV2Extension;
          const isVideo = !!v2msg.message.videoMessage;
          
          const caption = `ðŸ“¤ Ini adalah ${isVideo ? 'video' : 'gambar'} 1x lihat yang Anda minta.`;
          const sendOpt = isVideo 
            ? { video: buffer, caption } 
            : { image: buffer, caption };

          await sock.sendMessage(senderJid, sendOpt);
          console.log(`âœ… Berhasil mengirim ulang media 1x lihat dari cache.`);
          global.viewOnceCache.delete(quotedMsgId);

        } catch (error) {
          console.error("Gagal membuka media view once:", error);
          await sock.sendMessage(senderJid, { text: "âš ï¸ Gagal membuka media. Mungkin sudah terlalu lama atau terjadi kesalahan." });
        }
        return;
      }

      const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quotedMsg?.imageMessage || quotedMsg?.videoMessage) {
        let mediaToSteal = quotedMsg.imageMessage || quotedMsg.videoMessage;
        let mediaType = quotedMsg.imageMessage ? 'image' : 'video';

        try {
          await sock.sendMessage(senderJid, { react: { text: "â³", key: msg.key } });
          
          const quotedMsgObj = {
            key: {
              remoteJid: senderJid,
              id: quotedMsgId,
              participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: quotedMsg
          };

          const buffer = await downloadMediaMessage(quotedMsgObj, 'buffer', {});
          const caption = `ðŸ“¤ Ini adalah ${mediaType === 'image' ? 'gambar' : 'video'} dari pesan yang Anda reply.`;
          const sendOpt = mediaType === 'image' 
            ? { image: buffer, caption } 
            : { video: buffer, caption };

          await sock.sendMessage(senderJid, sendOpt);
          console.log(`âœ… Berhasil "mencuri" dan mengirim ulang ${mediaType}.`);
        } catch (error) {
          console.error("Gagal mencuri media:", error);
          await sock.sendMessage(senderJid, { text: "âš ï¸ Gagal mengambil media. Mungkin media sudah kedaluwarsa atau tidak dapat diakses." });
        } finally {
          await sock.sendMessage(senderJid, { react: { text: "", key: msg.key } });
        }
      } else {
        await sock.sendMessage(senderJid, { text: "âŒ Pesan yang Anda reply tidak mengandung gambar atau video yang bisa diambil." });
      }
      return;
    }

    // === /str untuk generate stiker ===
    if (command.startsWith('/str')) {
      let targetMessage = msg;
      let isQuoted = false;

      const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
      if (quoted) {
        targetMessage = {
            key: {
                remoteJid: msg.key.remoteJid,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: quoted
        };
        isQuoted = true;
      }

      const messageContent = targetMessage.message;
      const isImage = !!messageContent.imageMessage;
      const isVideo = !!messageContent.videoMessage;

      if (!isImage && !isVideo) {
        await sock.sendMessage(senderJid, { text: "âŒ Kirim atau reply sebuah gambar/video dengan caption /str." });
        return;
      }

      if (isVideo && messageContent.videoMessage.seconds > 7) {
        await sock.sendMessage(senderJid, { text: "âŒ Durasi video maksimal adalah 7 detik." });
        return;
      }

      try {
        await sock.sendMessage(senderJid, { react: { text: "â³", key: msg.key } });
        
        const buffer = await downloadMediaMessage(targetMessage, 'buffer', {});
        const stickerBuffer = await createSticker(buffer, isVideo, 'esta/alga', 'esta/alga');
        
        await sock.sendMessage(senderJid, { sticker: stickerBuffer }, { quoted: msg });
        console.log(`âœ… Stiker berhasil dikirim ke ${senderJid}`);
      } catch (error) {
        console.error("Gagal membuat stiker:", error);
        await sock.sendMessage(senderJid, { text: "âš ï¸ Gagal membuat stiker. Pastikan media valid dan coba lagi." });
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

    // === Fitur @allsundae (dengan teks tambahan) ===
    if (messageText.toLowerCase().includes('@allsundae')) {
        const from = msg.key.remoteJid || msg.key.participant || '';
        if (!from.endsWith('@g.us')) {
            await sock.sendMessage(from, { text: 'â— Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
            return;
        }

        // Ambil teks setelah @allsundae
        const extraText = messageText.replace(/^@allsundae\s*/i, '').trim() || '';
        const finalMessage = extraText
            ? `@allsundae ${extraText}`
            : '@allsundae';

        // Sistem cooldown per grup
        if (!global.allsundaeCooldown) global.allsundaeCooldown = new Map();
        const now = Date.now();
        const lastUsed = global.allsundaeCooldown.get(from);
        if (lastUsed && now - lastUsed < 10000) { // cooldown 10 detik
            // console.log(`â³ [@allsundae] Diblokir sementara di ${from}`); // Reduced logging
            return;
        }
        global.allsundaeCooldown.set(from, now);

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

            console.log(`âœ… [@allsundae] Selesai menandai ${participants.length} anggota di "${groupMetadata.subject}" dengan hidetag.`);
        } catch (err) {
            console.error('âŒ [@allsundae] Error:', err);
            await sock.sendMessage(from, { text: 'âš ï¸ Terjadi kesalahan saat menandai anggota. Coba lagi nanti.' }, { quoted: msg });
        }

        return;
    }

    // === /ai untuk interaksi dengan Gemini ===
    if (command.startsWith('/ai')) {
      const prompt = messageText.replace(/^\/ai\s*/i, '').trim();
      if (!prompt) {
        await sock.sendMessage(senderJid, { text: 'âš™ï¸ Gunakan format: /ai <pertanyaan kamu>' });
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
        const aiReply = result.response.text() || "Maaf, saya tidak bisa menjawab itu.";
        
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

    // --- FITUR REVERSE STIKER KE GAMBAR ---
    if (command.startsWith('/revstr')) {
      const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

      // Cek apakah ada reply ke stiker
      if (!quoted || !quoted.stickerMessage) {
        await sock.sendMessage(senderJid, {
          text: "âš ï¸ Harap reply ke stiker yang ingin dikembalikan menjadi gambar.",
          quoted: msg,
        });
        return;
      }

      try {
        await sock.sendMessage(senderJid, { react: { text: "ðŸ”„", key: msg.key } });
        // Download file stiker (format webp)
        const targetMessage = {
            key: {
                remoteJid: msg.key.remoteJid,
                id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                participant: msg.message.extendedTextMessage.contextInfo.participant
            },
            message: quoted
        };
        const buffer = await downloadMediaMessage(
          targetMessage,
          "buffer",
          {}
        );

        // Konversi webp ke png (pakai sharp)
        const imgBuffer = await sharp(buffer).png().toBuffer();

        // Kirim hasilnya ke chat
        await sock.sendMessage(senderJid, { image: imgBuffer, caption: "ðŸ”„ Ini hasil reverse dari stikermu!" }, { quoted: msg });

        console.log("âœ… Berhasil reverse stiker ke gambar!");
      } catch (err) {
        console.error("âš ï¸ Gagal reverse stiker:", err);
        await sock.sendMessage(senderJid, { text: "âš ï¸ Terjadi kesalahan saat mengembalikan stiker ke gambar." }, { quoted: msg });
      } finally {
        await sock.sendMessage(senderJid, { react: { text: "", key: msg.key } });
      }
      return;
    }
  });

  return sock;
}

connectToWhatsApp().catch(e => console.error("âŒ Gagal terhubung ke WhatsApp:", e));