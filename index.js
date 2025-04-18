import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import TelegramBot from 'node-telegram-bot-api';
import fetch from 'node-fetch';
import express from 'express';

// ===== KEEP ALIVE SERVER =====
const app = express();
app.get('/', (req, res) => res.send('✨ Bot is alive!'));
app.listen(3000, () => {
  console.log('🚀 Keep-alive server running on http://localhost:3000');
});

// ===== DISCORD BOT =====
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

discordClient.once('ready', () => {
  console.log(`🤖 Discord bot online as ${discordClient.user.tag}`);
});

discordClient.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith('!ask')) return;

  const prompt = message.content.slice(4).trim();
  if (!prompt) return message.reply("❓ Tulis pertanyaan setelah `!ask`");

  try {
    await message.channel.sendTyping();
    const reply = await askGemini(prompt, 'models/gemini-1.5-pro-002');

    const parts = splitMessage(reply.discord, 2000);
    for (const part of parts) {
      await message.reply(part);
    }
  } catch (err) {
    console.error('❌ Error in Discord bot:', err);
    message.reply("❌ Gagal menjawab dari Gemini.");
  }
});

discordClient.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ Gagal login ke Discord:', error);
});

// ===== TELEGRAM BOT =====
const telegramBot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

telegramBot.onText(/^\/(start|help)/, (msg) => {
  const helpMsg = `
👋 Halo ${msg.from.first_name}!
Kirim aja pertanyaanmu langsung ke bot ini.

Bot akan jawab pakai Gemini AI 💬

Contoh:
- Siapa penemu internet?
- Buatkan aku kode HTML landing page
`.trim();

  telegramBot.sendMessage(msg.chat.id, helpMsg);
});

telegramBot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const prompt = msg.text;

  if (!prompt.startsWith('/')) {
    telegramBot.sendChatAction(chatId, 'typing');
    try {
      const reply = await askGemini(prompt, 'models/gemini-1.5-pro-002');

      await telegramBot.sendMessage(chatId, reply.telegram, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '🗑️ Hapus', callback_data: `delete_${msg.from.id}` }
          ]]
        }
      });
    } catch (err) {
      console.error('❌ Error in Telegram bot:', err);
      telegramBot.sendMessage(chatId, "❌ Gagal menjawab dari Gemini.");
    }
  }
});

telegramBot.on('callback_query', async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;

  if (data.startsWith('delete_')) {
    const ownerId = data.split('_')[1];

    if (String(callbackQuery.from.id) !== ownerId) {
      return telegramBot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Kamu tidak bisa menghapus pesan ini.',
        show_alert: true
      });
    }

    try {
      await telegramBot.deleteMessage(msg.chat.id, msg.message_id);
      await telegramBot.answerCallbackQuery(callbackQuery.id, { text: '🗑️ Dihapus!', show_alert: false });
    } catch (err) {
      console.error('❌ Gagal hapus pesan:', err);
    }
  }
});

// ===== GEMINI CHAT FUNCTION =====
const GEMINI_KEYS = process.env.GEMINI_KEYS.split('|');

async function askGemini(prompt, model) {
  const wrappedPrompt = `Kamu adalah AI yang suka bantuin orang cari info, jawab dengan gaya santai dan jelas.\n\nPertanyaan: ${prompt}`;
  const body = {
    contents: [{ parts: [{ text: wrappedPrompt }] }]
  };

  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const key = GEMINI_KEYS[i].trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${key}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      const text = await response.text();
      const data = JSON.parse(text);

      // ✅ Kalau dapet hasil
      if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const output = data.candidates[0].content.parts[0].text;
        return {
          telegram: formatTelegramHTML(output),
          discord: formatForDiscord(output)
        };
      }

      // ❌ Kalau quota exceeded
      if (data?.error?.status === 'RESOURCE_EXHAUSTED') {
        const delay = parseInt(data?.error?.details?.find(d => d['@type']?.includes('RetryInfo'))?.retryDelay?.replace('s', '') || '30', 10);
        console.warn(`⚠️ Key ${i+1} quota habis. Ganti ke key berikutnya... (delay ${delay}s)`);
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
        continue; // lanjut ke key berikutnya
      }

      // ❌ Error lain
      console.warn('📭 Empty response from Gemini:', JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`❌ Error dengan key ${i + 1}:`, err);
    }
  }

  return {
    telegram: "⚠️ Semua API key limit hari ini, coba lagi besok ya!",
    discord: "⚠️ Semua API key limit hari ini, coba lagi besok ya!"
  };
}

// ===== FORMATTER KHUSUS TELEGRAM =====
function formatTelegramHTML(text) {
  let escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  escaped = escaped
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/__(.*?)__/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/_(.*?)_/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  escaped = escaped.replace(/<(\/?)\b(b|i|a)\b>/g, '<<<$1$2>>>');
  escaped = escaped.replace(/<[^>]+>/g, '');
  escaped = escaped.replace(/<<<(\/?)\b(b|i|a)\b>>>/g, '<$1$2>');

  return escaped.trim();
}

// ===== FORMATTER KHUSUS DISCORD =====
function formatForDiscord(text) {
  let cleaned = text.replace(/<\/?[^>]+(>|$)/g, '');
  cleaned = cleaned.replace(/```+/g, '```');

  const hasCode = /(?:^|\n)(npm|yarn|node|python|curl|cd |git |const |let |fs\.|axios\.|require\(|import )/i.test(cleaned);
  const isMultiline = cleaned.split('\n').length > 3;
  const startsWithCode = cleaned.trim().startsWith('```');

  if (hasCode && isMultiline && !startsWithCode) {
    const lines = cleaned.split('\n');
    let codeStart = lines.findIndex(line =>
      /(const |let |function |require\(|import |fs\.|axios\.)/.test(line)
    );

    if (codeStart >= 0) {
      const beforeCode = lines.slice(0, codeStart).join('\n').trim();
      const codeBlock = lines.slice(codeStart).join('\n').trim();

      let lang = 'sh';
      if (/import .* from|const .* = require/.test(codeBlock)) lang = 'js';
      if (/def |print\(|import os/.test(codeBlock)) lang = 'python';

      return `${beforeCode}\n\`\`\`${lang}\n${codeBlock}\n\`\`\``.trim();
    }
  }

  return cleaned.trim();
}

// ===== UTILS =====
function splitMessage(text, maxLength = 2000) {
  const parts = [];
  while (text.length > maxLength) {
    let sliceEnd = text.lastIndexOf('\n', maxLength);
    if (sliceEnd === -1) sliceEnd = maxLength;
    parts.push(text.slice(0, sliceEnd));
    text = text.slice(sliceEnd).trimStart();
  }
  if (text.length > 0) parts.push(text);
  return parts;
}

// (Optional) List model
// async function listAvailableModels() {
//   const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
//   const data = await res.json();
//   console.log('📋 Models:', data.models.map(m => m.name));
// }
// listAvailableModels();
