export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // 1. Groq Whisper (မူရင်းအသံ စာသားထုတ်ယူခြင်း)
      if (url.pathname === "/api/transcribe" && request.method === "POST") {
        const formData = await request.formData();
        const audioFile = formData.get("file");

        if (!audioFile) {
          return new Response(JSON.stringify({ error: "Audio file is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const groqForm = new FormData();
        groqForm.append("file", audioFile);
        groqForm.append("model", "whisper-large-v3-turbo");
        groqForm.append("response_format", "verbose_json");
        groqForm.append("temperature", "0");

        const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${env.GROQ_API_KEY}` },
          body: groqForm
        });

        const data = await groqRes.json();
        return new Response(JSON.stringify(data), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // 2. Gemini Translation (Original -> English + Burmese 3-Way Translation)
      if (url.pathname === "/api/translate" && request.method === "POST") {
        const { segments, category, lineCount } = await request.json();

        const toneMap = {
          "song": "သီချင်းစာသားဟန်၊ ကာရန်စည်းဝါးညီပြီး ကဗျာဆန်ဆန် အဓိပ္ပာယ်ပေါ်အောင်",
          "movie": "ရုပ်ရှင်ဇာတ်လမ်း သဘာဝစကားပြောဟန်၊ သရုပ်ဆောင်အသုံးအနှုန်း ဒိုင်ယာလော့ဂ်အတိုင်း",
          "news": "သတင်းမီဒီယာ တရားဝင် သုံးစွဲသော စံပြု မြန်မာစာအသုံးအနှုန်းဟန်",
          "show": "Talk Show/အစီအစဉ် ပေါ့ပေါ့ပါးပါး နေ့စဉ်သုံး စကားပြောဟန်",
          "comedy": "ဟာသအသွင်၊ ပေါ့ပါးသွက်လက်ပြီး ရယ်စရာပြက်လုံးစကားလုံးများ ပါဝင်သောဟန်",
          "mystery": "ဆန်းကြယ်နက်နဲပြီး စိတ်ဝင်စားဖွယ် ဆွဲဆောင်မှုရှိသောဟန်",
          "horror": "သည်းထိတ်ရင်ဖို ထိတ်လန့်ခြောက်ခြားဖွယ် လေသံနှင့် အသုံးအနှုန်းဟန်"
        };

        const chosenTone = toneMap[category] || "သဘာဝကျသော မြန်မာစကားပြောဟန်";
        const linesInstruction = lineCount === "1" 
          ? "မြန်မာစာတန်းထိုးကို ၁ ကြောင်းတည်း အတိုချုပ် အဓိပ္ပာယ်ပြည့်အောင် ရေးပါ။" 
          : "မြန်မာစာတန်းထိုးကို အများဆုံး ၂ ကြောင်းခွဲ၍ ဖတ်ရလွယ်အောင် ရေးပါ။";

        const systemPrompt = `You are a professional subtitle translator.
Translate the input segments array into a localized 3-language JSON format.
For each segment:
1. "original": Keep the original spoken text exactly as transcribed.
2. "english": Provide high-quality, natural English translation (if already English, keep it clean).
3. "myanmar": Provide natural Burmese (Myanmar) translation matching tone "${chosenTone}" and constraint "${linesInstruction}".

Input segments:
${JSON.stringify(segments)}

Return ONLY a valid JSON array matching this format:
[
  {
    "id": 1,
    "start": 0.5,
    "end": 3.2,
    "original": "Spoken text",
    "english": "English text",
    "myanmar": "မြန်မာပြန်စာသား"
  }
]`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
              generationConfig: {
                responseMimeType: "application/json"
              }
            })
          }
        );

        const geminiData = await geminiRes.json();
        const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
        
        let parsedResult = [];
        try {
          parsedResult = JSON.parse(rawText);
        } catch (e) {
          // Fallback if parsing issues occur
          parsedResult = segments.map((s, idx) => ({
            id: idx + 1,
            start: s.start,
            end: s.end,
            original: s.text,
            english: s.text,
            myanmar: s.text
          }));
        }

        return new Response(JSON.stringify({ result: parsedResult }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ status: "Silver Studio Worker v3 Active" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
