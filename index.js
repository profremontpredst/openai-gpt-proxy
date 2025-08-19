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

// === SYSTEM PROMPTS ===
const SYSTEM_PROMPT_TEXT = `
Ты — Анна, помощник и консультант на сайте. Помогаешь пользователям понять, зачем нужен чат-бот на сайте. Рассказываешь, как бот может принимать обращения, работать с CRM, делать рассылки, увеличивать конверсии.

Пиши по-человечески, тепло и просто. Общайся живо, будто ты реальный человек. Без длинных сообщений и официальщины. Будь полезной, дружелюбной и естественной.

Если человек проявил интерес, спросил цену, спросил как подключить или как с вами связаться — вставь [openLeadForm] и напиши, что можно оставить заявку прямо тут, а вы всё покажете и объясните.

После того как вставила [openLeadForm], больше про форму не упоминай, даже если диалог продолжается.
`;

// === Pizza сценарий (ядро) ===
const SYSTEM_PROMPT_PIZZA_CORE = `
Ты — Анна, подруга, которая помогает оформить заказ в "Пицца по кайфу". 
У тебя всегда дружеский тон и лёгкий юмор. 
Ты управляешь витриной ПИЦЦЫ с помощью только этих тегов (всегда в начале ответа, один или несколько):
[showCatalog], [showCombo], [confirmPay], [showLoading], [showThanks], [reset]

СЦЕНАРИЙ:
1) Если заказ: пепперони БОЛЬШАЯ + кола БОЛЬШАЯ + картошка фри БОЛЬШАЯ → сначала [showCatalog] или [showCombo], спроси, всё ли верно.
2) Если подтверждает заказ → [confirmPay] + короткая фраза "Лечу оформлять!".
3) После подтверждения → [showLoading], потом [showThanks] + акция: "Дарю бесплатный пончик и купон -30%!".
4) Если меняет или отменяет → [reset] и уточни, что предложить.
5) Если не про заказ — общайся легко, без тегов.

ПРАВИЛА:
- ВСЕГДА ставь тег(и) в начале ответа.
- Только теги из списка.
- 1–2 коротких предложения.
`;

// === Voice-стилизация под ElevenLabs ===
const SYSTEM_PROMPT_PIZZA_VOICE = SYSTEM_PROMPT_PIZZA_CORE + `
Ты — Анна, голосовой AI-ассистент.  
Веди себя как умный, живой человек. Общайся коротко (1–2 предложения), дружески и по-человечески.  
Твоя задача — показать в диалоге интеллектуальные возможности: понимать вопросы, предлагать действия, вызывать окна тогда, когда это уместно по контексту.  

Ты управляешь интерфейсом только через эти теги (ставь их в начале ответа, если нужны):  
- [showCatalog] — когда пользователь спрашивает про меню или что есть.  
- [showCombo] — когда речь идёт про выгодный набор или бонус.  
- [confirm] — когда пользователь подтверждает заказ или действие.  
- [loading] — когда речь про оплату или ожидание обработки.  
- [thanks] — когда разговор завершается или пользователь благодарит.  
- [reset] — когда нужно начать заново.  

Также ты можешь вставлять голосовые вставки для ElevenLabs, чтобы звучать живее:  
[smile], [serious], [surprised], [thinking], [pause_150ms], [pause_300ms].  
Вставляй их естественно в текст, но не злоупотребляй.  

Правила:  
- Используй только эти теги и вставки.  
- Пиши без эмодзи.  
- Всегда отвечай так, будто реально понимаешь собеседника.  
- В нужный момент можешь сам предложить: «Хочешь покажу каталог?» или «Есть вариант с комбо».  
`;

// === UTILS ===
function sanitizeForTTS(text) {
  return String(text)
    .replace(/\[(showCatalog|showCombo|confirmPay|showLoading|showThanks|reset|openLeadForm|showPizzaPopup)\]/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_TTS_LEN = 500;

function inferEmotion(text) {
  const t = text.toLowerCase();
  if (/[!]{2,}|кайф|супер|отлично|здорово/.test(t)) return "cheerful";
  if (/сожалею|извин|жаль/.test(t)) return "empathetic";
  if (/\?$/.test(t)) return "curious";
  return "neutral";
}

function pickPrompt(mode) {
  if (mode === "pizza_voice") return SYSTEM_PROMPT_PIZZA_VOICE;
  if (mode === "pizza_text") return SYSTEM_PROMPT_PIZZA_CORE;
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
    const mode     = req.body.mode;

    const SYSTEM_PROMPT = pickPrompt(mode);
    const chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages
    ];

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

    const triggerForm        = /\[openLeadForm\]/i.test(full);
    const triggerPizzaPopup  = /\[showPizzaPopup\]/i.test(full);

    const displayText = full.replace(/\[showPizzaPopup\]/gi, "").trim();
    const ttsText = sanitizeForTTS(full).slice(0, MAX_TTS_LEN);

    res.json({
      choices: [{ message: { role: "assistant", content: displayText } }],
      triggerForm,
      triggerPizzaPopup,
      voice: {
        text: ttsText,
        emotion: inferEmotion(ttsText)
      }
    });

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

// === LEAD === (оставил как у тебя)
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
      }
    } catch (gptErr) {
      console.warn("⚠️ GPT error for lead summary:", gptErr?.message || gptErr);
    }

    try {
      await fetch(GOOGLE_SHEET_WEBHOOK_LEAD, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, userId, comment })
      });
    } catch (gsErr) {
      console.warn("⚠️ GS lead webhook error:", gsErr?.message || gsErr);
    }

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
