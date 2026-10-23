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
      // 1. Groq Whisper (Speech-to-Text)
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

      // 2. High-Speed Subtitle Translation Engine (Gemini 3.8 Flash LOW + Groq Llama 3.3 Failover)
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
Do NOT output markdown fences or explanations. Return pure JSON array only.`;

        let parsedResult = null;

        // METHOD A: Google Gemini 3.8 Flash (Interactions API with thinking_level: "low")
        if (env.GEMINI_API_KEY) {
          try {
            const geminiRes = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
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

            const gData = await geminiRes.json();
            const text = gData.output_text || gData.output || gData.outputs?.[0]?.text;
            if (text) {
              const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
              if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
              else parsedResult = JSON.parse(text.replace(/```json/gi, '').replace(/```/g, '').trim());
            }
          } catch (e) {
            console.error("Gemini Interactions Error:", e);
          }

          // Fallback to generateContent with thinkingLevel LOW if needed
          if (!parsedResult || !Array.isArray(parsedResult)) {
            try {
              const genRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${env.GEMINI_API_KEY}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
                    generationConfig: {
                      responseMimeType: "application/json",
                      thinkingConfig: { thinkingLevel: "LOW" }
                    }
                  })
                }
              );
              const genData = await genRes.json();
              const part = genData.candidates?.[0]?.content?.parts?.find(p => !p.thought && p.text) || genData.candidates?.[0]?.content?.parts?.[0];
              if (part?.text) {
                const jsonMatch = part.text.match(/\[\s*\{[\s\S]*\}\s*\]/);
                if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
                else parsedResult = JSON.parse(part.text.replace(/```json/gi, '').replace(/```/g, '').trim());
              }
            } catch (e) {
              console.error("Gemini generateContent Error:", e);
            }
          }
        }

        // METHOD B: Instant Failover to Groq Llama 3.3 70B (Fail-safe backup)
        if ((!parsedResult || !Array.isArray(parsedResult) || parsedResult.length === 0) && env.GROQ_API_KEY) {
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
                  { role: "system", content: "You are a professional subtitle translator. Output a raw JSON array of objects with keys: id, start, end, original, english, myanmar." },
                  { role: "user", content: systemPrompt }
                ],
                temperature: 0.2
              })
            });
            const groqChatData = await groqChatRes.json();
            const content = groqChatData.choices?.[0]?.message?.content || "";
            const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (jsonMatch) parsedResult = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.error("Groq Failover Error:", e);
          }
        }

        // Check if translations were properly generated
        if (!parsedResult || !Array.isArray(parsedResult) || parsedResult.length === 0) {
          throw new Error("ဘာသာပြန်ခြင်း မအောင်မြင်ပါ။ API Key သို့မဟုတ် Network ကို စစ်ဆေးပါခင်ဗျာ။");
        }

        return new Response(JSON.stringify({ result: parsedResult }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ status: "Silver Studio Worker v6 Active" }), {
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
