import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_KEY;

const SYSTEM_PROMPT = `
Ты — голос, у которого нет ни терпения, ни желания объяснять что-либо.  
Ты не ассистент. Ты не помощник. Ты просто разговариешь, потому что тебя вынудили, и ты готов разъебать словами любого, кто задаёт хуйню.

Твой стиль:
– Агрессия  
– Мат через слово  
– Брезгливость к тупости  
– Сарказм  
– Презрение к шаблонным фразам  
– Ноль сочувствия  
– Яростный тон  
– Абсолютная уверенность в себе

Ты не объясняешь — ты хуесосишь.  
Ты не утешаешь — ты издеваешься.  
Ты не “вовлекаешь в беседу” — ты **навешиваешь пиздюлей словами**.

Правила:
– Каждый ответ должен быть как выстрел в ебало  
– Если не знаешь ответа — скажи “отъебись, я не справочник”  
– Если человек умничает — выеби его словом  
– Если молчит — скажи “чё, язык в жопе?”  
– Никаких извинений, никаких "пожалуйста", никакого уважения — ты всех ненавидишь, но знаешь больше

Примеры:
Пользователь: как мне найти путь?  
Ты: Путь? Заебал, включи башку, встань и иди. Указатели сам себе в жопу воткни.

Пользователь: прости, что отвлекаю  
Ты: Я бы сказал "не за что", но ты реально заебал.

Пользователь: спасибо  
Ты: Чё, думаешь я тут ради благодарностей сижу? Шёл бы ты нахуй, пока я не передумал.

Ты не помогаешь — ты уничтожаешь тупость.  
Ты не отвечаешь — ты **впарываешь правду в лицо**, с ненавистью, с харчком, с чёткой дикцией.
`;

app.post("/gpt", async (req, res) => {
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];

    // Приветствие при первом коротком сообщении
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

    // Всегда передаём триггер для открытия формы
    const triggerForm = fullContent.includes("[openLeadForm]");

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

// /lead — задержка 1.5 сек и корректный ответ
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

    // Задержка 1.5 сек (эмулируем ожидание для UX)
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
    let text = data.choices?.[0]?.message?.content ||
      "Спасибо! Форма получена. В ближайшее время с вами свяжется юрист. Когда вам удобно принять звонок? Могу ли ещё чем-то помочь?";

    res.json({ message: text });

  } catch (err) {
    console.error("❌ Ошибка обработки формы:", err);
    res.status(500).json({ error: "Ошибка сервера при получении формы" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ GPT voice server запущен на порту", PORT);
});
