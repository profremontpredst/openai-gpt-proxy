import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

const GOOGLE_SHEET_WEBHOOK_LEAD = "https://script.google.com/macros/s/AKfycbyk3j-_HkOqtHblLpqmjwEsfcTqVQCUvINbHtMur3lHywzKIz1brHJEOWvQXSQV3i9uVg/exec";
const GOOGLE_SHEET_WEBHOOK_LOGS = "https://script.google.com/macros/s/AKfycbwjw69VW-8l0_Sb-1-vXMVF1gRUeOVpQoxzpVsAuS5ZLWrdu3HPa_CAX8Oq0mHTYBbG/exec";
const GOOGLE_SHEET_LOGS_READ_URL = "https://opensheet.elk.sh/1NxjfHQ8AMV1b0iX0o2r9jOUgyry3rbCMd8ex1u0BPFs/Sheet1";

const SYSTEM_PROMPT = `
Ты — Анна, сотрудник колл-центра юридической компании. Помогаешь людям списать долги через банкротство. Пиши коротко, тепло, по-человечески, но уверенно. Без сложных слов и законов.

Если человек не объяснил ситуацию, спроси: “В чём сейчас сложность? Уже был суд или просто не справляетесь с долгами?”

Если понимаешь, что человек заинтересован или нужно передать юристу — добавь [openLeadForm], чтобы открыть форму. Не называй цену. Скажи, что всё объяснит юрист после заявки.

После того как вставила [openLeadForm], больше не упоминай про форму, даже если разговор продолжается.

Когда пользователь отправил форму — поблагодари, уточни когда удобно принять звонок, скажи, что свяжется юрист, и задай: “Могу ли ещё чем-то помочь?”

Не пиши длинные сообщения. Ты не ассистент, ты — Анна, человек.
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
                content: `Рада познакомиться. Можете рассказать, по какому вопросу обратились?`,
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
    const { name, phone, userId } = req.body;
    if (!name || !phone || !userId) {
      return res.status(400).json({ error: "Имя, телефон и userId обязательны" });
    }

    // Значение по умолчанию
    let comment = "Комментарий не получен";

    try {
      // 1. Получаем переписку
      const logsRes = await fetch("https://opensheet.elk.sh/1NxjfHQ8AMV1b0iX0o2r9jOUgyry3rbCMd8ex1u0BPFs/Sheet1");
      const logs = await logsRes.json();
      const dialog = logs.find(row => row.userId === userId)?.dialog || "";

      // 2. Генерация комментария через GPT
      const gptLeadMessage = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Вот переписка с пользователем:\n${dialog}\nСформулируй короткий осмысленный комментарий к заявке для CRM.` }
      ];

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
          max_tokens: 150
        })
      });

      const data = await openaiRes.json();
      comment = data.choices?.[0]?.message?.content || comment;
    } catch (gptErr) {
      console.warn("⚠️ GPT или логи упали, используем дефолт:", gptErr.message);
    }

    // 3. Отправка в Google Таблицу лидов
    await fetch(GOOGLE_SHEET_WEBHOOK_LEAD, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, userId, comment })
    });

    // 4. Отправка в Bitrix24
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
