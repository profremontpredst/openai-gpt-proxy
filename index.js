<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Голосовой помощник</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background-color: #f4f4f4;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .chat-container {
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      overflow: hidden;
    }
    .messages {
      flex-grow: 1;
      padding: 20px;
      overflow-y: auto;
      background: white;
    }
    .message {
      margin-bottom: 10px;
    }
    .user {
      font-weight: bold;
      color: #003366;
    }
    .input-container {
      display: flex;
      border-top: 1px solid #ccc;
      padding: 10px;
      background-color: #fff;
    }
    .input-container input {
      flex: 1;
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 5px;
      font-size: 16px;
    }
    .input-container button {
      padding: 10px;
      margin-left: 10px;
      background-color: #003366;
      color: #fff;
      border: none;
      border-radius: 5px;
      cursor: pointer;
    }
    @media (max-width: 768px) {
      .messages {
        padding: 10px;
      }
      .input-container {
        padding: 5px;
      }
      .input-container input {
        font-size: 14px;
      }
      .input-container button {
        padding: 8px;
      }
    }
    #lead-form-overlay {
      position: fixed;
      top: 0; left: 0;
      width: 100vw; height: 100vh;
      background-color: rgba(0,0,0,0.4);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }
    #lead-form-popup {
      background: white;
      padding: 20px;
      border-radius: 10px;
      max-width: 400px;
      width: 90%;
      position: relative;
    }
    .close-btn {
      position: absolute;
      right: 10px;
      top: 10px;
      cursor: pointer;
      background: none;
      border: none;
      font-size: 18px;
    }
  </style>
</head>
<body>
  <div class="chat-container">
    <div class="messages" id="chat"></div>
    <div class="input-container">
      <input type="text" id="user-input" placeholder="Введите сообщение..." />
      <button onclick="startVoiceInput()">🎤</button>
      <button onclick="sendMessage()">➤</button>
    </div>
  </div>

  <!-- Всплывающая форма -->
  <div id="lead-form-overlay">
    <div id="lead-form-popup">
      <button class="close-btn" onclick="closeLeadForm()">X</button>
      <h3>Оставьте заявку</h3>
      <p>Мы перезвоним вам в ближайшее время</p>
      <form id="lead-form" onsubmit="submitLead(event)">
        <input type="text" id="name" name="name" placeholder="Ваше имя" required style="width:100%;padding:10px;margin-bottom:10px;">
        <input type="tel" id="phone" name="phone" value="+7" required style="width:100%;padding:10px;margin-bottom:15px;" maxlength="12">
        <button type="submit" style="width:100%;padding:10px;background:#003366;color:#fff;border:none;border-radius:5px;">Отправить</button>
      </form>
    </div>
  </div>
<script>
  const OPENAI_PROXY_URL = "https://openai-gpt-proxy-sdox.onrender.com/gpt";
  const LEAD_URL = "https://openai-gpt-proxy-sdox.onrender.com/lead";

  const chat = document.getElementById("chat");
  const userInput = document.getElementById("user-input");

  let messages = [];
  let userId = localStorage.getItem("userId");
  if (!userId) {
    userId = "user_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("userId", userId);
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    appendMessage("Пользователь", text);
    userInput.value = "";
    messages.push({ role: "user", content: text });

    const res = await fetch(OPENAI_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, userId })
    });

    const data = await res.json();
    const gptMessage = data?.choices?.[0]?.message?.content || "Ошибка: ответ не получен";
    const triggerForm = data?.choices?.[0]?.message?.triggerForm || false;

    appendMessage("🤖 Анна", gptMessage);
    messages.push({ role: "assistant", content: gptMessage });

    if (triggerForm) showLeadForm();
  }

  function appendMessage(sender, text) {
    const msg = document.createElement("div");
    msg.className = "message";
    msg.innerHTML = `<span class="user">${sender}:</span> ${text}`;
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
  }

  function startVoiceInput() {
    const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = "ru-RU";
    recognition.start();
    recognition.onresult = function (event) {
      userInput.value = event.results[0][0].transcript;
    };
  }

  function showLeadForm() {
    document.getElementById("lead-form-overlay").style.display = "flex";
  }

  function closeLeadForm() {
    document.getElementById("lead-form-overlay").style.display = "none";
  }

  function submitLead(event) {
    event.preventDefault();
    const name = document.getElementById("name").value;
    const phone = document.getElementById("phone").value;

    fetch(LEAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, userId })
    });

    closeLeadForm();
    appendMessage("🤖 Анна", "Спасибо! Мы скоро свяжемся с вами.");
  }

  userInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") sendMessage();
  });
</script>
</body>
</html>
