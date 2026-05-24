require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// ========================================
// eBay デバッグ（原因調査用）
// ========================================
app.get('/api/ebay-debug', async (req, res) => {
  const keyword = req.query.keyword || 'Canon camera';
  const encoded = encodeURIComponent(keyword);
  const appId = process.env.EBAY_APP_ID || '(未設定)';
  const url = [
    'https://svcs.ebay.com/services/search/FindingService/v1',
    '?OPERATION-NAME=findCompletedItems',
    '&SERVICE-VERSION=1.0.0',
    `&SECURITY-APPNAME=${appId}`,
    '&RESPONSE-DATA-FORMAT=JSON',
    `&keywords=${encoded}`,
    '&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true',
    '&sortOrder=EndTimeSoonest',
    '&paginationInput.entriesPerPage=3'
  ].join('');
  try {
    const ebayRes = await fetch(url);
    const text = await ebayRes.text();
    res.json({ appIdSet: appId !== '(未設定)', appIdPrefix: appId.substring(0, 8), url: url.replace(appId, '***'), raw: text.substring(0, 2000) });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ========================================
// 店頭モード API：eBay価格 + ヤフオク検索
// ========================================
app.get('/api/ebay', async (req, res) => {
  const keyword = req.query.keyword;
  if (!keyword) return res.json({ error: 'keyword required' });

  try {
    const encoded = encodeURIComponent(keyword);
    const ebayUrl = [
      'https://svcs.ebay.com/services/search/FindingService/v1',
      '?OPERATION-NAME=findCompletedItems',
      '&SERVICE-VERSION=1.0.0',
      `&SECURITY-APPNAME=${process.env.EBAY_APP_ID}`,
      '&RESPONSE-DATA-FORMAT=JSON',
      `&keywords=${encoded}`,
      '&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true',
      '&sortOrder=EndTimeSoonest',
      '&paginationInput.entriesPerPage=20'
    ].join('');

    // 為替レート取得
    let rate = 150;
    try {
      const fx = await fetch('https://open.er-api.com/v6/latest/USD');
      const fxData = await fx.json();
      rate = Math.round(fxData.rates.JPY);
    } catch (e) {}

    // eBay価格取得
    const ebayRes  = await fetch(ebayUrl);
    const ebayData = await ebayRes.json();
    const items    = ebayData?.findCompletedItemsResponse?.[0]
                              ?.searchResult?.[0]?.item || [];

    const prices = items
      .map(i => parseFloat(i.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.__value__ || 0))
      .filter(p => p > 0);

    const avg = prices.length > 0
      ? Math.round((prices.reduce((a,b) => a+b, 0) / prices.length) * rate)
      : 0;

    // ヤフオク検索
    let yahoo = [];
    if (process.env.YAHOO_APP_ID) {
      try {
        const yahooUrl = `https://auctions.yahooapis.jp/AuctionWebService/V2/json/search?appid=${process.env.YAHOO_APP_ID}&query=${encoded}&output=json&hits=5&sort=end`;
        const yahooRes  = await fetch(yahooUrl);
        const yahooData = await yahooRes.json();
        const yahooItems = yahooData?.ResultSet?.Result?.Item || [];
        yahoo = (Array.isArray(yahooItems) ? yahooItems : [yahooItems]).map(item => ({
          title:    item.Title,
          price:    item.CurrentPrice,
          bids:     item.Bids || 0,
          timeLeft: item.EndTime ? new Date(item.EndTime).toLocaleDateString('ja-JP') : '不明',
          url:      item.AuctionItemUrl
        }));
      } catch (e) {}
    }

    res.json({ avg, count: prices.length, rate, yahoo });
  } catch (e) {
    res.json({ error: e.message, avg: 0, count: 0, yahoo: [] });
  }
});

// ========================================
// 自動仕入れスキャン API
// ========================================
const SCAN_TARGETS = [
  // カメラ本体（人気4種に絞る）
  { category: 'カメラ', keyword: 'Canon EOS R6 body',        buyMax: 180000 },
  { category: 'カメラ', keyword: 'Sony A7III body',           buyMax: 160000 },
  { category: 'カメラ', keyword: 'Fujifilm X-T4 body',       buyMax: 130000 },
  { category: 'カメラ', keyword: 'Ricoh GR IIIx',            buyMax: 80000  },
  // レンズ
  { category: 'レンズ', keyword: 'Leica Summicron 50mm',     buyMax: 120000 },
  { category: 'レンズ', keyword: 'Voigtlander 35mm f1.4 VM',buyMax: 60000  },
  // レトロゲーム
  { category: 'レトロゲーム', keyword: 'Nintendo Game Boy original',  buyMax: 5000  },
  { category: 'レトロゲーム', keyword: 'Neo Geo Pocket Color',        buyMax: 15000 },
  // 腕時計
  { category: '腕時計', keyword: 'Seiko 5 vintage automatic',        buyMax: 15000 },
  { category: '腕時計', keyword: 'Casio G-Shock DW-5600 vintage',    buyMax: 8000  },
  // ポケモンカード
  { category: 'ポケカ', keyword: 'Pokemon card Japanese Charizard holo', buyMax: 5000 },
  { category: 'ポケカ', keyword: 'Pokemon card Japanese booster box',    buyMax: 8000 },
  // ビンテージオーディオ
  { category: 'オーディオ', keyword: 'Sony Walkman TPS-L2',          buyMax: 15000 },
  { category: 'オーディオ', keyword: 'Technics SL-1200 turntable',   buyMax: 40000 },
  // フィギュア
  { category: 'フィギュア', keyword: 'Bandai Perfect Grade Gundam',  buyMax: 15000 },
];

async function getEbayPriceForMonitor(keyword, appId) {
  const encoded = encodeURIComponent(keyword);
  const url = [
    'https://svcs.ebay.com/services/search/FindingService/v1',
    '?OPERATION-NAME=findCompletedItems',
    '&SERVICE-VERSION=1.0.0',
    `&SECURITY-APPNAME=${appId}`,
    '&RESPONSE-DATA-FORMAT=JSON',
    `&keywords=${encoded}`,
    '&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true',
    '&sortOrder=EndTimeSoonest',
    '&paginationInput.entriesPerPage=20'
  ].join('');
  try {
    const res   = await fetch(url);
    const json  = await res.json();
    const items = json?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const prices = items
      .map(i => parseFloat(i.sellingStatus?.[0]?.convertedCurrentPrice?.[0]?.__value__ || 0))
      .filter(p => p > 0);
    if (prices.length < 3) return null;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { avg, count: prices.length };
  } catch (e) { return null; }
}

app.get('/api/monitor', async (req, res) => {
  const secret = req.query.secret;
  if (secret !== process.env.MONITOR_SECRET && process.env.MONITOR_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    let rate = 150;
    try {
      const fx = await fetch('https://open.er-api.com/v6/latest/USD');
      const fxData = await fx.json();
      rate = Math.round(fxData.rates.JPY);
    } catch (e) {}

    const results = [];
    for (const target of SCAN_TARGETS) {
      const price = await getEbayPriceForMonitor(target.keyword, process.env.EBAY_APP_ID);
      if (!price) continue;
      const avgJpy = Math.round(price.avg * rate);
      const fee    = Math.round(avgJpy * 0.13);
      const net    = avgJpy - fee;
      const profit = net - target.buyMax;
      const margin = profit / avgJpy;
      results.push({ ...target, avgJpy, net, profit, margin, count: price.count });
      await new Promise(r => setTimeout(r, 2000));
    }

    results.sort((a, b) => b.margin - a.margin);
    const buys  = results.filter(r => r.margin >= 0.20);
    const check = results.filter(r => r.margin >= 0 && r.margin < 0.20);
    const ng    = results.filter(r => r.margin < 0);

    const today = new Date().toLocaleDateString('ja-JP');
    let msg = `📊 仕入れ候補レポート ${today}\n1USD=¥${rate}\nスキャン${SCAN_TARGETS.length}種 → データ${results.length}件\n`;

    if (buys.length > 0) {
      msg += `\n💚━ 買い！（利益率20%超）━\n`;
      buys.slice(0, 5).forEach(r => {
        msg += `\n【${r.category}】${r.keyword}\n`;
        msg += ` eBay売値 ¥${r.avgJpy.toLocaleString()} 手取¥${r.net.toLocaleString()}\n`;
        msg += ` 仕入上限¥${r.buyMax.toLocaleString()} → 利益¥${r.profit.toLocaleString()}（${Math.round(r.margin*100)}%）\n`;
        msg += ` 参照${r.count}件\n`;
      });
    } else {
      msg += `\n💚 利益率20%超の商品はなし\n`;
    }

    if (check.length > 0) {
      msg += `\n🟡━ 要検討（黒字）━\n`;
      check.slice(0, 3).forEach(r => {
        msg += `【${r.category}】${r.keyword} 利益¥${r.profit.toLocaleString()}（${Math.round(r.margin*100)}%）\n`;
      });
    }

    msg += `\n🔴 NG: ${ng.length}件`;

    if (process.env.CHANNEL_ACCESS_TOKEN && process.env.OWNER_USER_ID) {
      await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CHANNEL_ACCESS_TOKEN}`
        },
        body: JSON.stringify({
          to: process.env.OWNER_USER_ID,
          messages: [{ type: 'text', text: msg }]
        })
      });
    }

    res.json({ ok: true, buys: buys.length, check: check.length, ng: ng.length, rate, message: msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const OWNER_USER_ID = process.env.OWNER_USER_ID;
const GAS_URL = process.env.GAS_URL;

// ユーザーの会話状態を管理
const userStates = {};

// LINE署名検証
function verifySignature(body, signature) {
  const hash = crypto
    .createHmac('SHA256', CHANNEL_SECRET)
    .update(body)
    .digest('base64');
  return hash === signature;
}

// LINEに返信
async function replyMessage(replyToken, messages) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ replyToken, messages })
  });
}

// オーナーにプッシュ通知
async function pushMessage(to, messages) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    },
    body: JSON.stringify({ to, messages })
  });
}

// Googleスプレッドシートに保存（GAS経由）
async function saveToSheet(data) {
  if (!GAS_URL) return;
  const params = new URLSearchParams({
    action: 'save',
    name: data.name || '',
    phone: data.phone || '',
    plan: data.plan || '',
    date: data.date || '',
    time: data.time || ''
  });
  await fetch(`${GAS_URL}?${params.toString()}`);
}

// Webhookエンドポイント
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  if (!verifySignature(req.rawBody, signature)) {
    return res.status(403).send('Forbidden');
  }
  res.status(200).send('OK');

  const events = req.body.events;
  events.forEach(event => {
    if (event.type === 'message' && event.message.type === 'text') {
      handleTextMessage(event).catch(console.error);
    } else if (event.type === 'follow') {
      handleFollow(event).catch(console.error);
    }
  });
});

// フォロー時
async function handleFollow(event) {
  await replyMessage(event.replyToken, [{
    type: 'text',
    text: 'フォローありがとうございます！\nフォトスタジオ ちっくたっくです📷\n\n「予約」と送っていただくと撮影予約ができます。'
  }]);
}

// テキストメッセージ処理
async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();
  const state = userStates[userId] || { step: 'start', data: {} };

  if (text === '予約' || text === '予約したい' || text === 'よやく') {
    userStates[userId] = { step: 'select_plan', data: {} };
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: '撮影プランを選んでください👇\n\n1. マタニティ\n2. ニューボーン\n3. お宮参り\n4. 百日祝い\n5. ハーフバースデイ\n6. バースデイ\n7. 七五三\n8. 十歳（ととせ）\n9. 成人式\n10. その他\n\n番号または名前を送ってください。'
    }]);

  } else if (state.step === 'select_plan') {
    state.data.plan = text;
    state.step = 'input_date';
    userStates[userId] = state;
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: `「${text}」ですね！\n\n希望の撮影日を教えてください。\n例：6月15日、7月上旬など`
    }]);

  } else if (state.step === 'input_date') {
    state.data.date = text;
    state.step = 'input_time';
    userStates[userId] = state;
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: '希望のお時間を教えてください。\n例：10時、13時など\n\n※営業時間：10:00〜17:00'
    }]);

  } else if (state.step === 'input_time') {
    state.data.time = text;
    state.step = 'input_name';
    userStates[userId] = state;
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: 'お名前を教えてください。\n例：山田 太郎'
    }]);

  } else if (state.step === 'input_name') {
    state.data.name = text;
    state.step = 'input_phone';
    userStates[userId] = state;
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: 'お電話番号を教えてください。\n例：090-1234-5678'
    }]);

  } else if (state.step === 'input_phone') {
    state.data.phone = text;
    state.step = 'confirm';
    userStates[userId] = state;
    const d = state.data;
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: `以下の内容で予約リクエストを送ります。\n\n📷 撮影プラン：${d.plan}\n📅 希望日：${d.date}\n🕐 希望時間：${d.time}\n👤 お名前：${d.name}\n📞 電話番号：${d.phone}\n\nよろしければ「確定」と送ってください。\n変更する場合は「最初から」と送ってください。`
    }]);

  } else if (state.step === 'confirm' && text === '確定') {
    const savedData = { ...state.data };
    await saveToSheet(savedData);
    delete userStates[userId];

    await replyMessage(event.replyToken, [{
      type: 'text',
      text: '予約リクエストを受け付けました！\n\n確認後、1〜2営業日以内にご連絡いたします。\nどうぞよろしくお願いいたします📷'
    }]);

    if (OWNER_USER_ID) {
      await pushMessage(OWNER_USER_ID, [{
        type: 'text',
        text: `📩 新しい予約リクエスト！\n\n📷 プラン：${savedData.plan}\n📅 希望日：${savedData.date}\n🕐 時間：${savedData.time}\n👤 名前：${savedData.name}\n📞 電話：${savedData.phone}`
      }]);
    }

  } else if (text === '最初から') {
    delete userStates[userId];
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: '最初からやり直します。\n「予約」と送ってください。'
    }]);

  } else {
    await replyMessage(event.replyToken, [{
      type: 'text',
      text: '「予約」と送っていただくと撮影予約ができます📷'
    }]);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ちっくたっく LINEボット起動中 ポート${PORT}`);
});
