const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
const HELIUS_API_KEY = (process.env.HELIUS_API_KEY || "").trim();

const FILTERS = {
  ageMinMinutes: 5,
  ageMaxMinutes: 10,

  marketCapMin: 500,
  marketCapMax: 5000,

  liquidityMin: 10000,
  liquidityMax: 20000,

  tradersMin: 100,
  tradersMax: 500,

  whalesMin: 3,
  whalesMax: 5,

  top10MinPercent: 35,
  top10MaxPercent: 40,

  supplyMin: 900_000_000,
  supplyMax: 1_000_000_000,

  riskMin: 40,
  riskMax: 55,

  lpLockedRequired: true,
  solanaRequired: true,
  pumpRequired: true,

  whaleMinSupplyPercent: 1
};

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Solana Early Launch Analyzer",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy"
  });
});

app.get("/telegram-status", (req, res) => {
  res.json({
    tokenConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    chatIdConfigured: Boolean(TELEGRAM_CHAT_ID),
    tokenLength: TELEGRAM_BOT_TOKEN.length,
    chatIdLength: TELEGRAM_CHAT_ID.length
  });
});

app.get("/helius-status", (req, res) => {
  res.json({
    success: true,
    heliusConfigured: Boolean(HELIUS_API_KEY)
  });
});

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Telegram environment variables are missing");
  }

  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await axios.post(
    url,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    },
    {
      timeout: 10000
    }
  );

  if (!response.data?.ok) {
    throw new Error(
      `Telegram API error: ${JSON.stringify(response.data)}`
    );
  }

  return response.data;
}

app.get("/test-telegram", async (req, res) => {
  try {
    await sendTelegram(
      "✅ Solana Early Launch Analyzer Telegram test successful."
    );

    res.json({
      success: true,
      message: "Telegram message sent"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/analyze", async (req, res) => {
  const mint = String(req.query.mint || "").trim();

  if (!mint) {
    return res.status(400).json({
      success: false,
      error: "Missing mint address"
    });
  }

  res.json({
    success: true,
    message: "Analysis engine endpoint ready",
    mint,
    filters: FILTERS
  });
});

app.post("/webhook/helius", async (req, res) => {
  try {
    console.log("Helius webhook received:", JSON.stringify(req.body));

    res.json({
      success: true,
      received: true
    });
  } catch (error) {
    console.error("Webhook error:", error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("==========================================");
  console.log("Solana Early Launch Analyzer");
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Helius API key: ${HELIUS_API_KEY ? "CONFIGURED" : "MISSING"}`
  );
  console.log(
    `Telegram bot: ${TELEGRAM_BOT_TOKEN ? "CONFIGURED" : "MISSING"}`
  );
  console.log(
    `Telegram chat ID: ${TELEGRAM_CHAT_ID ? "CONFIGURED" : "MISSING"}`
  );
  console.log("==========================================");
});
