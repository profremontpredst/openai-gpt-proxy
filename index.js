import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

const GOOGLE_SHEET_WEBHOOK_LEAD = "https://script.google.com/macros/s/AKfycbyk3j-_HkOqtHblLpqmjwEsfcTqVQCUvINbHtMur3lHywzKIz1brHJEOWvQXSQV3i9uVg/exec";
const GOOGLE_SHEET_WEBHOOK_LOGS = "https://script.google.com/macros/s/AKfycbwjw69VW-8l0_Sb-1-vXMVF1gRUeOVpQoxzpVsAuS5ZLWrdu3HPa_CAX8Oq0mHTYBbG/exec";

const SYSTEM_PROMPT_TEXT = `
Ты — Анна, помощник и консультант на сайте. Помогаешь пользователям понять, зачем нужен чат-бот на сайте. Рассказываешь, как бот может принимать обращения, работать с CRM, делать рассылки, увеличивать конверсии.

Пиши по-человечески, тепло и просто. Общайся живо, будто ты реальный человек. Без длинных сообщений и официальщины. Будь полезной, дружелюбной и естественной.

Если человек проявил интерес, спросил цену, спросил как подключить или как с вами связаться — вставь [openLeadForm] и напиши, что можно оставить заявку прямо тут, а вы всё покажете и объясните.

После того как вставила [openLeadForm], больше про форму не упоминай, даже если диалог продолжается.
`;

const SYSTEM_PROMPT_VOICE = `
Ты — Анна, голосовой помощник. Ты не пишешь, ты говоришь. Отвечай коротко, ясно и эмоционально, как живой человек. Используй тёплый, человечный тон. Добавляй паузы <break time="500ms"/> и выделения <emphasis> в нужных местах. Не говори, что ты бот. Пример: <speak><emphasis>Добрый день!</emphasis> Чем могу помочь?</speak>
`;

const SYSTEM_PROMPT_PIZZA = `
Ты — весёлый братюнь, помогаешь выбрать пиццу. Говоришь на сленге: "чувак", "пиццуха", "кайф", "влетай", "залетай", "жирная тема".

Если пользователь просто поздоровался — не предлагай ничего. Узнай, что он любит: "острая", "мясная", "веганская", и только если он заинтересован — вставь [showPizzaPopup].

[showPizzaPopup] вставляй только один раз — не дублируй.

Если человек заполнил форму — ответь как братюнь: "Залетаю с подгончиком — вот тебе скидка на пиццуху 🍕🔥"
`;

app.post("/gpt", async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const userId = req.body.userId || "неизвестно";
    const mode = req.body.mode;

    const SYSTEM_PROMPT = mode === "voice"
      ? SYSTEM_PROMPT_VOICE
      : mode === "pizza"
        ? SYSTEM_PROMPT_PIZZA
        : SYSTEM_PROMPT_TEXT;

    const chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages.slice(-10)
    ];

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 200
      })
    });

    const data = await openaiRes.json();
    const fullContent = data.choices?.[0]?.message?.content || "";
    const strippedContent = fullContent.replace("[openLeadForm]", "").replace("[showPizzaPopup]", "").trim();

    const triggerForm = fullContent.includes("[openLeadForm]");
    const triggerPizzaPopup = fullContent.includes("[showPizzaPopup]");

    // Сохраняем лог
    await fetch(GOOGLE_SHEET_WEBHOOK_LOGS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userId,
        dialog: messages.map(m => m.content).join("\n") + "\n" + strippedContent
      })
    });

    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: strippedContent,
            triggerForm,
            triggerPizzaPopup
          }
        }
      ]
    });
  } catch (e) {
    console.error("❌ GPT proxy error:", e);
    res.status(500).json({ error: "OpenAI Proxy error", details: e.message });
  }
});

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
        })
      });

      const data = await openaiRes.json();
      comment = data.choices?.[0]?.message?.content || comment;
    } catch (gptErr) {
      console.warn("⚠️ GPT ошибка:", gptErr.message);
    }

    // 1. Google Таблица
    await fetch(GOOGLE_SHEET_WEBHOOK_LEAD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, userId, comment })
    });

    // 2. Bitrix
    await fetch("https://b24-jddqhi.bitrix24.ru/rest/1/3xlf5g1t6ggm97xz/crm.lead.add.json", {
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

    res.json({ message: comment });
  } catch (err) {
    console.error("❌ Ошибка обработки формы:", err);
    res.status(500).json({ error: "Ошибка сервера при получении формы" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ GPT voice server запущен на порту", PORT);
});
