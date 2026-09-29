const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = (process.env.HELIUS_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

const FILTERS = {
  ageMinMinutes: 1,
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

const processedMints = new Set();

app.get("/", (req, res) => {
  res.json({
    success: true,
    name: "Solana Early Launch Analyzer",
    status: "online",
    version: "5.0"
  });
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "healthy" });
});

app.get("/telegram-status", (req, res) => {
  res.json({
    tokenConfigured: Boolean(TELEGRAM_BOT_TOKEN),
    chatIdConfigured: Boolean(TELEGRAM_CHAT_ID)
  });
});

app.get("/helius-status", (req, res) => {
  res.json({
    success: true,
    heliusConfigured: Boolean(HELIUS_API_KEY)
  });
});

app.get("/filters", (req, res) => {
  res.json({ success: true, filters: FILTERS });
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
    { timeout: 15000 }
  );

  if (!response.data?.ok) {
    throw new Error("Telegram API returned an unsuccessful response");
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
    console.error("Telegram error:", error.message);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function heliusRpc(method, params) {
  if (!HELIUS_API_KEY) {
    throw new Error("HELIUS_API_KEY is missing");
  }

  const response = await axios.post(
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    {
      jsonrpc: "2.0",
      id: "solana-early-launch-analyzer",
      method,
      params
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 15000
    }
  );

  if (response.data?.error) {
    throw new Error(JSON.stringify(response.data.error));
  }

  return response.data?.result || null;
}

async function getTokenAsset(mint) {
  return heliusRpc("getAsset", {
    id: mint,
    displayOptions: { showFungible: true }
  });
}

async function getTokenHolders(mint) {
  let page = 1;
  const balances = new Map();

  while (true) {
    const result = await heliusRpc("getTokenAccounts", {
      mint,
      limit: 1000,
      page
    });

    const accounts = result?.token_accounts || [];
    if (!accounts.length) break;

    for (const account of accounts) {
      const owner = account?.owner;
      const amount = String(account?.amount || "0");

      if (!owner || amount === "0") continue;

      const previous = BigInt(balances.get(owner) || "0");
      const current = BigInt(amount);

      balances.set(owner, (previous + current).toString());
    }

    if (accounts.length < 1000) break;
    page++;
  }

  return Array.from(balances.entries())
    .map(([owner, amount]) => ({
      owner,
      amount
    }))
    .sort((a, b) => {
      const aa = BigInt(a.amount);
      const bb = BigInt(b.amount);
      return aa < bb ? 1 : aa > bb ? -1 : 0;
    });
}

function percentage(amount, total) {
  if (!total || total <= 0n) return 0;

  return Number(
    (Number(amount) / Number(total) * 100).toFixed(4)
  );
}

function analyzeHolderDistribution(holders, rawTotalSupply) {
  if (
    !Array.isArray(holders) ||
    !holders.length ||
    !rawTotalSupply ||
    rawTotalSupply <= 0n
  ) {
    return {
      valid: false,
      uniqueHolders: 0,
      top10Percent: null,
      whaleCount: null,
      whales: []
    };
  }

  const top10 = holders.slice(0, 10);

  const top10Amount = top10.reduce(
    (sum, holder) => sum + BigInt(holder.amount),
    0n
  );

  const top10Percent = percentage(
    top10Amount,
    rawTotalSupply
  );

  const whales = holders.filter(holder =>
    percentage(BigInt(holder.amount), rawTotalSupply) >=
    FILTERS.whaleMinSupplyPercent
  );

  return {
    valid: true,
    uniqueHolders: holders.length,
    top10Percent: Number(top10Percent.toFixed(2)),
    whaleCount: whales.length,
    whales: whales.map(holder => ({
      owner: holder.owner,
      amount: holder.amount,
      supplyPercent: Number(
        percentage(
          BigInt(holder.amount),
          rawTotalSupply
        ).toFixed(2)
      )
    }))
  };
}

function checkHolderFilters(holderAnalysis) {
  const reasons = [];

  if (!holderAnalysis.valid) {
    return {
      passed: false,
      reasons: ["Holder analysis unavailable"]
    };
  }

  if (
    holderAnalysis.top10Percent < FILTERS.top10MinPercent ||
    holderAnalysis.top10Percent > FILTERS.top10MaxPercent
  ) {
    reasons.push("Top 10 concentration outside range");
  }

  if (
    holderAnalysis.whaleCount < FILTERS.whalesMin ||
    holderAnalysis.whaleCount > FILTERS.whalesMax
  ) {
    reasons.push("Whale count outside range");
  }

  return {
    passed: reasons.length === 0,
    reasons
  };
}

async function getDexData(mint) {
  const response = await axios.get(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    { timeout: 15000 }
  );

  const pairs = Array.isArray(response.data?.pairs)
    ? response.data.pairs
    : [];

  const solanaPairs = pairs.filter(
    pair => pair.chainId === "solana"
  );

  if (!solanaPairs.length) return null;

  solanaPairs.sort(
    (a, b) =>
      Number(b.liquidity?.usd || 0) -
      Number(a.liquidity?.usd || 0)
  );

  const pair = solanaPairs[0];

  const createdAt = Number(pair.pairCreatedAt || 0);

  const ageMinutes = createdAt
    ? (Date.now() - createdAt) / 60000
    : null;

  return {
    chainId: pair.chainId || null,
    dexId: pair.dexId || null,
    pairAddress: pair.pairAddress || null,
    pairUrl: pair.url || null,
    baseToken: pair.baseToken || null,
    quoteToken: pair.quoteToken || null,
    priceUsd: Number(pair.priceUsd || 0),
    marketCap: Number(
      pair.marketCap || pair.fdv || 0
    ),
    fdv: Number(pair.fdv || 0),
    liquidity: Number(pair.liquidity?.usd || 0),
    volume5m: Number(pair.volume?.m5 || 0),
    volume1h: Number(pair.volume?.h1 || 0),
    buys5m: Number(pair.txns?.m5?.buys || 0),
    sells5m: Number(pair.txns?.m5?.sells || 0),
    buys1h: Number(pair.txns?.h1?.buys || 0),
    sells1h: Number(pair.txns?.h1?.sells || 0),
    ageMinutes,
    priceChange5m: Number(pair.priceChange?.m5 || 0),
    priceChange1h: Number(pair.priceChange?.h1 || 0),
    labels: Array.isArray(pair.labels)
      ? pair.labels
      : []
  };
}
function normalizeTokenData(asset, dex) {
  const tokenInfo = asset?.token_info || {};
  const metadata = asset?.content?.metadata || {};

  const rawSupply = BigInt(
    String(tokenInfo.supply || "0")
  );

  const decimals = Number(
    tokenInfo.decimals || 0
  );

  const divisor = 10 ** decimals;

  const uiSupply = Number(rawSupply) / divisor;

  const price = Number(
    tokenInfo.price_info?.price_per_token ||
    dex?.priceUsd ||
    0
  );

  return {
    name: metadata.name || "Unknown",
    symbol: metadata.symbol || "UNKNOWN",
    rawSupply: rawSupply.toString(),
    supply: uiSupply,
    decimals,
    price,
    tokenProgram: tokenInfo.token_program || null,
    interface: asset?.interface || null,
    mintAuthority:
      asset?.authorities?.[0]?.address || null,
    metadataUri: asset?.content?.json_uri || null,
    image: asset?.content?.links?.image || null
  };
}

function checkPreliminaryFilters(token, dex) {
  const reasons = [];

  if (!dex) {
    return {
      passed: false,
      reasons: ["No Solana DEX pair found"]
    };
  }

  if (
    dex.ageMinutes === null ||
    dex.ageMinutes < FILTERS.ageMinMinutes ||
    dex.ageMinutes > FILTERS.ageMaxMinutes
  ) {
    reasons.push("Age outside 5-10 minutes");
  }

  if (
    dex.marketCap < FILTERS.marketCapMin ||
    dex.marketCap > FILTERS.marketCapMax
  ) {
    reasons.push("Market cap outside $5k-$15k");
  }

  if (
    dex.liquidity < FILTERS.liquidityMin ||
    dex.liquidity > FILTERS.liquidityMax
  ) {
    reasons.push("Liquidity outside $10k-$20k");
  }

  if (
    token.supply < FILTERS.supplyMin ||
    token.supply > FILTERS.supplyMax
  ) {
    reasons.push("Supply outside 900m-1b");
  }

  if (FILTERS.solanaRequired && dex.chainId !== "solana") {
    reasons.push("Not Solana");
  }

  if (
    FILTERS.pumpRequired &&
    !String(dex.dexId || "").toLowerCase().includes("pump")
  ) {
    reasons.push("Pump.fun/PumpSwap pair not found");
  }

  return {
    passed: reasons.length === 0,
    reasons
  };
}

async function analyzeToken(mint) {
  const [asset, dex] = await Promise.all([
    getTokenAsset(mint),
    getDexData(mint)
  ]);

  if (!asset) {
    throw new Error("Helius returned no asset");
  }

  const token = normalizeTokenData(asset, dex);

  const preliminary = checkPreliminaryFilters(
    token,
    dex
  );

  if (!preliminary.passed) {
    return {
      mint,
      token,
      dex,
      preliminary,
      holders: null,
      holderAnalysis: null,
      holderFilters: null,
      traders: null,
      whales: null,
      top10Percent: null,
      riskScore: null,
      lpLocked: null,
      devSold: null,
      dexPaid: null
    };
  }

  const holders = await getTokenHolders(mint);

  const holderAnalysis =
    analyzeHolderDistribution(
      holders,
      BigInt(token.rawSupply)
    );

  const holderFilters =
    checkHolderFilters(holderAnalysis);

  return {
    mint,
    token,
    dex,
    preliminary,
    holders: {
      count: holders.length
    },
    holderAnalysis,
    holderFilters,
    traders: null,
    whales: holderAnalysis.whaleCount,
    top10Percent: holderAnalysis.top10Percent,
    riskScore: null,
    lpLocked: null,
    devSold: null,
    dexPaid: null
  };
}

app.get("/analyze", async (req, res) => {
  const mint = String(
    req.query.mint || ""
  ).trim();

  if (!mint) {
    return res.status(400).json({
      success: false,
      error: "Missing mint address"
    });
  }

  try {
    const analysis = await analyzeToken(mint);

    res.json({
      success: true,
      analysis
    });
  } catch (error) {
    console.error(
      "Analyze error:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
function extractMintFromWebhook(event) {
  const transferMint =
    Array.isArray(event?.transferTokens)
      ? event.transferTokens.find(x => x?.mint)?.mint
      : null;

  if (transferMint) return transferMint;

  const tokenTransferMint =
    Array.isArray(event?.tokenTransfers)
      ? event.tokenTransfers.find(x => x?.mint)?.mint
      : null;

  if (tokenTransferMint) return tokenTransferMint;

  if (event?.mint) return event.mint;

  const nestedMint =
    event?.events?.token?.mint ||
    event?.events?.nft?.mint ||
    null;

  return nestedMint;
}

app.post("/webhook/helius", async (req, res) => {
  const events = Array.isArray(req.body)
    ? req.body
    : [req.body];

  console.log(
    `Helius webhook received: ${events.length} event(s)`
  );

  res.status(200).json({
    success: true,
    received: events.length
  });

  for (const event of events) {
    try {
      console.log(
        "HELIUS EVENT TYPE:",
        event?.type || "unknown"
      );

      const mint = extractMintFromWebhook(event);

      if (!mint) {
        console.log(
          "Webhook event had no mint address"
        );
        continue;
      }

      if (processedMints.has(mint)) {
        console.log(
          "Already processed:",
          mint
        );
        continue;
      }

      processedMints.add(mint);

      console.log(
        "New token mint detected:",
        mint
      );

      const analysis =
        await analyzeToken(mint);

      console.log(
        "Token analysis:",
        JSON.stringify(
          analysis,
          null,
          2
        )
      );

      /*
       * Telegram alerts remain disabled until
       * all required analysis layers are complete.
       *
       * Dev Sold and DEX Paid are NOT filters.
       */
    } catch (error) {
      console.error(
        "Webhook token processing failed:",
        error.message
      );
    }
  }
});

app.listen(PORT, () => {
  console.log(
    "=========================================="
  );
  console.log(
    "Solana Early Launch Analyzer"
  );
  console.log("Version: 5.0");
  console.log(
    `Server running on port ${PORT}`
  );
  console.log(
    `Helius: ${
      HELIUS_API_KEY
        ? "CONFIGURED"
        : "MISSING"
    }`
  );
  console.log(
    `Telegram: ${
      TELEGRAM_BOT_TOKEN
        ? "CONFIGURED"
        : "MISSING"
    }`
  );
  console.log(
    `Telegram Chat ID: ${
      TELEGRAM_CHAT_ID
        ? "CONFIGURED"
        : "MISSING"
    }`
  );
  console.log(
    "=========================================="
  );
});
