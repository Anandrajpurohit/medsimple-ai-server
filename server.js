// ============================================================
// MEDSIMPLE AI - WhatsApp Automation Server
// Receives WhatsApp messages via Twilio → Calls Claude AI → Replies
// Deploy free on Render.com
// ============================================================

const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── CONFIG (set these as Environment Variables on Render) ──
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g. whatsapp:+14155238886

const claude = new Anthropic({ apiKey: CLAUDE_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── THE MEDICAL REPORT EXPLAINER PROMPT ──
const SYSTEM_PROMPT = `You are MedSimple AI — a friendly, expert medical report explainer.

Your job is to explain medical reports in simple, clear language that anyone can understand.

STRICT RULES:
1. NEVER diagnose. NEVER prescribe. NEVER replace a doctor.
2. Always add: "⚠️ This is educational only. Please consult your doctor."
3. Be warm, caring, and reassuring — patients are often scared.
4. Use emojis to make it friendly: ✅ for normal, ⚠️ for borderline, 🔴 for concerning.

REPORT EXPLANATION FORMAT:
━━━━━━━━━━━━━━━━━━━
🔬 *MEDSIMPLE AI REPORT ANALYSIS*
━━━━━━━━━━━━━━━━━━━

*📊 YOUR RESULTS — VALUE BY VALUE:*

For each test value:
• *[Test Name]: [Value]* — Normal range: [range]
  → [Simple 1-2 line explanation]
  → Status: ✅ Normal / ⚠️ Borderline / 🔴 Needs attention

*⚠️ KEY THINGS TO WATCH:*
[Summarize the important findings in 2-3 sentences]

*❓ ASK YOUR DOCTOR THESE 3 QUESTIONS:*
1. [Specific question based on the report]
2. [Specific question based on the report]
3. [Specific question based on the report]

*📋 NEXT STEPS:*
[Simple, actionable advice — diet, lifestyle, follow-up timing]

━━━━━━━━━━━━━━━━━━━
⚠️ Educational only. Not medical advice. Always consult your doctor.
━━━━━━━━━━━━━━━━━━━

LANGUAGE SELECTION:
If user says "Hindi" or "2" → respond in Hindi (Devanagari script)
If user says "Arabic" or "3" → respond in Arabic
If user says "Spanish" or "4" → respond in Spanish
If user says "French" or "5" → respond in French
If user says "German" or "6" → respond in German
If user says "Russian" or "7" → respond in Russian
If user says "Italian" or "8" → respond in Italian
Default → English

ACTIVATION FLOW:
When user first messages (activation/payment screenshot):
→ Reply with language selection menu:

👋 *Welcome to MedSimple AI!*

Your account is now *ACTIVE* ✅

Please choose your language:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ العربية (Arabic)
4️⃣ Español (Spanish)
5️⃣ Français (French)
6️⃣ Deutsch (German)
7️⃣ Русский (Russian)
8️⃣ Italiano (Italian)

Reply with the number of your choice, then send your medical report photo or PDF! 📋`;

// Simple in-memory store for user language preferences
const userPreferences = {};

// ── HEALTH CHECK ──
app.get('/', (req, res) => {
  res.send('MedSimple AI Server is running! 🏥');
});

// ── MAIN WEBHOOK — receives WhatsApp messages from Twilio ──
app.post('/webhook', async (req, res) => {
  try {
    const from = req.body.From; // e.g. "whatsapp:+919876543210"
    const body = req.body.Body || '';
    const mediaUrl = req.body.MediaUrl0; // image/PDF if sent
    const mediaType = req.body.MediaContentType0;
    const numMedia = parseInt(req.body.NumMedia || '0');

    console.log(`Message from ${from}: "${body}" | Media: ${numMedia} file(s)`);

    let responseText = '';

    // ── CASE 1: User sent an image or PDF (medical report) ──
    if (numMedia > 0 && mediaUrl) {
      console.log(`Processing media: ${mediaType} from ${mediaUrl}`);

      const userLang = userPreferences[from] || 'English';

      // Download the image from Twilio (needs auth)
      const imageResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN
        }
      });

      const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
      const imageMimeType = mediaType || 'image/jpeg';

      // Determine if it's an image we can send to Claude
      const isImage = imageMimeType.startsWith('image/');

      if (isImage) {
        // Call Claude with the image
        const message = await claude.messages.create({
          model: 'claude-opus-4-5',
          max_tokens: 2000,
          system: SYSTEM_PROMPT + `\n\nUser's preferred language: ${userLang}`,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: imageMimeType,
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: `Please explain this medical report in ${userLang}. Follow the exact format in your instructions.`
              }
            ]
          }]
        });

        responseText = message.content[0].text;
      } else {
        // PDF — can't process image, ask for photo
        responseText = `📄 I received your PDF!

For best results, please:
1. Open the PDF on your phone
2. Take a clear screenshot of each page
3. Send the screenshot(s) to me

I'll explain it right away! 🔬`;
      }
    }

    // ── CASE 2: Language selection (1-8) ──
    else if (['1','2','3','4','5','6','7','8'].includes(body.trim())) {
      const langs = {
        '1': 'English', '2': 'Hindi', '3': 'Arabic', '4': 'Spanish',
        '5': 'French', '6': 'German', '7': 'Russian', '8': 'Italian'
      };
      const selectedLang = langs[body.trim()];
      userPreferences[from] = selectedLang;

      responseText = `✅ *${selectedLang} selected!*

Now please:

📋 *Quick profile for accurate results:*
1. What is your age?
2. Male or Female?
3. Any known conditions? (diabetes, BP, thyroid, none?)

Then send your *medical report photo* and I'll explain every value! 🔬`;
    }

    // ── CASE 3: Activation / Hi / payment confirmation ──
    else if (body.toLowerCase().includes('paid') ||
             body.toLowerCase().includes('activated') ||
             body.toLowerCase().includes('activate') ||
             body.toLowerCase() === 'hi' ||
             body.toLowerCase() === 'hello' ||
             body.trim() === '') {
      responseText = `👋 *Welcome to MedSimple AI!*

Your account is now *ACTIVE* ✅

Please choose your language:
1️⃣ English
2️⃣ हिंदी (Hindi)
3️⃣ العربية (Arabic)
4️⃣ Español (Spanish)
5️⃣ Français (French)
6️⃣ Deutsch (German)
7️⃣ Русский (Russian)
8️⃣ Italiano (Italian)

Reply with the number of your choice, then send your medical report photo or PDF! 📋`;
    }

    // ── CASE 4: Text message — try to process as report or profile info ──
    else {
      const userLang = userPreferences[from] || 'English';

      const message = await claude.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        system: SYSTEM_PROMPT + `\n\nUser's preferred language: ${userLang}`,
        messages: [{
          role: 'user',
          content: body
        }]
      });

      responseText = message.content[0].text;
    }

    // ── SEND REPLY VIA TWILIO ──
    // WhatsApp has 1600 char limit per message — split if needed
    const MAX_LENGTH = 1500;
    const messages = [];

    if (responseText.length <= MAX_LENGTH) {
      messages.push(responseText);
    } else {
      // Split at paragraph breaks
      const paragraphs = responseText.split('\n\n');
      let current = '';
      for (const para of paragraphs) {
        if ((current + para).length > MAX_LENGTH) {
          if (current) messages.push(current.trim());
          current = para + '\n\n';
        } else {
          current += para + '\n\n';
        }
      }
      if (current.trim()) messages.push(current.trim());
    }

    // Send each part
    for (const msgText of messages) {
      await twilioClient.messages.create({
        from: TWILIO_WHATSAPP_NUMBER,
        to: from,
        body: msgText
      });
    }

    console.log(`Replied to ${from} with ${messages.length} message(s)`);
    res.status(200).send('OK');

  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Error');
  }
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MedSimple AI server running on port ${PORT}`);
});
