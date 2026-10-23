/**
 * Silver Studio Worker — Full Code
 * Required secrets:
 * GROQ_API_KEY
 * GEMINI_API_KEY
 *
 * Optional variable:
 * GEMINI_MODEL
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return { data: text ? JSON.parse(text) : {} };
  } catch {
    return { data: { raw: text.slice(0, 2000) } };
  }
}

function errorMessage(data, fallback) {
  return data?.error?.message ||
    data?.error ||
    data?.message ||
    fallback;
}

const TONE_MAP = {
  song: "သီချင်းစာသားဟန်၊ ကာရန်ညီပြီး ကဗျာဆန်သော မြန်မာစကား",
  movie: "သဘာဝကျသော ရုပ်ရှင်ဒိုင်ယာလော့ဂ် မြန်မာစကား",
  news: "စံပြု သတင်းမီဒီယာသုံး မြန်မာစာ",
  show: "ပေါ့ပေါ့ပါးပါး နေ့စဉ်သုံး စကားပြောဟန်",
  comedy: "သဘာဝကျပြီး ပေါ့ပါးသွက်လက်သော ဟာသဟန်",
  mystery: "ဆန်းကြယ်နက်နဲသော စကားပြောဟန်",
  horror: "သည်းထိတ်ရင်ဖိုဇာတ်လမ်းနှင့် လိုက်ဖက်သောဟန်"
};

function parseTranslation(rawText, segments) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return null;
  }

  let cleaned = rawText.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const first = cleaned.indexOf("[");
  const last = cleaned.lastIndexOf("]");

  if (first >= 0 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== segments.length) {
    return null;
  }

  return segments.map((segment, index) => {
    const item =
      parsed[index] && typeof parsed[index] === "object"
        ? parsed[index]
        : {};

    const original = String(segment.text ?? segment.original ?? "");

    return {
      id: segment.id,
      start: segment.start,
      end: segment.end,
      original,
      english:
        typeof item.english === "string" && item.english.trim()
          ? item.english.trim()
          : original,
      myanmar:
        typeof item.myanmar === "string" && item.myanmar.trim()
          ? item.myanmar.trim()
          : original
    };
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // HEALTH CHECK
      if (
        request.method === "GET" &&
        (path === "/" || path === "/api/health")
      ) {
        return json({
          status: "ok",
          service: "Silver Studio Worker",
          groq_configured: Boolean(env.GROQ_API_KEY),
          gemini_configured: Boolean(env.GEMINI_API_KEY),
          routes: [
            "/api/transcribe",
            "/api/translate"
          ]
        });
      }

      // GROQ WHISPER TRANSCRIPTION
      if (
        path === "/api/transcribe" &&
        request.method === "POST"
      ) {
        if (!env.GROQ_API_KEY) {
          return json({
            error: "GROQ_API_KEY ကို Worker Secrets တွင် ထည့်ပါ။"
          }, 503);
        }

        let formData;

        try {
          formData = await request.formData();
        } catch {
          return json({
            error: "Request သည် multipart/form-data ဖြစ်ရပါမည်။"
          }, 400);
        }

        const audioFile = formData.get("file");

        if (
          !audioFile ||
          typeof audioFile === "string" ||
          typeof audioFile.size !== "number"
        ) {
          return json({
            error: 'အသံဖိုင်ကို "file" field ဖြင့် ပို့ပေးပါ။'
          }, 400);
        }

        if (audioFile.size === 0) {
          return json({
            error: "အသံဖိုင်သည် ဗလာဖြစ်နေပါသည်။"
          }, 400);
        }

        if (audioFile.size > 25 * 1024 * 1024) {
          return json({
            error: "အသံဖိုင်သည် 25 MB ကျော်နေပါသည်။",
            max_bytes: 25 * 1024 * 1024
          }, 413);
        }

        const groqForm = new FormData();

        groqForm.append(
          "file",
          audioFile,
          audioFile.name || "audio.webm"
        );

        groqForm.append("model", "whisper-large-v3-turbo");
        groqForm.append("response_format", "verbose_json");
        groqForm.append("temperature", "0");

        const groqResponse = await fetch(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.GROQ_API_KEY}`
            },
            body: groqForm
          }
        );

        const { data } = await readJsonResponse(groqResponse);

        if (!groqResponse.ok) {
          return json({
            error: "Groq transcription မအောင်မြင်ပါ။",
            status: groqResponse.status,
            detail: errorMessage(
              data,
              "Groq API က အမှားပြန်ပို့ခဲ့သည်။"
            )
          }, groqResponse.status);
        }

        return json(data);
      }

      // GEMINI TRANSLATION
      if (
        path === "/api/translate" &&
        request.method === "POST"
      ) {
        if (!env.GEMINI_API_KEY) {
          return json({
            error: "GEMINI_API_KEY ကို Worker Secrets တွင် ထည့်ပါ။"
          }, 503);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            error: "Request body သည် မှန်ကန်သော JSON ဖြစ်ရပါမည်။"
          }, 400);
        }

        if (
          !Array.isArray(body?.segments) ||
          body.segments.length === 0
        ) {
          return json({
            error: "ဘာသာပြန်ရန် segments array လိုအပ်ပါသည်။"
          }, 400);
        }

        if (body.segments.length > 100) {
          return json({
            error: "တစ်ကြိမ်လျှင် segments 100 ခုအထိသာ ပို့ပါ။"
          }, 413);
        }

        const segments = [];

        for (let i = 0; i < body.segments.length; i++) {
          const s = body.segments[i];

          if (
            !s ||
            typeof s !== "object" ||
            Array.isArray(s)
          ) {
            return json({
              error: `segments[${i}] သည် object ဖြစ်ရပါမည်။`
            }, 400);
          }

          const text = String(
            s.text ?? s.original ?? ""
          ).trim();

          if (!text) {
            return json({
              error: `segments[${i}] တွင် text မရှိပါ။`
            }, 400);
          }

          segments.push({
            id: s.id ?? i + 1,
            start: Number.isFinite(Number(s.start))
              ? Number(s.start)
              : 0,
            end: Number.isFinite(Number(s.end))
              ? Number(s.end)
              : 0,
            text
          });
        }

        const category =
          typeof body.category === "string"
            ? body.category
            : "";

        const tone =
          TONE_MAP[category] ||
          "သဘာဝကျသော မြန်မာစကားပြောဟန်";

        const lineInstruction =
          String(body.lineCount ?? "2") === "1"
            ? "စာတန်းတစ်ခုစီကို တစ်ကြောင်းတည်း အတိုချုပ်ရေးပါ။"
            : "စာတန်းတစ်ခုစီကို အများဆုံး နှစ်ကြောင်းအတွင်း ရေးပါ။";

        const prompt = [
          "You are a professional subtitle translator.",
          "Return only a valid JSON array.",
          "Return exactly one object for each input segment.",
          "Keep the original segment order.",
          'Each object must contain "id", "start", "end", "original", "english", "myanmar".',
          "Preserve each input id, start and end.",
          "The original field must preserve the provided transcription exactly.",
          "Translate naturally into English in the english field.",
          `Translate naturally into Burmese in the myanmar field. Style: ${tone}.`,
          lineInstruction,
          "Do not omit segments.",
          "Do not add markdown fences or explanations.",
          "Input segments:",
          JSON.stringify(segments)
        ].join("\n");

        const model =
          typeof env.GEMINI_MODEL === "string" &&
          env.GEMINI_MODEL.trim()
            ? env.GEMINI_MODEL.trim()
            : "gemini-2.5-flash";

        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY
            },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [{ text: prompt }]
                }
              ],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json"
              }
            })
          }
        );

        const { data } = await readJsonResponse(geminiResponse);

        if (!geminiResponse.ok) {
          return json({
            error: "Gemini translation မအောင်မြင်ပါ။",
            status: geminiResponse.status,
            detail: errorMessage(
              data,
              "Gemini API က အမှားပြန်ပို့ခဲ့သည်။"
            ),
            model
          }, geminiResponse.status);
        }

        const rawText = (data.candidates || [])
          .flatMap(candidate =>
            candidate?.content?.parts || []
          )
          .filter(part =>
            typeof part?.text === "string" &&
            !part.thought
          )
          .map(part => part.text)
          .join("\n");

        const result = parseTranslation(
          rawText,
          segments
        );

        if (!result) {
          return json({
            error: "Gemini JSON ရလဒ် မမှန်ကန်ပါ။",
            detail: "ထပ်မံကြိုးစားပါ သို့မဟုတ် Gemini model ကို စစ်ဆေးပါ။",
            model
          }, 502);
        }

        return json({
          result,
          model
        });
      }

      if (
        path === "/api/transcribe" ||
        path === "/api/translate"
      ) {
        return json({
          error: "ဤ endpoint သည် POST request ကိုသာ လက်ခံပါသည်။"
        }, 405, {
          Allow: "POST, OPTIONS"
        });
      }

      return json({
        error: "Not found",
        path
      }, 404);

    } catch (error) {
      return json({
        error: "Worker အတွင်းပိုင်းအမှား ဖြစ်ပေါ်ခဲ့သည်။",
        detail: error instanceof Error
          ? error.message
          : String(error)
      }, 500);
    }
  }
};
