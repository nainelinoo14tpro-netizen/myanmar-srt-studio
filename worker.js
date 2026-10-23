
/**
 * Silver Studio - Myanmar SRT Pro
 * Cloudflare Worker
 *
 * Required Worker Secrets:
 *   GROQ_API_KEY
 *   GEMINI_API_KEY
 *
 * Optional Worker Variable:
 *   GEMINI_MODEL
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/transcribe
 *   POST /api/translate
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-goog-api-key",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

async function readJsonResponse(response) {
  const text = await response.text();

  try {
    return {
      data: text ? JSON.parse(text) : {},
      text,
    };
  } catch {
    return {
      data: { raw: text.slice(0, 2000) },
      text,
    };
  }
}

function errorMessage(data, fallback) {
  const message =
    data?.error?.message ??
    data?.error?.status ??
    data?.message;

  return typeof message === "string" ? message : fallback;
}

const TONE_MAP = {
  song: "သီချင်းစာသားဟန်၊ ကာရန်စည်းဝါးညီပြီး ကဗျာဆန်ဆန်",
  movie: "ရုပ်ရှင်ဇာတ်လမ်းနှင့် သဘာဝကျသော စကားပြောဟန်",
  news: "သတင်းမီဒီယာသုံး စံပြုမြန်မာစာဟန်",
  show: "ပေါ့ပေါ့ပါးပါး သဘာဝကျသော နေ့စဉ်စကားပြောဟန်",
  comedy: "ဟာသဆန်ပြီး ပေါ့ပါးသွက်လက်သောဟန်",
  mystery: "ဆန်းကြယ်နက်နဲပြီး စိတ်ဝင်စားဖွယ်ဟန်",
  horror: "သည်းထိတ်ရင်ဖို ဇာတ်လမ်းနှင့်လိုက်ဖက်သောဟန်",
};

function normalizeTranslationArray(rawText, segments) {
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

  if (
    !Array.isArray(parsed) ||
    parsed.length !== segments.length
  ) {
    return null;
  }

  return segments.map((segment, index) => {
    const item =
      parsed[index] && typeof parsed[index] === "object"
        ? parsed[index]
        : {};

    const original = String(segment.text ?? "");

    const english =
      typeof item.english === "string" &&
      item.english.trim()
        ? item.english.trim()
        : "";

    const myanmar =
      typeof item.myanmar === "string" &&
      item.myanmar.trim()
        ? item.myanmar.trim()
        : "";

    if (!english || !myanmar) {
      return null;
    }

    return {
      id: segment.id,
      start: segment.start,
      end: segment.end,
      original,
      english,
      myanmar,
    };
  }).every(Boolean)
    ? segments.map((segment, index) => {
        const item = parsed[index];

        return {
          id: segment.id,
          start: segment.start,
          end: segment.end,
          original: String(segment.text ?? ""),
          english: item.english.trim(),
          myanmar: item.myanmar.trim(),
        };
      })
    : null;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const model =
      typeof env.GEMINI_MODEL === "string" &&
      env.GEMINI_MODEL.trim()
        ? env.GEMINI_MODEL.trim()
        : "gemini-3.8-flash";

    try {
      // ----------------------------------------
      // HEALTH CHECK
      // ----------------------------------------
      if (
        request.method === "GET" &&
        (path === "/" || path === "/api/health")
      ) {
        return json({
          status: "ok",
          service: "Silver Studio - Myanmar SRT Pro",
          groq_configured: Boolean(env.GROQ_API_KEY),
          gemini_configured: Boolean(env.GEMINI_API_KEY),
          gemini_model: model,
          routes: [
            "POST /api/transcribe",
            "POST /api/translate",
          ],
        });
      }

      // ----------------------------------------
      // GROQ WHISPER TRANSCRIPTION
      // ----------------------------------------
      if (
        path === "/api/transcribe" &&
        request.method === "POST"
      ) {
        if (!env.GROQ_API_KEY) {
          return json({
            error: "Worker တွင် GROQ_API_KEY မသတ်မှတ်ရသေးပါ။",
          }, 503);
        }

        let formData;

        try {
          formData = await request.formData();
        } catch {
          return json({
            error: "multipart/form-data ပုံစံဖြင့် ပို့ပေးပါ။",
          }, 400);
        }

        const audioFile = formData.get("file");

        if (
          !audioFile ||
          typeof audioFile === "string" ||
          typeof audioFile.size !== "number"
        ) {
          return json({
            error: 'အသံဖိုင်ကို "file" field ဖြင့် ပို့ပေးပါ။',
          }, 400);
        }

        if (audioFile.size === 0) {
          return json({
            error: "အသံဖိုင်သည် ဗလာဖြစ်နေပါသည်။",
          }, 400);
        }

        if (audioFile.size > 25 * 1024 * 1024) {
          return json({
            error:
              "အသံဖိုင်သည် 25 MB ကျော်နေပါသည်။ " +
              "အသံဖိုင်ကို အပိုင်းခွဲ၍ ပြန်ပို့ပါ။",
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

        let groqRes;

        try {
          groqRes = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.GROQ_API_KEY}`,
              },
              body: groqForm,
            }
          );
        } catch (error) {
          return json({
            error: "Groq API သို့ ချိတ်ဆက်၍မရပါ။",
            detail: String(error?.message || error),
          }, 502);
        }

        const { data } = await readJsonResponse(groqRes);

        if (!groqRes.ok) {
          return json({
            error: "Groq transcription မအောင်မြင်ပါ။",
            status: groqRes.status,
            detail: errorMessage(
              data,
              "Groq API က အမှားပြန်ပို့ခဲ့သည်။"
            ),
          }, 502);
        }

        return json(data);
      }

      // ----------------------------------------
      // GEMINI TRANSLATION
      // ----------------------------------------
      if (
        path === "/api/translate" &&
        request.method === "POST"
      ) {
        if (!env.GEMINI_API_KEY) {
          return json({
            error: "Worker တွင် GEMINI_API_KEY မသတ်မှတ်ရသေးပါ။",
          }, 503);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            error: "Request body သည် မှန်ကန်သော JSON မဟုတ်ပါ။",
          }, 400);
        }

        const segments = body?.segments;
        const category =
          typeof body?.category === "string"
            ? body.category
            : "";

        const lineCount = String(body?.lineCount ?? "2");

        if (!Array.isArray(segments) || segments.length === 0) {
          return json({
            error: "ဘာသာပြန်ရန် segments array လိုအပ်ပါသည်။",
          }, 400);
        }

        if (segments.length > 100) {
          return json({
            error:
              "တစ်ကြိမ်လျှင် စာကြောင်း 100 ခုထက် မပိုစေရပါ။ " +
              "အပိုင်းခွဲပြီး ပြန်ပို့ပါ။",
          }, 413);
        }

        const safeSegments = [];

        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];

          if (
            !segment ||
            typeof segment !== "object" ||
            Array.isArray(segment)
          ) {
            return json({
              error: `segments[${i}] သည် object ဖြစ်ရပါမည်။`,
            }, 400);
          }

          const text = String(
            segment.text ?? segment.original ?? ""
          ).trim();

          if (!text) {
            return json({
              error: `segments[${i}] တွင် ဘာသာပြန်ရန် စာသားမရှိပါ။`,
            }, 400);
          }

          safeSegments.push({
            id: segment.id ?? i + 1,
            start: Number.isFinite(Number(segment.start))
              ? Number(segment.start)
              : 0,
            end: Number.isFinite(Number(segment.end))
              ? Number(segment.end)
              : 0,
            text,
          });
        }

        const tone =
          TONE_MAP[category] ||
          "သဘာဝကျသော မြန်မာစကားပြောဟန်";

        const lineInstruction = lineCount === "1"
          ? "မြန်မာစာတန်းတစ်ခုစီကို တစ်ကြောင်းတည်း အတိုချုပ်ပါ။"
          : "မြန်မာစာတန်းတစ်ခုစီကို ဖတ်ရလွယ်သော နှစ်ကြောင်းအတွင်း ရေးပါ။";

        const prompt = [
          "You are a professional subtitle translator.",
          "Translate every input segment.",
          "Return ONLY a valid JSON array.",
          "Return exactly one object for every input segment.",
          'Each object must contain: "id", "start", "end", "original", "english", "myanmar".',
          "Preserve each input id, start and end exactly.",
          "Keep original equal to the supplied source text.",
          "Translate english naturally into English.",
          `Translate myanmar into natural Burmese (Myanmar). Style: ${tone}.`,
          lineInstruction,
          "Do not omit any segment.",
          "Do not include markdown fences or explanatory text.",
          "Input segments:",
          JSON.stringify(safeSegments),
        ].join("\n");

        let geminiRes;

        try {
          geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": env.GEMINI_API_KEY,
              },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [{ text: prompt }],
                  },
                ],
                generationConfig: {
                  temperature: 0.2,
                  responseMimeType: "application/json",
                },
              }),
            }
          );
        } catch (error) {
          return json({
            error: "Gemini API သို့ ချိတ်ဆက်၍မရပါ။",
            detail: String(error?.message || error),
            model,
          }, 502);
        }

        const { data } = await readJsonResponse(geminiRes);

        if (!geminiRes.ok) {
          return json({
            error: "Gemini translation မအောင်မြင်ပါ။",
            status: geminiRes.status,
            detail: errorMessage(
              data,
              "Gemini API က အမှားပြန်ပို့ခဲ့သည်။"
            ),
            model,
          }, 502);
        }

        const rawText = (data?.candidates || [])
          .flatMap(candidate => candidate?.content?.parts || [])
          .filter(part =>
            typeof part?.text === "string" &&
            !part.thought
          )
          .map(part => part.text)
          .join("\n");

        const result = normalizeTranslationArray(
          rawText,
          safeSegments
        );

        if (!result) {
          return json({
            error:
              "Gemini က မှန်ကန်သော ဘာသာပြန် JSON ကို မပြန်ပို့နိုင်ပါ။",
            detail:
              "စာကြောင်းအရေအတွက် သို့မဟုတ် JSON ပုံစံ မကိုက်ညီပါ။ ပြန်စမ်းပါ။",
            model,
          }, 502);
        }

        return json({
          result,
          model,
        });
      }

      if (
        path === "/api/transcribe" ||
        path === "/api/translate"
      ) {
        return json({
          error: "ဤ endpoint သည် POST request ကိုသာ လက်ခံပါသည်။",
        }, 405, {
          Allow: "POST, OPTIONS",
        });
      }

      return json({
        error: "Not found",
        path,
      }, 404);

    } catch (error) {
      return json({
        error: "Worker အတွင်းပိုင်းအမှား ဖြစ်ပေါ်ခဲ့သည်။",
        detail: String(error?.message || error),
      }, 500);
    }
  },
};
