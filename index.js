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
      '&itemFilter(1).name=ListingType&itemFilter(1).value=FixedPrice',
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
