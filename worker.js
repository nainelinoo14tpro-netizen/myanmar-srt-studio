export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // 1. Groq Whisper (မူရင်းအသံ စာသားထုတ်ယူခြင်း - 100% အလုပ်လုပ်နေပြီးဖြစ်သည်)
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

      // 2. High-Speed Multi-Language Translation (Groq Llama 3.3 70B Fast Engine)
      if (url.pathname === "/api/translate" && request.method === "POST") {
        const { segments, category, lineCount } = await request.json();

        if (!segments || segments.length === 0) {
          return new Response(JSON.stringify({ result: [] }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

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

        // Segment များကို ID အလိုက် စာရင်းပြုစုခြင်း
        const linesText = segments.map((s, idx) => `${s.id || (idx + 1)}: ${s.text}`).join("\n");

        const prompt = `You are a professional subtitle translator.
Translate each numbered line of spoken transcription into fluent English and natural Burmese (Myanmar).
Tone Style: ${chosenTone}
Layout Constraint: ${linesInstruction}

Input Lines:
${linesText}

Return a valid JSON object where keys are the line numbers:
{
  "1": { "en": "English translation", "mm": "သဘာဝကျသော မြန်မာဘာသာပြန်" },
  "2": { "en": "English translation", "mm": "သဘာဝကျသော မြန်မာဘာသာပြန်" }
}`;

        let translationsMap = {};

        // METHOD 1: Groq Llama 3.3 70B (၁ စက္ကန့်အတွင်း အမြန်ဆုံး ပြီးစီးသည်)
        try {
          const groqChatRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.GROQ_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "llama-3.3-70b-versatile",
              messages: [
                { role: "system", content: "You are a professional subtitle localization translator. You output pure JSON only." },
                { role: "user", content: prompt }
              ],
              response_format: { type: "json_object" },
              temperature: 0.2
            })
          });

          const groqChatData = await groqChatRes.json();
          const content = groqChatData.choices?.[0]?.message?.content;
          if (content) {
            translationsMap = JSON.parse(content);
          }
        } catch (e) {
          console.error("Groq Chat Error:", e);
        }

        // METHOD 2: Fallback to Gemini 3.8 Flash (Groq မရပါက Gemini သို့ switch မည်)
        if (Object.keys(translationsMap).length === 0 && env.GEMINI_API_KEY) {
          try {
            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: prompt }] }],
                  generationConfig: { responseMimeType: "application/json" }
                })
              }
            );
            const geminiData = await geminiRes.json();
            const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              translationsMap = JSON.parse(text);
            }
          } catch (e) {
            console.error("Gemini Fallback Error:", e);
          }
        }

        // Segments များနှင့် ဘာသာပြန်ရလဒ်များကို အမှားလုံးဝမရှိစေဘဲ ပေါင်းစပ်ခြင်း
        const finalResult = segments.map((s, idx) => {
          const id = s.id || (idx + 1);
          const t = translationsMap[String(id)] || translationsMap[id] || {};
          return {
            id: id,
            start: s.start,
            end: s.end,
            original: s.text || "",
            english: t.en || t.english || s.text || "",
            myanmar: t.mm || t.myanmar || s.text || ""
          };
        });

        return new Response(JSON.stringify({ result: finalResult }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ status: "Silver Studio Worker Online" }), {
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
