const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

// ================== CONFIG ==================
const API_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
const DB_URL = "https://madara-62f7b-default-rtdb.firebaseio.com";
const CHECK_INTERVAL = 15000; // 15 sec pe check (save sirf naya result pe)

let lastKnownIssue = null;
let currentPrediction = {
  period: "----",
  prediction: "----",
  source: "Waiting",
  historyCount: 0
};

// ================== FIREBASE HELPERS ==================
async function loadHistory() {
  try {
    const res = await fetch(`${DB_URL}/wingo_results.json`);
    const data = await res.json();
    if (!data) return [];

    const list = Object.values(data);
    list.sort((a, b) => {
      try {
        return Number(BigInt(a.period) - BigInt(b.period));
      } catch {
        return String(a.period).localeCompare(String(b.period));
      }
    });
    return list;
  } catch (e) {
    console.log("Load history error:", e.message);
    return [];
  }
}

async function saveResult(item) {
  try {
    const key = String(item.period);
    await fetch(`${DB_URL}/wingo_results/${key}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        period: key,
        number: item.number,
        result: item.result
      })
    });
    console.log("Saved:", key, item.number);
  } catch (e) {
    console.log("Save error:", e.message);
  }
}

// ================== PREDICTION (UPAR WALA) ==================
function predict(historyNumbers) {
  if (!historyNumbers || historyNumbers.length < 2) {
    return { prediction: "BIG", source: "Not enough history" };
  }

  const latest = historyNumbers[historyNumbers.length - 1];
  const prevNumbers = [];

  // oldest → newest
  // jab number mile, uska PEHLE wala (upar wala) lo
  for (let i = 1; i < historyNumbers.length; i++) {
    if (historyNumbers[i] === latest) {
      prevNumbers.push(historyNumbers[i - 1]);
    }
  }

  if (prevNumbers.length === 0) {
    return { prediction: "BIG", source: "No previous matches" };
  }

  let big = 0;
  let small = 0;
  prevNumbers.forEach((n) => {
    if (n >= 5) big++;
    else small++;
  });

  let prediction;
  if (big > small) prediction = "BIG";
  else if (small > big) prediction = "SMALL";
  else prediction = latest >= 5 ? "SMALL" : "BIG"; // tie

  return {
    prediction,
    source: `Upar voting (${prevNumbers.length} matches)`
  };
}

// ================== WIN GO API (403 FIX HEADERS) ==================
async function fetchGameResults() {
  try {
    const res = await fetch(API_URL + "?ts=" + Date.now(), {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://draw.ar-lottery01.com/",
        "Origin": "https://draw.ar-lottery01.com"
      }
    });

    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    let list = [];
    if (data?.data?.list) list = data.data.list;
    else if (Array.isArray(data?.data)) list = data.data;
    else if (Array.isArray(data?.list)) list = data.list;
    else if (Array.isArray(data)) list = data;

    return list;
  } catch (e) {
    console.log("API error:", e.message);
    return null;
  }
}

function getIssue(item) {
  return item.issueNumber || item.issue || item.period || item.IssueNumber || "";
}
function getNumber(item) {
  const n = item.number ?? item.Number ?? item.result ?? item.Result ?? item.openNumber;
  return n !== undefined && n !== null ? Number(n) : null;
}

// ================== MAIN WORKER (sirf naya result pe) ==================
async function worker() {
  const list = await fetchGameResults();
  if (!list || list.length === 0) {
    console.log("No data from API");
    return;
  }

  // latest from API
  const sorted = [...list].sort((a, b) => {
    try {
      return Number(BigInt(getIssue(b)) - BigInt(getIssue(a)));
    } catch {
      return String(getIssue(b)).localeCompare(String(getIssue(a)));
    }
  });

  const latestItem = sorted[0];
  const issue = String(getIssue(latestItem));
  const number = getNumber(latestItem);

  if (!issue || number === null || isNaN(number)) return;

  // Agar same period hai to kuch mat karo
  if (issue === lastKnownIssue) {
    return;
  }

  // NAYA RESULT AAYA
  console.log("New result:", issue, number);
  lastKnownIssue = issue;

  // Firebase history load karo
  let history = await loadHistory();

  // Naya result save karo (agar pehle se nahi hai)
  const exists = history.some((h) => String(h.period) === issue);
  if (!exists) {
    const item = {
      period: issue,
      number: number,
      result: number >= 5 ? "BIG" : "SMALL"
    };
    await saveResult(item);
    history.push(item);
  }

  // sort again
  history.sort((a, b) => {
    try {
      return Number(BigInt(a.period) - BigInt(b.period));
    } catch {
      return String(a.period).localeCompare(String(b.period));
    }
  });

  // Next period prediction
  let nextPeriod;
  try {
    nextPeriod = String(BigInt(issue) + 1n);
  } catch {
    nextPeriod = String(Number(issue) + 1);
  }

  const numbers = history.map((h) => Number(h.number));
  const pred = predict(numbers);

  currentPrediction = {
    period: nextPeriod,
    prediction: pred.prediction,
    source: pred.source,
    historyCount: history.length,
    lastResult: number,
    lastIssue: issue
  };

  console.log("Prediction ready:", currentPrediction);
}

// ================== API FOR FRONTEND ==================
app.get("/", (req, res) => {
  res.json({
    status: "MADARA Backend Running",
    prediction: currentPrediction
  });
});

app.get("/predict", (req, res) => {
  res.json(currentPrediction);
});

app.get("/history-count", async (req, res) => {
  const history = await loadHistory();
  res.json({ count: history.length });
});

// ================== START ==================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  worker(); // pehli baar
  setInterval(worker, CHECK_INTERVAL);
});
