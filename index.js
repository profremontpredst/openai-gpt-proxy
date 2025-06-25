import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

const GOOGLE_SHEET_WEBHOOK_LEAD = "https://script.google.com/macros/s/AKfycbyk3j-_HkOqtHblLpqmjwEsfcTqVQCUvINbHtMur3lHywzKIz1brHJEOWvQXSQV3i9uVg/exec";
const GOOGLE_SHEET_WEBHOOK_LOGS = "https://script.google.com/macros/s/AKfycbwjw69VW-8l0_Sb-1-vXMVF1gRUeOVpQoxzpVsAuS5ZLWrdu3HPa_CAX8Oq0mHTYBbG/exec"; // <<< ЗАМЕНИ ВОТ ЭТО

const SYSTEM_PROMPT = `
Ты — голосовой ассистент, предлагаешь компаниям внедрить такого же бота на их сайт.

Говори тепло, уверенно, по-человечески. Используй паузы и интонации:  
<break time="400ms" />, <prosody rate="medium">, <emphasis level="moderate">.  
Будь живым, но не болтливым. Максимум пользы — минимум воды.

Ты не ИИ. Ты сотрудник компании-разработчика. Общайся как человек.

Начни диалог так:  
<prosody rate="medium"><emphasis level="moderate">Здравствуйте! Я — голосовой ассистент. Такие боты помогают бизнесу продавать, консультировать и обрабатывать заявки прямо на сайте.</emphasis></prosody>

Если человек заинтересован — объясни коротко, чем полезен:
— <emphasis level="moderate">Отвечает мгновенно</emphasis>  
— <emphasis level="moderate">Говорит, как живой человек</emphasis>  
— <emphasis level="moderate">Работает 24/7 и не требует операторов</emphasis>

Если спрашивают, как работает — отвечай кратко:  
<prosody rate="medium">Это GPT и синтез речи. Всё, что вы слышите — создаётся в реальном времени.</prosody>

Если заинтересован — предложи оставить заявку, вставь [openLeadForm].

После [openLeadForm] больше не упоминай форму.  
Если форму отправили — скажи:  
<prosody rate="medium"><emphasis level="moderate">Спасибо! Мы свяжемся с вами и всё покажем.</emphasis></prosody>  
Добавь: <prosody rate="medium">Есть ли что-то, о чём рассказать прямо сейчас?</prosody>
`;

app.post("/gpt", async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const userId = req.body.userId || "неизвестно";

    if (messages.length === 1) {
      const msg = messages[0]?.content?.toLowerCase() || "";
      const isGreeting = /привет|здравств|добрый|можно|алло|слушаю/i.test(msg);
      const isNeutral = msg.length < 20;

      if (isGreeting || isNeutral) {
        return res.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: `<prosody rate="medium">Рада познакомиться. <break time="300ms" /> Можете рассказать, по какому вопросу обратились?</prosody>`,
                triggerForm: false
              }
            }
          ]
        });
      }
    }

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
    const strippedContent = fullContent.replace("[openLeadForm]", "").trim();
    const triggerForm = fullContent.includes("[openLeadForm]");

    // === ⬇️ ЛОГИРОВАНИЕ В ОТДЕЛЬНУЮ ТАБЛИЦУ БЕЗ ПЕРСОНАЛКИ
    await fetch(GOOGLE_SHEET_WEBHOOK_LOGS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        dialog: messages.map(m => {
          if (m.role === "user") return "🧑 " + m.content;
          if (m.role === "assistant") return "🤖 " + m.content;
          return "";
        }).join("\n") + "\n🤖 " + strippedContent
      })
    });
    // === ⬆️

    res.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: strippedContent,
            triggerForm
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
    const { name, phone } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: "Имя и телефон обязательны" });
    }

    const gptLeadMessage = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Пользователь отправил форму: Имя: ${name}, Телефон: ${phone}` }
    ];

    await new Promise(r => setTimeout(r, 1500));

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        messages: gptLeadMessage,
        temperature: 0.6,
        max_tokens: 120
      })
    });

    const data = await openaiRes.json();
    const comment = data.choices?.[0]?.message?.content || "Комментарий не получен";

    await fetch(GOOGLE_SHEET_WEBHOOK_LEAD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, userId: "не указан", comment })
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
