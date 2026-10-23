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

      // 2. Gemini 3.8 Flash Translation Engine
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

        const systemPrompt = `You are a professional subtitle localization translator.
Translate the input segments array into a 3-language localized JSON format.
Rules:
1. "original": Keep the spoken transcription exactly as provided.
2. "english": Provide natural, fluent English translation.
3. "myanmar": Provide natural Burmese (Myanmar) translation matching tone "${chosenTone}" and constraint "${linesInstruction}".

Input segments:
${JSON.stringify(segments)}

Return ONLY a valid JSON array of objects with keys: "id", "start", "end", "original", "english", "myanmar".
Do NOT output markdown fences. Return pure JSON array only.`;

        // Gemini 3.8 Flash ကို အဓိကထားပြီး gemini-2.5-flash ကို Fallback ထားခြင်း
        const targetModels = ["gemini-3.8-flash", "gemini-2.5-flash"];
        let rawResponseText = null;
        let lastError = null;

        for (const model of targetModels) {
          try {
            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
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
            const candidate = geminiData.candidates?.[0];

            if (candidate?.content?.parts) {
              // Gemini 3.8 ၏ Thought token များကို ဖယ်ရှားပြီး Actual Text part ကိုသာ ဆွဲထုတ်ခြင်း
              const textPart = candidate.content.parts.find(p => !p.thought && p.text) || candidate.content.parts[candidate.content.parts.length - 1];
              if (textPart && textPart.text) {
                rawResponseText = textPart.text;
                break;
              }
            } else if (geminiData.error) {
              lastError = geminiData.error.message;
            }
          } catch (err) {
            lastError = err.message;
          }
        }

        if (!rawResponseText) {
          throw new Error("Gemini Translation Error: " + (lastError || "Failed to generate translation"));
        }

        rawResponseText = rawResponseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsedResult = JSON.parse(rawResponseText);

        return new Response(JSON.stringify({ result: parsedResult }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ status: "Silver Studio Worker v5 Online" }), {
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
