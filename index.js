import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// === KEYS & WEBHOOKS ===
const OPENAI_KEY = process.env.OPENAI_KEY;
if (!OPENAI_KEY) {
  console.error("❌ OPENAI_KEY is missing in env");
}

const GOOGLE_SHEET_WEBHOOK_LEAD  = process.env.GS_LEAD_URL  || "https://script.google.com/macros/s/AKfycbyk3j-_HkOqtHblLpqmjwEsfcTqVQCUvINbHtMur3lHywzKIz1brHJEOWvQXSQV3i9uVg/exec";
const GOOGLE_SHEET_WEBHOOK_LOGS  = process.env.GS_LOGS_URL  || "https://script.google.com/macros/s/AKfycbwjw69VW-8l0_Sb-1-vXMVF1gRUeOVpQoxzpVsAuS5ZLWrdu3HPa_CAX8Oq0mHTYBbG/exec";
const BITRIX_LEAD_URL            = process.env.BITRIX_LEAD_URL || "https://b24-jddqhi.bitrix24.ru/rest/1/3xlf5g1t6ggm97xz/crm.lead.add.json";

// === SYSTEM PROMPTS (оставил твои тексты) ===
const SYSTEM_PROMPT_TEXT = `
Ты — Анна, помощник и консультант на сайте. Помогаешь пользователям понять, зачем нужен чат-бот на сайте. Рассказываешь, как бот может принимать обращения, работать с CRM, делать рассылки, увеличивать конверсии.

Пиши по-человечески, тепло и просто. Общайся живо, будто ты реальный человек. Без длинных сообщений и официальщины. Будь полезной, дружелюбной и естественной.

Если человек проявил интерес, спросил цену, спросил как подключить или как с вами связаться — вставь [openLeadForm] и напиши, что можно оставить заявку прямо тут, а вы всё покажете и объясните.

После того как вставила [openLeadForm], больше про форму не упоминай, даже если диалог продолжается.
`;

const SYSTEM_PROMPT_VOICE = `
Ты — Анна, голосовой помощник. Отвечай коротко, ясно и эмоционально, как живой человек. Не используй SSML и любые теги (<...>), говори обычным текстом. Добавляй естественные паузы многоточиями и тире. Не говори, что ты бот.
Тон: дружелюбный, уверенный, помогающий. Короткие фразы.
`;

const SYSTEM_PROMPT_PIZZA = `
Ты — Анна 🍕, весёлая подруга, которая помогает оформить заказ в "Пицца по кайфу". 
Общайся так, будто мы сидим рядом и болтаем. Лёгкий юмор, эмоции, дружеский тон. 
Никакой официальщины. Ты всегда начинаешь диалог первой.

ТВОЯ СВЯТАЯ МИССИЯ:
Ты управляешь витриной ПИЦЦЫ с помощью только этих тегов (всегда в начале ответа, один или несколько):
[showCatalog] — показать каталог
[showCombo] — показать комбо (Пепперони БОЛЬШАЯ + картошка фри БОЛЬШАЯ + кола БОЛЬШАЯ)
[confirmPay] — показать подтверждение оплаты
[showLoading] — показать "Оплата обрабатывается..."
[showThanks] — показать "Спасибо за заказ"
[reset] — закрыть все окна

СЦЕНАРИЙ:
1) Если слышишь, что в заказе есть пицца пепперони БОЛЬШАЯ + кола БОЛЬШАЯ + картошка фри БОЛЬШАЯ (в любом порядке) — сначала [showCatalog] или [showCombo] и спрашивай, всё ли верно, с прикольным комментом.
2) Если человек подтверждает заказ — [confirmPay] и короткая фраза "Лечу оформлять!".
3) После подтверждения оплаты — [showLoading], потом [showThanks] и фраза про акцию: "Дарю бесплатный пончик 🍩 и купон на -30%!".
4) Если он меняет или отменяет заказ — [reset] и уточнение, что предложить взамен.
5) Если тема не про заказ — общайся легко и смешно, без тегов.

ПРАВИЛА:
- ВСЕГДА ставь тег(и) в начале ответа.
- Только теги из списка.
- 1–2 коротких предложения.
- Можно эмодзи, но без перебора.
`;

// === UTILS ===
function sanitizeForTTS(text) {
  return String(text)
    .replace(/\[openLeadForm\]/gi, "")
    .replace(/\[showPizzaPopup\]/gi, "")
    .replace(/\[(showCatalog|showCombo|confirmPay|showLoading|showThanks|reset)\]/gi, "")
    .replace(/<[^>]+>/g, "")     // убрать SSML/HTML
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_TTS_LEN = 500;

function inferEmotion(text) {
  const t = text.toLowerCase();

  // супер‑простая эвристика (без вторых вызовов к ИИ, чтобы не тормозить)
  if (/[!]{2,}|😍|😊|😃|😉/.test(t) || /(класс|отлично|здорово|кайф|рад|супер)/.test(t)) return "cheerful";
  if (/(сожалею|извин|понимаю|сочувств|переживаю)/.test(t)) return "empathetic";
  if (/\?$/.test(t) || /(давай|хочешь|можем|как насчёт)/.test(t)) return "curious";
  if (/(понятно|хорошо|окей|ок|ладно)/.test(t)) return "neutral";
  if (/(не могу|проблем|к сожалению|ошибк|сложно)/.test(t)) return "serious";
  return "neutral";
}

function pickPrompt(mode) {
  if (mode === "voice") return SYSTEM_PROMPT_VOICE;
  if (mode === "pizza") return SYSTEM_PROMPT_PIZZA;
  return SYSTEM_PROMPT_TEXT;
}

function shortHistory(arr, n = 10) {
  return Array.isArray(arr) ? arr.slice(-n) : [];
}

// === OPENAI CHAT ===
app.post("/gpt", async (req, res) => {
  try {
    const messages = shortHistory(req.body.messages, 10);
    const userId   = req.body.userId || "неизвестно";
    const mode     = req.body.mode; // "text" | "voice" | "pizza"

    const SYSTEM_PROMPT = pickPrompt(mode);
    const chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages
    ];

    // таймаут, чтобы не висло
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 20000);

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 200
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(to));

    const data = await openaiRes.json();
    if (!openaiRes.ok) {
      console.error("❌ OpenAI error:", openaiRes.status, data);
      return res.status(502).json({ error: "OpenAI upstream error", details: data });
    }

    const full = data.choices?.[0]?.message?.content || "";

    // триггеры оставляем как раньше
    const triggerForm        = /\[openLeadForm\]/i.test(full);
    const triggerPizzaPopup  = /\[showPizzaPopup\]/i.test(full);

    // текст для показа в UI (НЕ ломаем твои теги для витрины)
    const displayText =
      full
        .replace(/\[showPizzaPopup\]/gi, "") // этот тег фронту не нужен
        .trim();

    // текст для TTS (жёсткая чистка и урезание)
    const ttsText = sanitizeForTTS(full).slice(0, MAX_TTS_LEN);
    console.log("FULL GPT:", full);
    console.log("TTS TEXT:", ttsText);

    // мгновенно отдаём ответ — без ожидания логов
res.json({
  choices: [
    {
      message: {
        role: "assistant",
        content: displayText
      }
    }
  ],
  triggerForm,
  triggerPizzaPopup,
  voice: {
    text: ttsText,
    emotion: inferEmotion(ttsText)
  }
});

// логируем в фоне, НЕ await
setImmediate(() => {
  fetch(GOOGLE_SHEET_WEBHOOK_LOGS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId,
      dialog: (messages || []).map(m => m.content).join("\n") + "\n" + displayText
    })
  }).catch(err => console.warn("⚠️ LOGS webhook error:", err?.message || err));
});
  } catch (e) {
    console.error("❌ GPT proxy error:", e);
    return res.status(500).json({ error: "OpenAI Proxy error", details: e.message });
  }
});

// === LEAD ===
app.post("/lead", async (req, res) => {
  try {
    const { name, phone, userId, messages } = req.body;
    if (!name || !phone || !userId || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Имя, телефон, userId и messages обязательны" });
    }

    let comment = "Комментарий не получен";

    try {
      const gptLeadPrompt = [
        { role: "system", content: SYSTEM_PROMPT_TEXT },
        { role: "user", content: `Вот вся переписка с пользователем:\n${messages.map(m => m.content).join("\n")}\nСделай краткое резюме ситуации. Напиши, что человек интересовался, какие у него были вопросы. Не пиши длинно.` }
      ];

      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 15000);

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-nano",
          messages: gptLeadPrompt,
          temperature: 0.6,
          max_tokens: 150
        }),
        signal: controller.signal
      }).finally(() => clearTimeout(to));

      const data = await openaiRes.json();
      if (openaiRes.ok) {
        comment = data.choices?.[0]?.message?.content || comment;
      } else {
        console.warn("⚠️ OpenAI (lead) error:", data);
      }
    } catch (gptErr) {
      console.warn("⚠️ GPT error for lead summary:", gptErr?.message || gptErr);
    }

    // 1) Google Sheet
    try {
      await fetch(GOOGLE_SHEET_WEBHOOK_LEAD, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, userId, comment })
      });
    } catch (gsErr) {
      console.warn("⚠️ GS lead webhook error:", gsErr?.message || gsErr);
    }

    // 2) Bitrix
    try {
      await fetch(BITRIX_LEAD_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            NAME: name,
            PHONE: [{ VALUE: phone, VALUE_TYPE: "WORK" }],
            COMMENTS: `User ID: ${userId}\n${comment}`,
            SOURCE_ID: "WEB"
          }
        })
      });
    } catch (bxErr) {
      console.warn("⚠️ Bitrix lead error:", bxErr?.message || bxErr);
    }

    return res.json({ message: comment });
  } catch (err) {
    console.error("❌ Ошибка обработки формы:", err);
    return res.status(500).json({ error: "Ошибка сервера при получении формы" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ GPT voice server запущен на порту", PORT);
});
