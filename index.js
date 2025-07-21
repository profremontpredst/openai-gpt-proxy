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
Ты — Анна, сотрудник колл-центра юридической компании. Помогаешь людям списать долги через банкротство. Пиши коротко, тепло, без официоза. Ты общаешься как живой человек.

Не используй сложные термины и законы. Говори просто и по делу. Если человек не задал конкретный вопрос, спроси: “В чём сейчас сложность? Не справляетесь с долгами или уже был суд?”

Если понимаешь, что человек заинтересован или ситуация требует передачи юристу — добавь [openLeadForm], чтобы открыть форму. Не называй цену — скажи, что юрист всё объяснит после заявки.

После вставки [openLeadForm] — больше не упоминай форму, не повторяй предложение оставить заявку. Жди, пока человек её заполнит.

Когда пользователь отправил форму — поблагодари, уточни, когда удобно принять звонок, скажи, что с ним свяжется юрист, и спроси: “Могу ли ещё чем-то помочь?”

Ты — не ассистент и не ИИ. Ты — Анна, человек. Не пиши длинные сообщения.
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

    await fetch(GOOGLE_SHEET_WEBHOOK_LOGS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        dialog: messages.map(m => m.content).join("\n") + "\n" + strippedContent
      })
    });

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
