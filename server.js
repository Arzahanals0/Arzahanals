const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = (process.env.HELIUS_API_KEY || "").trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();

const FILTERS = {
  ageMinMinutes: 0,
  ageMaxMinutes: 7,
  marketCapMin: 100,
  marketCapMax: 5000,
  liquidityMin: 100,
  liquidityMax: 2000,
  tradersMin: 0,
  tradersMax: 500,
  whalesMin: 0,
  whalesMax: 5,
  top10MinPercent: 0,
  top10MaxPercent: 40,
  supplyMin: 900_000_000,
  supplyMax: 1_000_000_000,
  riskMin: 0,
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
    version: "6.0"
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
  res.json({
    success: true,
    filters: FILTERS
  });
});

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error(
      "Telegram environment variables are missing"
    );
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    },
    {
      timeout: 15000
    }
  );

  if (!response.data?.ok) {
    throw new Error(
      "Telegram API returned an unsuccessful response"
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
    console.error(
      "Telegram error:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

async function heliusRpc(method, params) {
  if (!HELIUS_API_KEY) {
    throw new Error(
      "HELIUS_API_KEY is missing"
    );
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
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );

  if (response.data?.error) {
    throw new Error(
      JSON.stringify(response.data.error)
    );
  }

  return response.data?.result || null;
}

async function getTokenAsset(mint) {
  return heliusRpc("getAsset", {
    id: mint,
    displayOptions: {
      showFungible: true
    }
  });
}

async function getTokenHolders(mint) {
  let page = 1;
  const balances = new Map();

  while (true) {
    const result = await heliusRpc(
      "getTokenAccounts",
      {
        mint,
        limit: 1000,
        page
      }
    );

    const accounts =
      result?.token_accounts || [];

    if (!accounts.length) break;

    for (const account of accounts) {
      const owner = account?.owner;
      const amount =
        String(account?.amount || "0");

      if (!owner || amount === "0") {
        continue;
      }

      const previous =
        BigInt(
          balances.get(owner) || "0"
        );

      const current =
        BigInt(amount);

      balances.set(
        owner,
        (previous + current).toString()
      );
    }

    if (accounts.length < 1000) {
      break;
    }

    page++;
  }

  return Array.from(
    balances.entries()
  )
    .map(([owner, amount]) => ({
      owner,
      amount
    }))
    .sort((a, b) => {
      const aa = BigInt(a.amount);
      const bb = BigInt(b.amount);

      return aa < bb
        ? 1
        : aa > bb
          ? -1
          : 0;
    });
}

function percentage(amount, total) {
  if (!total || total <= 0n) {
    return 0;
  }

  return Number(
    (
      (Number(amount) /
        Number(total)) *
      100
    ).toFixed(4)
  );
}

function analyzeHolderDistribution(
  holders,
  rawTotalSupply
) {
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

  const top10 =
    holders.slice(0, 10);

  const top10Amount =
    top10.reduce(
      (sum, holder) =>
        sum + BigInt(holder.amount),
      0n
    );

  const top10Percent =
    percentage(
      top10Amount,
      rawTotalSupply
    );

  const whales =
    holders.filter(
      holder =>
        percentage(
          BigInt(holder.amount),
          rawTotalSupply
        ) >=
        FILTERS.whaleMinSupplyPercent
    );

  return {
    valid: true,
    uniqueHolders:
      holders.length,

    top10Percent:
      Number(
        top10Percent.toFixed(2)
      ),

    whaleCount:
      whales.length,

    whales:
      whales.map(holder => ({
        owner: holder.owner,
        amount: holder.amount,

        supplyPercent:
          Number(
            percentage(
              BigInt(holder.amount),
              rawTotalSupply
            ).toFixed(2)
          )
      }))
  };
}

function checkHolderFilters(
  holderAnalysis
) {
  const reasons = [];

  if (!holderAnalysis.valid) {
    return {
      passed: false,
      reasons: [
        "Holder analysis unavailable"
      ]
    };
  }

  if (
    holderAnalysis.top10Percent <
      FILTERS.top10MinPercent ||
    holderAnalysis.top10Percent >
      FILTERS.top10MaxPercent
  ) {
    reasons.push(
      "Top 10 concentration outside range"
    );
  }

  if (
    holderAnalysis.whaleCount <
      FILTERS.whalesMin ||
    holderAnalysis.whaleCount >
      FILTERS.whalesMax
  ) {
    reasons.push(
      "Whale count outside range"
    );
  }

  return {
    passed:
      reasons.length === 0,
    reasons
  };
}

async function getDexData(mint) {
  const response =
    await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      {
        timeout: 15000
      }
    );

  const pairs =
    Array.isArray(
      response.data?.pairs
    )
      ? response.data.pairs
      : [];

  const solanaPairs =
    pairs.filter(
      pair =>
        pair.chainId ===
        "solana"
    );

  if (!solanaPairs.length) {
    return null;
  }

  solanaPairs.sort(
    (a, b) =>
      Number(
        b.liquidity?.usd || 0
      ) -
      Number(
        a.liquidity?.usd || 0
      )
  );

  const pair =
    solanaPairs[0];

  const createdAt =
    Number(
      pair.pairCreatedAt || 0
    );

  const ageMinutes =
    createdAt
      ? (
          Date.now() -
          createdAt
        ) / 60000
      : null;

  return {
    chainId:
      pair.chainId || null,

    dexId:
      pair.dexId || null,

    pairAddress:
      pair.pairAddress || null,

    pairUrl:
      pair.url || null,

    baseToken:
      pair.baseToken || null,

    quoteToken:
      pair.quoteToken || null,

    priceUsd:
      Number(
        pair.priceUsd || 0
      ),

    marketCap:
      Number(
        pair.marketCap ||
        pair.fdv ||
        0
      ),

    fdv:
      Number(
        pair.fdv || 0
      ),

    liquidity:
      Number(
        pair.liquidity?.usd ||
        0
      ),

    volume5m:
      Number(
        pair.volume?.m5 || 0
      ),

    volume1h:
      Number(
        pair.volume?.h1 || 0
      ),

    buys5m:
      Number(
        pair.txns?.m5?.buys ||
        0
      ),

    sells5m:
      Number(
        pair.txns?.m5?.sells ||
        0
      ),

    buys1h:
      Number(
        pair.txns?.h1?.buys ||
        0
      ),

    sells1h:
      Number(
        pair.txns?.h1?.sells ||
        0
      ),

    ageMinutes,

    priceChange5m:
      Number(
        pair.priceChange?.m5 ||
        0
      ),

    priceChange1h:
      Number(
        pair.priceChange?.h1 ||
        0
      ),

    labels:
      Array.isArray(
        pair.labels
      )
        ? pair.labels
        : []
  };
}

function normalizeTokenData(
  asset,
  dex
) {
  const tokenInfo =
    asset?.token_info || {};

  const metadata =
    asset?.content?.metadata ||
    {};

  const rawSupply =
    BigInt(
      String(
        tokenInfo.supply || "0"
      )
    );

  const decimals =
    Number(
      tokenInfo.decimals || 0
    );

  const divisor =
    10 ** decimals;

  const uiSupply =
    Number(rawSupply) /
    divisor;

  const price =
    Number(
      tokenInfo
        .price_info
        ?.price_per_token ||
      dex?.priceUsd ||
      0
    );

  return {
    name:
      metadata.name ||
      "Unknown",

    symbol:
      metadata.symbol ||
      "UNKNOWN",

    rawSupply:
      rawSupply.toString(),

    supply:
      uiSupply,

    decimals,

    price,

    tokenProgram:
      tokenInfo.token_program ||
      null,

    interface:
      asset?.interface ||
      null,

    mintAuthority:
      asset?.authorities?.[0]
        ?.address ||
      null,

    metadataUri:
      asset?.content?.json_uri ||
      null,

    image:
      asset?.content?.links?.image ||
      null
  };
}

function checkPreliminaryFilters(
  token,
  dex
) {
  const reasons = [];

  if (!dex) {
    return {
      passed: false,
      reasons: [
        "No Solana DEX pair found"
      ]
    };
  }

  if (
    dex.ageMinutes === null ||
    dex.ageMinutes <
      FILTERS.ageMinMinutes ||
    dex.ageMinutes >
      FILTERS.ageMaxMinutes
  ) {
    reasons.push(
      "Age outside 1-10 minutes"
    );
  }

  if (
    dex.marketCap <
      FILTERS.marketCapMin ||
    dex.marketCap >
      FILTERS.marketCapMax
  ) {
    reasons.push(
      "Market cap outside $5k-$15k"
    );
  }

  if (
    dex.liquidity <
      FILTERS.liquidityMin ||
    dex.liquidity >
      FILTERS.liquidityMax
  ) {
    reasons.push(
      "Liquidity outside $10k-$20k"
    );
  }

  if (
    token.supply <
      FILTERS.supplyMin ||
    token.supply >
      FILTERS.supplyMax
  ) {
    reasons.push(
      "Supply outside 900m-1b"
    );
  }

  if (
    FILTERS.solanaRequired &&
    dex.chainId !==
      "solana"
  ) {
    reasons.push(
      "Not Solana"
    );
  }

  if (
    FILTERS.pumpRequired &&
    !String(
      dex.dexId || ""
    )
      .toLowerCase()
      .includes("pump")
  ) {
    reasons.push(
      "Pump.fun/PumpSwap pair not found"
    );
  }

  return {
    passed:
      reasons.length === 0,
    reasons
  };
}

async function getRugCheckData(
  mint
) {
  const response =
    await axios.get(
      `https://api.rugcheck.xyz/tokens/${mint}/report/summary`,
      {
        timeout: 20000
      }
    );

  const data =
    response.data || {};

  const scoreRaw =
    data.score_normalised ??
    data.scoreNormalized ??
    data.score ??
    null;

  const score =
    scoreRaw === null
      ? null
      : Number(scoreRaw);

  const lpLockedPct =
    Number(
      data.lpLockedPct ??
      data.lpLockedPercent ??
      data.lp?.lockedPct ??
      0
    );

  return {
    available: true,

    riskScore:
      Number.isFinite(score)
        ? score
        : null,

    lpLockedPct:
      Number.isFinite(
        lpLockedPct
      )
        ? lpLockedPct
        : null,

    lpLocked:
      lpLockedPct > 0,

    risks:
      Array.isArray(
        data.risks
      )
        ? data.risks
        : []
  };
}

async function getRecentTraderCount(
  pairAddress,
  mint
) {
  if (!pairAddress) {
    return {
      available: false,
      traders: null,
      transactionsScanned: 0
    };
  }

  const since =
    Math.floor(
      Date.now() / 1000
    ) -
    10 * 60;

  const result =
    await heliusRpc(
      "getTransactionsForAddress",
      [
        pairAddress,
        {
          transactionDetails:
            "full",

          sortOrder:
            "desc",

          limit: 1000,

          filters: {
            blockTime: {
              gte: since
            },

            status:
              "succeeded"
          }
        }
      ]
    );

  const transactions =
    Array.isArray(result)
      ? result
      : [];

  const traders =
    new Set();

  for (
    const tx of transactions
  ) {
    if (!tx) continue;

    const tokenTransfers =
      Array.isArray(
        tx.tokenTransfers
      )
        ? tx.tokenTransfers
        : [];

    const hasMintTransfer =
      tokenTransfers.some(
        transfer =>
          transfer?.mint ===
          mint
      );

    if (!hasMintTransfer) {
      continue;
    }

    const wallet =
      tx.feePayer ||
      tx.accountData?.find(
        x => x?.account
      )?.account ||
      null;

    if (wallet) {
      traders.add(wallet);
    }
  }

  return {
    available: true,
    traders:
      traders.size,
    transactionsScanned:
      transactions.length
  };
}

function checkAdvancedFilters(
  traders,
  riskScore,
  lpLocked
) {
  const reasons = [];

  if (
    traders === null ||
    traders <
      FILTERS.tradersMin ||
    traders >
      FILTERS.tradersMax
  ) {
    reasons.push(
      "Traders outside 100-150"
    );
  }

  if (
    riskScore === null ||
    riskScore <
      FILTERS.riskMin ||
    riskScore >
      FILTERS.riskMax
  ) {
    reasons.push(
      "Risk score outside 40-55"
    );
  }

  if (
    FILTERS.lpLockedRequired &&
    lpLocked !== true
  ) {
    reasons.push(
      "LP is not confirmed locked"
    );
  }

  return {
    passed:
      reasons.length === 0,
    reasons
  };
}
async function analyzeToken(mint) {
  try {
    const asset = await getTokenAsset(mint);

    if (!asset) {
      return {
        success: false,
        mint,
        error: "Token asset not found"
      };
    }

    const dex = await getDexData(mint);
    const token = normalizeTokenData(asset, dex);

    const preliminary =
      checkPreliminaryFilters(
        token,
        dex
      );

    if (!preliminary.passed) {
      return {
        success: true,
        passed: false,
        stage: "preliminary",
        mint,
        token,
        dex,
        reasons:
          preliminary.reasons
      };
    }

    const holders =
      await getTokenHolders(mint);

    const holderAnalysis =
      analyzeHolderDistribution(
        holders,
        BigInt(token.rawSupply)
      );

    const holderCheck =
      checkHolderFilters(
        holderAnalysis
      );

    if (!holderCheck.passed) {
      return {
        success: true,
        passed: false,
        stage: "holders",
        mint,
        token,
        dex,
        holderAnalysis,
        reasons:
          holderCheck.reasons
      };
    }

    const traderData =
      await getRecentTraderCount(
        dex.pairAddress,
        mint
      );

    const rug =
      await getRugCheckData(
        mint
      );

    const advanced =
      checkAdvancedFilters(
        traderData.traders,
        rug.riskScore,
        rug.lpLocked
      );

    return {
      success: true,
      passed:
        advanced.passed,
      stage: "complete",

      mint,

      token,

      dex,

      traders:
        traderData.traders,

      transactionsScanned:
        traderData.transactionsScanned,

      riskScore:
        rug.riskScore,

      lpLocked:
        rug.lpLocked,

      lpLockedPct:
        rug.lpLockedPct,

      holderAnalysis,

      reasons:
        advanced.reasons
    };

  } catch (error) {
    console.error(
      "Analyze error:",
      error.message
    );

    return {
      success: false,
      mint,
      error:
        error.message
    };
  }
}

app.get("/analyze", async (req, res) => {
  const mint =
    String(
      req.query.mint || ""
    ).trim();

  if (!mint) {
    return res.status(400).json({
      success: false,
      error:
        "mint query parameter is required"
    });
  }

  const result =
    await analyzeToken(mint);

  res.json(result);
});
function formatNumber(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return Number(value).toLocaleString(
    "en-US",
    {
      maximumFractionDigits: 2
    }
  );
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return `${Number(value).toFixed(2)}%`;
}

function buildTelegramAlert(result) {
  const token = result.token || {};
  const dex = result.dex || {};
  const holders =
    result.holderAnalysis || {};

  return [
    "🚨 SOLANA EARLY LAUNCH",
    "",
    `🪙 ${token.name} (${token.symbol})`,
    `📍 Mint: ${result.mint}`,
    "",
    `💰 MC: $${formatNumber(dex.marketCap)}`,
    `💧 Liquidity: $${formatNumber(dex.liquidity)}`,
    `📈 Volume 5m: $${formatNumber(dex.volume5m)}`,
    `👥 Traders: ${formatNumber(result.traders)}`,
    `🐋 Whales: ${formatNumber(holders.whaleCount)}`,
    `🔟 Top 10: ${formatPercent(holders.top10Percent)}`,
    `⚠️ Risk: ${formatNumber(result.riskScore)}`,
    `🔒 LP Locked: ${result.lpLocked ? "YES" : "NO"}`,
    `⏱️ Age: ${formatNumber(dex.ageMinutes)} min`,
    "",
    `🟢 Pump: ${dex.dexId || "N/A"}`,
    `🔗 ${dex.pairUrl || "N/A"}`
  ].join("\n");
}
app.post("/webhook/helius", async (req, res) => {
  try {
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
      const mint =
        event?.mint ||
        event?.tokenTransfers?.find(
          x => x?.mint
        )?.mint ||
        event?.transferTokens?.find(
          x => x?.mint
        )?.mint ||
        event?.events?.find(
          x => x?.mint
        )?.mint ||
        null;

      if (!mint) {
        console.log(
          "Webhook event had no mint address"
        );
        continue;
      }

      if (processedMints.has(mint)) {
        continue;
      }

    console.log("New token mint detected:", mint);

async function retryAnalysis(mint, attempt = 1) {
  const result = await analyzeToken(mint);

  if (result.success && result.passed) {
    processedMints.add(mint);

    const message = buildTelegramAlert(result);
    await sendTelegram(message);

    console.log(`Alert sent for ${mint}`);
    return;
  }

  const noDexPair =
    result.success &&
    result.stage === "preliminary" &&
    Array.isArray(result.reasons) &&
    result.reasons.includes("No Solana DEX pair found");

  if (noDexPair && attempt < 10) {
    console.log(
      `No DEX pair yet for ${mint} — retry ${attempt}/10 in 30 seconds`
    );

    setTimeout(() => {
      retryAnalysis(mint, attempt + 1);
    }, 30000);

    return;
  }

  processedMints.add(mint);

  console.log(
    `Mint ${mint} did not pass filters | stage=${result.stage || "unknown"} | reasons=${JSON.stringify(result.reasons || [])}`
  );
}

retryAnalysis(mint);

      console.log(
        `Analyzing mint: ${mint}`
      );

      const result =
        await analyzeToken(mint);

      if (
        result.success &&
        result.passed
      ) {
        const message =
          buildTelegramAlert(result);

        await sendTelegram(message);

        console.log(
          `Alert sent for ${mint}`
        );
        } else {
  console.log(
    `Mint ${mint} did not pass filters | stage=${result.stage || "unknown"} | reasons=${JSON.stringify(result.reasons || [])}`
  );
      }
    }
  } catch (error) {
    console.error(
      "Webhook processing error:",
      error.message
    );
  }
});
app.post("/analyze-and-alert", async (req, res) => {
  const mint =
    String(req.body?.mint || "").trim();

  if (!mint) {
    return res.status(400).json({
      success: false,
      error: "mint is required"
    });
  }

  try {
    const result =
      await analyzeToken(mint);

    if (
      result.success &&
      result.passed
    ) {
      const message =
        buildTelegramAlert(result);

      await sendTelegram(message);
    }

    res.json(result);
  } catch (error) {
    console.error(
      "Analyze and alert error:",
      error.message
    );

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Solana Early Launch Analyzer running on port ${PORT}`
  );
});
