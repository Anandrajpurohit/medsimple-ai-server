// ============================================================
// MEDSIMPLE AI - WhatsApp Automation Server
// Meta Cloud API + Airtable subscriber management
// ============================================================

const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const CLAUDE_API_KEY   = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN   = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID  = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const claude = new Anthropic({ apiKey: CLAUDE_API_KEY });

const PAYMENT_MSG = `Choose your MedSimple AI plan:

India (UPI): Reply "pay india" for UPI link
International (PayPal): Reply "pay intl" for PayPal link

Plans: 1 report / 3 reports / Unlimited monthly

After payment, send your transaction ID here to activate!`;

const SYSTEM_PROMPT = `You are MedSimple AI - a friendly medical report explainer.
RULES: Never diagnose. Never prescribe. Always say "Educational only. Consult your doctor."
Format: Use emojis. Explain each test simply. Give 3 doctor questions. Give next steps.
Languages: 2=Hindi, 3=Arabic, 4=Spanish, 5=French, 6=German, 7=Russian, 8=Italian`;

const userPrefs = {};
const subCache = {};
const CACHE_TTL = 5 * 60 * 1000;

async function isSubscriber(phone) {
  const c = subCache[phone];
  if (c && Date.now() - c.t < CACHE_TTL) return c.active;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return true;
  try {
    const r = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Subscribers`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        params: { filterByFormula: `AND({Phone}='${phone}',{Status}='Active')`, maxRecords: 1 } }
    );
    const active = r.data.records.length > 0;
    subCache[phone] = { active, t: Date.now() };
    return active;
  } catch (e) { return false; }
}

async function activateSubscriber(phone, plan, txnId) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  try {
    const ex = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Subscribers`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
        params: { filterByFormula: `{Phone}='${phone}'`, maxRecords: 1 } }
    );
    const fields = { Status: 'Active', Plan: plan, TxnId: txnId, ActivatedAt: new Date().toISOString() };
    if (plan === 'unlimited') fields.ExpiresAt = new Date(Date.now()+30*24*60*60*1000).toISOString();
    if (ex.data.records.length > 0) {
      await axios.patch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Subscribers/${ex.data.records[0].id}`,
        { fields }, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } });
    } else {
      await axios.post(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Subscribers`,
        { fields: { Phone: phone, ...fields } },
        { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } });
    }
    subCache[phone] = { active: true, t: Date.now() };
  } catch (e) { console.error('Airtable error:', e.message); }
}

async function sendMsg(to, text) {
  const MAX = 1500;
  const parts = text.length <= MAX ? [text] : (() => {
    const out = []; let cur = '';
    for (const p of text.split('\n\n')) {
      if ((cur+p).length > MAX) { if(cur) out.push(cur.trim()); cur=p+'\n\n'; } else cur+=p+'\n\n';
    }
    if (cur.trim()) out.push(cur.trim()); return out;
  })();
  for (const part of parts)
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:'whatsapp', to, type:'text', text:{body:part} },
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' } });
}

async function downloadMedia(mediaId) {
  const r = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`,{headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`}});
  const f = await axios.get(r.data.url,{responseType:'arraybuffer',headers:{Authorization:`Bearer ${WHATSAPP_TOKEN}`}});
  return { base64: Buffer.from(f.data).toString('base64'), mimeType: r.data.mime_type };
}

app.get('/', (_,res) => res.send('MedSimple AI Running! 🏥'));

app.get('/webhook', (req,res) => {
  if (req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===VERIFY_TOKEN)
    res.status(200).send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.post('/activate', async (req,res) => {
  const {phone,plan,txnId,secret} = req.body;
  if (secret!==VERIFY_TOKEN) return res.sendStatus(403);
  await activateSubscriber(phone, plan||'manual', txnId||'admin');
  await sendMsg(phone, 'Your MedSimple AI account is now ACTIVE! Send "Hi" to start.');
  res.json({success:true});
});

app.post('/webhook', async (req,res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const from = msg.from;
    const type = msg.type;
    const text = (msg.text?.body||'').trim();
    const low = text.toLowerCase();

    if (type==='text' && (low==='hi'||low==='hello'||low==='start')) {
      await sendMsg(from, 'Welcome to MedSimple AI! I explain medical reports in simple language.\n\n'+PAYMENT_MSG);
      return;
    }

    if (type==='text' && (low.includes('paid')||low.includes('txn')||low.includes('upi')||/^[a-z0-9]{8,}$/i.test(text))) {
      await activateSubscriber(from, 'pending', text);
      await sendMsg(from, 'Payment noted! Your account will be activated within a few minutes.');
      return;
    }

    if (!await isSubscriber(from)) {
      await sendMsg(from, 'Subscribe to use MedSimple AI!\n\n'+PAYMENT_MSG);
      return;
    }

    if (type==='text' && ['1','2','3','4','5','6','7','8'].includes(text)) {
      const langs={'1':'English','2':'Hindi','3':'Arabic','4':'Spanish','5':'French','6':'German','7':'Russian','8':'Italian'};
      userPrefs[from]=langs[text];
      await sendMsg(from, langs[text]+' selected! Now send your medical report photo.');
      return;
    }

    if (type==='image') {
      const lang = userPrefs[from]||'English';
      await sendMsg(from,'Analysing your report... 15-20 seconds please...');
      const {base64,mimeType} = await downloadMedia(msg.image.id);
      const ai = await claude.messages.create({
        model:'claude-opus-4-5', max_tokens:2000,
        system:SYSTEM_PROMPT+`\nLanguage: ${lang}`,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:mimeType||'image/jpeg',data:base64}},
          {type:'text',text:`Explain this medical report in ${lang}.`}
        ]}]
      });
      await sendMsg(from, ai.content[0].text);
      return;
    }

    if (type==='document') {
      await sendMsg(from,'For PDFs: screenshot each page and send as image. I will explain every value!');
      return;
    }

    if (type==='text') {
      if (low==='language'||low==='change language') {
        await sendMsg(from,'Choose:\n1 English\n2 Hindi\n3 Arabic\n4 Spanish\n5 French\n6 German\n7 Russian\n8 Italian');
        return;
      }
      const lang = userPrefs[from]||'English';
      const ai = await claude.messages.create({
        model:'claude-opus-4-5', max_tokens:1000,
        system:SYSTEM_PROMPT+`\nLanguage: ${lang}`,
        messages:[{role:'user',content:text}]
      });
      await sendMsg(from, ai.content[0].text);
    }
  } catch(e){ console.error('Error:',e.response?.data||e.message); }
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>console.log(`MedSimple AI on port ${PORT}`));
