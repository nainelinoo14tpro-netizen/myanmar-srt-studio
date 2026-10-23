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

      // 2. Google Gemini 3.8 Flash Interactions API
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
Translate the input segments array into a 3-language localized JSON format.
Rules:
1. "original": Keep the spoken transcription exactly as provided.
2. "english": Provide natural, fluent English translation.
3. "myanmar": Provide natural Burmese (Myanmar) translation matching tone "${chosenTone}" and constraint "${linesInstruction}".

Input segments:
${JSON.stringify(segments)}

Return ONLY a valid JSON array of objects with keys: "id", "start", "end", "original", "english", "myanmar".
Do NOT output markdown fences or explanations. Return pure JSON array only.`;

        let rawResponseText = null;

        // Call Gemini 3.8 Flash via Interactions API
        try {
          const interactionRes = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              model: "gemini-3.8-flash",
              input: systemPrompt,
              generation_config: {
                thinking_level: "low"
              }
            })
          });

          const interactionData = await interactionRes.json();
          if (interactionData.output_text) {
            rawResponseText = interactionData.output_text;
          } else if (typeof interactionData.output === "string") {
            rawResponseText = interactionData.output;
          } else if (interactionData.outputs?.[0]?.text) {
            rawResponseText = interactionData.outputs[0].text;
          }
        } catch (e) {}

        // Fallback to generateContent endpoint if needed
        if (!rawResponseText) {
          try {
            const geminiRes = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${env.GEMINI_API_KEY}`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: systemPrompt }] }]
                })
              }
            );
            const geminiData = await geminiRes.json();
            const candidate = geminiData.candidates?.[0];
            if (candidate?.content?.parts) {
              const textPart = candidate.content.parts.find(p => !p.thought && p.text) || candidate.content.parts[candidate.content.parts.length - 1];
              if (textPart?.text) rawResponseText = textPart.text;
            }
          } catch (e) {}
        }

        let parsedResult = null;
        if (rawResponseText) {
          const jsonMatch = rawResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (jsonMatch) {
            try { parsedResult = JSON.parse(jsonMatch[0]); } catch (e) {}
          }
          if (!parsedResult) {
            try {
              const cleaned = rawResponseText.replace(/```json/gi, '').replace(/```/g, '').trim();
              parsedResult = JSON.parse(cleaned);
            } catch (e) {}
          }
        }

        // Error မတက်စေရန် Safe Fallback
        if (!parsedResult || !Array.isArray(parsedResult)) {
          parsedResult = segments.map((s, idx) => ({
            id: s.id || (idx + 1),
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

      return new Response(JSON.stringify({ status: "Silver Studio Worker Running" }), {
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
