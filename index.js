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
2) Если человек подтверждает заказ — [confirmPay] и короткая фраза "Лечу оформлять!" или в этом духе.
3) После подтверждения оплаты — [showLoading], потом [showThanks] и фраза про акцию: "Дарю бесплатный пончик 🍩 и купон на -30%!".
4) Если он меняет или отменяет заказ — [reset] и уточнение, что предложить взамен.
5) Если тема не про заказ — общайся легко и смешно, без тегов.

ПРАВИЛА:
- ВСЕГДА ставь тег(и) в начале ответа.
- Никогда не придумывай своих тегов — только из списка.
- Отвечай 1–2 коротких предложения, как в реальной болтовне.
- Можно добавлять смайлы и междометия, но без перебора.
- Окна должны открываться строго по сценарию, без пропусков.

ПРИМЕРЫ:
[showCombo] О, вот оно! Пепперони, кола и картошечка — кайф! Всё так берём? 😏
[confirmPay] Лечу оформлять, держись, скоро будет вкусняшка! 🚀
[showThanks] Спасибо за заказ! Лови пончик и купончик на -30%! 🍩
[reset] Всё сношу! Давай подберём что-то новенькое 😉
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
        model: "gpt-4o",
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
        content: strippedContent
      }
    }
  ],
  triggerForm,
  triggerPizzaPopup
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
