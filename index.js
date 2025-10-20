// index.js (Final Fix: Log stub + Media ViewOnce bekerja dua arah)

require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAIFetchError, GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { exec } = require('child_process');
const { randomBytes } = require('crypto');

// === KONSTANTA PENYIMPANAN ===
const VIEWONCE_DIR = path.join(process.cwd(), 'viewonce_cache_new');
const VIEWONCE_JSON = path.join(process.cwd(), 'viewonce_cache_new.json');
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 jam
let viewOnceCache = {};
// ==============================

// 🧠 Cek API Key
if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Error: GEMINI_API_KEY tidak ditemukan di file .env");
  process.exit(1);
}

// 🚀 Inisialisasi Gemini
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

// === CACHE FUNGSIONALITAS ===
async function loadCacheFromFile() {
  try {
    const data = await fs.readFile(VIEWONCE_JSON, 'utf8');
    viewOnceCache = JSON.parse(data);
    console.log('📦 Cache 1x lihat berhasil dimuat dari file.');
  } catch {
    console.log('ℹ️ Tidak ada file cache 1x lihat. Membuat cache baru.');
    viewOnceCache = {};
  }
}

async function saveCacheToFile() {
  try {
    await fs.writeFile(VIEWONCE_JSON, JSON.stringify(viewOnceCache, null, 2));
  } catch (error) {
    console.error('❌ Gagal menyimpan cache 1x lihat ke file:', error);
  }
}

async function cleanupExpiredCache() {
  let cacheChanged = false;
  const now = Date.now();
  console.log('🧹 Menjalankan pembersihan cache 1x lihat...');
  const entries = Object.entries(viewOnceCache);
  for (const [messageId, entry] of entries) {
    if (now - entry.timestamp > CACHE_EXPIRATION_MS) {
      console.log(`🗑️ Menghapus file kedaluwarsa: ${entry.fileName}`);
      try {
        await fs.unlink(entry.filePath);
        delete viewOnceCache[messageId];
        cacheChanged = true;
      } catch (e) {
        if (e.code === 'ENOENT') {
          delete viewOnceCache[messageId];
          cacheChanged = true;
        } else {
          console.error(`❌ Gagal menghapus file ${entry.fileName}:`, e);
        }
      }
    }
  }
  if (cacheChanged) await saveCacheToFile();
  console.log('🧹 Cache sudah bersih.');
}
// ==============================

async function connectToWhatsApp() {
  const authFolder = path.join(process.cwd(), 'auth_info_baileys');
  try {
    await fs.mkdir(authFolder, { recursive: true });
    await fs.mkdir(VIEWONCE_DIR, { recursive: true });
  } catch (e) {
    console.error('❌ Gagal membuat folder:', e);
  }

  await loadCacheFromFile();
  await cleanupExpiredCache();

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
        console.log('❌ Logout! Hapus folder auth_info_baileys lalu scan ulang QR.');
        process.exit(1);
      } else {
        console.log(`⚠️ Koneksi terputus (${code}), menyambung ulang...`);
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') console.log('✅ Bot Astro AI berhasil tersambung!');
  });

  // === LOG STUB VIEWONCE (NOTIFIKASI “MENUNGGU MEDIA”) ===
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (key?.isViewOnce && !update.message) {
        console.log('\n---------------------------------');
        console.log(`ℹ️ [INFO] Notifikasi pesan 1x lihat diterima dari ${key.remoteJid}. Menunggu konten media...`);
        console.log('---------------------------------');
      }
    }
  });

  // === HANDLE SEMUA PESAN MASUK ===
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg?.message) return;

    const senderJid = msg.key.remoteJid; // Declaration moved to top

    // === DETEKSI PESAN VIEWONCE SEBENARNYA ===
    if (msg.message?.viewOnceMessageV2?.message) {
      const fullMsg = msg;
      console.log(`\n---------------------------------`);
      console.log(`📸 [KONTEN 1x LIHAT DITEMUKAN]`);
      console.log(`  > Dari: ${senderJid}`);
      console.log(`  > ID Pesan: ${msg.key.id}`);

      try {
        const buffer = await downloadMediaMessage(fullMsg, 'buffer', {});
        const v2msg = fullMsg.message.viewOnceMessageV2.message;
        const isVideo = !!v2msg.videoMessage;
        const messageId = msg.key.id;
        const fileExtension = isVideo ? '.mp4' : '.jpg';
        const fileName = `${messageId}${fileExtension}`;
        const filePath = path.join(VIEWONCE_DIR, fileName);

        await fs.writeFile(filePath, buffer);
        viewOnceCache[messageId] = {
          filePath,
          fileName,
          isVideo,
          senderJid,
          timestamp: Date.now()
        };
        await saveCacheToFile();

        console.log(`  > ✅ Media 1x lihat (ID: ${messageId}) disimpan ke ${fileName}`);
        await sock.sendMessage(senderJid, {
          text: `✅ Media 1x lihat berhasil diarsipkan.\n\nBalas pesan aslinya dengan /op untuk membukanya lagi.`
        });
      } catch (e) {
        console.error(`❌ Gagal menyimpan media 1x lihat (ID: ${msg.key.id}):`, e);
        await sock.sendMessage(senderJid, {
          text: `⚠️ Gagal mengarsipkan media 1x lihat. Mungkin sudah dibuka atau kedaluwarsa.`
        });
      }
      console.log(`---------------------------------`);
      return;
    }

    // === /str untuk buat stiker ===
    const type = Object.keys(msg.message)[0];
    const body = (type === 'conversation' && msg.message.conversation) ? msg.message.conversation : 
                 (type === 'extendedTextMessage' && msg.message.extendedTextMessage.text) ? msg.message.extendedTextMessage.text : 
                 (type === 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption : '';

            if (body && body.toLowerCase().startsWith('/str')) {

              let mediaMessage = null;

              let mediaType = ''; // 'image' or 'video'

        

              // Find media (image or video, direct or quoted)

              if (msg.message.imageMessage) {

                  mediaMessage = msg.message.imageMessage;

                  mediaType = 'image';

              } else if (msg.message.videoMessage) {

                  mediaMessage = msg.message.videoMessage;

                  mediaType = 'video';

              } else if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) {

                  mediaMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage;

                  mediaType = 'image';

              } else if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.videoMessage) {

                  mediaMessage = msg.message.extendedTextMessage.contextInfo.quotedMessage.videoMessage;

                  mediaType = 'video';

              }

        

              if (mediaMessage) {

                if (mediaType === 'video' && mediaMessage.seconds > 5) {

                  await sock.sendMessage(senderJid, { text: '⚠️ Video terlalu panjang! Durasi maksimal untuk stiker video adalah 5 detik.' }, { quoted: msg });

                  return;

                }

        

                await sock.sendMessage(senderJid, { text: '⏳ Membuat stiker...' }, { quoted: msg });

                

                try {

                  const downloadObject = { message: { [mediaType + 'Message']: mediaMessage } };

                  const buffer = await downloadMediaMessage(downloadObject, 'buffer', {});

                  

                  const tempIn = path.join(VIEWONCE_DIR, `${randomBytes(6).toString('hex')}.${mediaType === 'image' ? 'jpg' : 'mp4'}`);

                  const tempOut = path.join(VIEWONCE_DIR, `${randomBytes(6).toString('hex')}.webp`);

        

                  await fs.writeFile(tempIn, buffer);

        

                  let ffmpegCommand = '';

                  if (mediaType === 'image') {

                    ffmpegCommand = `ffmpeg -i ${tempIn} -vf "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black" -an ${tempOut}`;

                  } else { // Video

                    ffmpegCommand = `ffmpeg -i ${tempIn} -c:v libwebp -filter:v "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black,fps=15" -an -loop 0 -ss 00:00:00 -t 00:00:05 ${tempOut}`;

                  }

        

                  exec(ffmpegCommand, async (error) => {

                    const cleanup = async () => {

                        try { await fs.unlink(tempIn); } catch {}

                        try { await fs.unlink(tempOut); } catch {}

                    };

        

                    if (error) {

                      console.error('❌ Gagal membuat stiker:', error);

                      await sock.sendMessage(senderJid, { text: '⚠️ Gagal membuat stiker. Pastikan ffmpeg terinstal dengan benar.' }, { quoted: msg });

                      await cleanup();

                      return;

                    }

        

                    try {

                      const stickerBuffer = await fs.readFile(tempOut);

                      await sock.sendMessage(senderJid, { sticker: stickerBuffer });

                    } catch (e) {

                       console.error('❌ Gagal mengirim stiker:', e);

                       await sock.sendMessage(senderJid, { text: '⚠️ Gagal mengirim stiker setelah konversi.' }, { quoted: msg });

                    } finally {

                        await cleanup();

                    }

                  });

        

                } catch (e) {

                  console.error('❌ Gagal mengunduh media untuk stiker:', e);

                  await sock.sendMessage(senderJid, { text: '⚠️ Gagal mengunduh gambar/video untuk dijadikan stiker.' }, { quoted: msg });

                }

        

              } else {

                await sock.sendMessage(senderJid, { text: 'Kirim gambar/video (maks 5 dtk) dengan caption /str atau balas media tsb dengan /str.' }, { quoted: msg });

              }

              return; 

            }

    // === PESAN TEKS BIASA ===
    const senderName = msg.pushName || "Pengguna";
    const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!messageText) return;

    console.log(`\n---------------------------------`);
    console.log(`💬 [PESAN MASUK]`);
    console.log(`  > Dari: ${senderName} (${senderJid})`);
    console.log(`  > Pesan: "${messageText}"`);
    console.log(`---------------------------------`);

    // === /op untuk buka ulang ===
    if (messageText.toLowerCase() === '/op') {
      const quoted = msg.message.extendedTextMessage?.contextInfo;
      if (!quoted?.stanzaId) {
        await sock.sendMessage(senderJid, { text: "Gunakan /op dengan me-reply pesan 1x lihat yang ingin dibuka." });
        return;
      }
      const quotedId = quoted.stanzaId;
      const cached = viewOnceCache[quotedId];
      if (!cached || cached.senderJid !== senderJid) {
        await sock.sendMessage(senderJid, { text: "⚠️ Tidak menemukan media itu di cache." });
        return;
      }
      if (Date.now() - cached.timestamp > CACHE_EXPIRATION_MS) {
        await sock.sendMessage(senderJid, { text: "⚠️ Media 1x lihat sudah kedaluwarsa (>24 jam)." });
        try {
          await fs.unlink(cached.filePath);
          delete viewOnceCache[quotedId];
          await saveCacheToFile();
        } catch {}
        return;
      }
      console.log(`📤 Mengirim ulang media: ${cached.fileName}`);
      const msgOpt = cached.isVideo
        ? { video: { url: cached.filePath }, caption: "📤 Ini media 1x lihat yang Anda maksud." }
        : { image: { url: cached.filePath }, caption: "📤 Ini media 1x lihat yang Anda maksud." };
      await sock.sendMessage(senderJid, msgOpt);
      return;
    }

    // === /ai untuk interaksi dengan Gemini ===
    if (messageText.toLowerCase().startsWith('/ai')) {
      const prompt = messageText.replace(/^\/ai\s*/i, '').trim();
      if (!prompt) {
        await sock.sendMessage(senderJid, { text: '⚙️ Gunakan format: /ai <pertanyaan kamu>' });
        return;
      }

      console.log(`⏳ [PROSES AI] "${prompt}"`);
      try {
        await sock.sendMessage(senderJid, { react: { text: "⏰", key: msg.key } });
        await sock.sendPresenceUpdate('composing', senderJid);
        const result = await model.generateContent(prompt);
        const aiReply = result.response.text() || "Maaf, saya tidak bisa menjawab itu.";
        await sock.sendMessage(senderJid, { text: aiReply }, { quoted: msg });
        console.log(`📤 [BALASAN AI TERKIRIM]`);
      } catch (error) {
        let errMsg = '⚠️ Maaf, terjadi kesalahan internal.';
        if (error instanceof GoogleGenerativeAIFetchError) {
          errMsg = `⚠️ Gagal menghubungi model: ${error.message}`;
        }
        console.error(error);
        await sock.sendMessage(senderJid, { text: errMsg }, { quoted: msg });
      } finally {
        try {
          await sock.sendMessage(senderJid, { react: { text: "", key: msg.key } });
        } catch {}
      }
      return; // Stop processing after handling AI command
    }

    // === .brat untuk buat stiker teks ===
    if (messageText.toLowerCase().startsWith('.brat')) {
      const prompt = messageText.replace(/^\.brat\s*/i, '').trim();
      if (!prompt) {
        await sock.sendMessage(senderJid, { text: '⚙️ Gunakan format: .brat <teks kamu>' });
        return;
      }

      console.log(`🎨 [PROSES BRAT STICKER] "${prompt}"`);
      await sock.sendMessage(senderJid, { text: '⏳ Membuat stiker brat...' }, { quoted: msg });

      const words = prompt.split(/\s+/);
      const fontPath = "/system/fonts/Roboto-Regular.ttf"; // bisa ganti brat.ttf

      // posisi X acak: kiri / tengah / kanan
      const positions = ["10", "(w-text_w)/2", "w-tw-10"];

      let drawTexts = words.map((word, i) => {
        const posX = positions[Math.floor(Math.random() * positions.length)];
        const posY = 50 + i * 100; // tiap baris turun 100px
        return `drawtext=text='${word}':fontfile=${fontPath}:fontsize=80:fontcolor=black:x=${posX}:y=${posY}`;
      }).join(",");

      const tempPng = path.join(VIEWONCE_DIR, `${randomBytes(6).toString('hex')}.png`);
      const tempWebp = path.join(VIEWONCE_DIR, `${randomBytes(6).toString('hex')}.webp`);

      const genPngCommand = `ffmpeg -f lavfi -i color=c=white:s=512x512 -vf "${drawTexts}" -frames:v 1 ${tempPng}`;

      exec(genPngCommand, (error) => {
        if (error) {
          console.error('❌ Gagal membuat gambar PNG brat:', error);
          sock.sendMessage(senderJid, { text: '⚠️ Gagal membuat gambar brat.' }, { quoted: msg });
          return;
        }

        const genWebpCommand = `ffmpeg -i ${tempPng} -vcodec libwebp -lossless 1 -q:v 90 -preset default -loop 0 -an -vsync 0 -s 512:512 ${tempWebp}`;
        exec(genWebpCommand, async (error) => {
          const cleanup = async () => {
            try { await fs.unlink(tempPng); } catch {}
            try { await fs.unlink(tempWebp); } catch {}
          };

          if (error) {
            console.error('❌ Gagal konversi brat ke WEBP:', error);
            await sock.sendMessage(senderJid, { text: '⚠️ Gagal konversi brat.' }, { quoted: msg });
            await cleanup();
            return;
          }

          try {
            const stickerBuffer = await fs.readFile(tempWebp);
            await sock.sendMessage(senderJid, { sticker: stickerBuffer });
          } catch (e) {
            console.error('❌ Gagal kirim stiker brat:', e);
            await sock.sendMessage(senderJid, { text: '⚠️ Gagal kirim stiker brat.' }, { quoted: msg });
          } finally {
            await cleanup();
          }
        });
      });
      return;
    }

  });

  return sock;
}

connectToWhatsApp().catch(e => console.error("❌ Gagal terhubung ke WhatsApp:", e));
