/**
 * Silver Studio - Myanmar SRT Pro
 * Cloudflare Worker Full Code
 *
 * Required Secrets:
 * GROQ_API_KEY
 * GEMINI_API_KEY
 *
 * Optional Variable:
 * GEMINI_MODEL
 *
 * Routes:
 * GET  /
 * GET  /api/health
 * POST /api/transcribe
 * POST /api/translate
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, x-goog-api-key",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra
    }
  });
}

async function readBody(response) {
  const text = await response.text();

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}

function upstreamError(data, fallback) {
  if (typeof data?.error === "string") {
    return data.error;
  }

  return (
    data?.error?.message ||
    data?.message ||
    data?.raw ||
    fallback
  );
}

const TONE_MAP = {
  song: "သီချင်းစာသားဟန်၊ ကဗျာဆန်ပြီး အဓိပ္ပာယ်ပြည့်ဝသော မြန်မာစကား",
  movie: "သဘာဝကျသော ရုပ်ရှင်ဒိုင်ယာလော့ဂ် မြန်မာစကား",
  news: "စံပြု သတင်းမီဒီယာသုံး မြန်မာစာ",
  show: "ပေါ့ပေါ့ပါးပါး နေ့စဉ်သုံး စကားပြောဟန်",
  comedy: "သဘာဝကျပြီး ပေါ့ပါးသွက်လက်သော ဟာသဟန်",
  mystery: "ဆန်းကြယ်နက်နဲသော စကားပြောဟန်",
  horror: "သည်းထိတ်ရင်ဖိုဇာတ်လမ်းနှင့် လိုက်ဖက်သောဟန်"
};

function extractText(data) {
  const parts =
    data?.candidates?.[0]?.content?.parts || [];

  return parts
    .filter(
      part =>
        typeof part.text === "string" &&
        !part.thought
    )
    .map(part => part.text)
    .join("\n")
    .trim();
}

function extractJsonArray(raw) {
  if (!raw) return null;

  let text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");

  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const value = JSON.parse(
      text.slice(start, end + 1)
    );

    return Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function translateBatch(
  batch,
  env,
  tone,
  lineCount
) {
  const model = String(
    env.GEMINI_MODEL || "gemini-2.5-flash"
  ).trim();

  const lineInstruction =
    String(lineCount) === "1"
      ? "Keep each Burmese subtitle concise and on one line."
      : "Keep each Burmese subtitle readable, at most two short lines.";

  const prompt = [
    "You are a professional subtitle translator.",
    "Translate each input segment into natural English and natural Burmese.",
    "Return ONLY a valid JSON array. No markdown and no explanation.",
    'Each item must contain these keys: id, start, end, original, english, myanmar.',
    "Preserve id, start and end exactly and keep the same order.",
    "The original field must preserve the provided transcription text.",
    "Burmese style: " + tone + ".",
    lineInstruction,
    "Return exactly " + batch.length + " objects.",
    "Input JSON:",
    JSON.stringify(batch)
  ].join("\n");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) +
      ":generateContent",
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

  const data = await readBody(response);

  if (!response.ok) {
    const error = new Error(
      upstreamError(data, "Gemini API request failed")
    );

    error.status = response.status;
    error.model = model;

    throw error;
  }

  const raw = extractText(data);
  const parsed = extractJsonArray(raw);

  if (
    !parsed ||
    parsed.length !== batch.length
  ) {
    const error = new Error(
      "Gemini က မှန်ကန်သော JSON subtitle list ကို မပြန်ပို့နိုင်ပါ။"
    );

    error.status = 502;
    error.model = model;

    throw error;
  }

  return batch.map((segment, index) => {
    const item =
      parsed[index] &&
      typeof parsed[index] === "object"
        ? parsed[index]
        : {};

    const original = segment.text;

    return {
      id: segment.id,
      start: segment.start,
      end: segment.end,
      original,

      english:
        typeof item.english === "string" &&
        item.english.trim()
          ? item.english.trim()
          : original,

      myanmar:
        typeof item.myanmar === "string" &&
        item.myanmar.trim()
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

    const path =
      url.pathname.replace(/\/+$/, "") || "/";

    try {
      // HEALTH CHECK
      if (
        request.method === "GET" &&
        (path === "/" || path === "/api/health")
      ) {
        return json({
          status: "ok",
          service: "Silver Studio - Myanmar SRT Pro",

          groq_configured:
            Boolean(env.GROQ_API_KEY),

          gemini_configured:
            Boolean(env.GEMINI_API_KEY),

          gemini_model:
            String(
              env.GEMINI_MODEL ||
              "gemini-2.5-flash"
            ),

          routes: [
            "POST /api/transcribe",
            "POST /api/translate"
          ]
        });
      }

      // GROQ TRANSCRIPTION
      if (path === "/api/transcribe") {
        if (request.method !== "POST") {
          return json(
            { error: "POST method လိုအပ်ပါသည်။" },
            405,
            { Allow: "POST, OPTIONS" }
          );
        }

        if (!env.GROQ_API_KEY) {
          return json({
            error:
              "GROQ_API_KEY ကို Cloudflare Worker Secrets တွင် ထည့်ပါ။"
          }, 503);
        }

        let formData;

        try {
          formData = await request.formData();
        } catch {
          return json({
            error:
              "multipart/form-data request လိုအပ်ပါသည်။"
          }, 400);
        }

        const audioFile = formData.get("file");

        if (
          !audioFile ||
          typeof audioFile === "string" ||
          typeof audioFile.size !== "number"
        ) {
          return json({
            error:
              'အသံဖိုင်ကို "file" field ဖြင့် ပို့ပေးပါ။'
          }, 400);
        }

        if (audioFile.size === 0) {
          return json({
            error: "အသံဖိုင်သည် ဗလာဖြစ်နေပါသည်။"
          }, 400);
        }

        if (audioFile.size > 25 * 1024 * 1024) {
          return json({
            error:
              "အသံဖိုင်သည် 25 MB ကျော်နေပါသည်။"
          }, 413);
        }

        const groqForm = new FormData();

        groqForm.append(
          "file",
          audioFile,
          audioFile.name || "audio.wav"
        );

        groqForm.append(
          "model",
          "whisper-large-v3-turbo"
        );

        groqForm.append(
          "response_format",
          "verbose_json"
        );

        groqForm.append("temperature", "0");

        const response = await fetch(
          "https://api.groq.com/openai/v1/audio/transcriptions",
          {
            method: "POST",
            headers: {
              Authorization:
                "Bearer " + env.GROQ_API_KEY
            },
            body: groqForm
          }
        );

        const data = await readBody(response);

        if (!response.ok) {
          return json({
            error:
              "Groq transcription မအောင်မြင်ပါ။",

            status: response.status,

            detail: upstreamError(
              data,
              "Groq API error"
            )
          }, response.status);
        }

        if (
          typeof data.text !== "string" ||
          !Array.isArray(data.segments)
        ) {
          return json({
            error:
              "Groq transcription response မမှန်ကန်ပါ။"
          }, 502);
        }

        return json(data);
      }

      // GEMINI TRANSLATION
      if (path === "/api/translate") {
        if (request.method !== "POST") {
          return json(
            { error: "POST method လိုအပ်ပါသည်။" },
            405,
            { Allow: "POST, OPTIONS" }
          );
        }

        if (!env.GEMINI_API_KEY) {
          return json({
            error:
              "GEMINI_API_KEY ကို Cloudflare Worker Secrets တွင် ထည့်ပါ။"
          }, 503);
        }

        let body;

        try {
          body = await request.json();
        } catch {
          return json({
            error:
              "Request body သည် မှန်ကန်သော JSON ဖြစ်ရပါမည်။"
          }, 400);
        }

        if (
          !Array.isArray(body?.segments) ||
          body.segments.length === 0
        ) {
          return json({
            error:
              "ဘာသာပြန်ရန် segments array လိုအပ်ပါသည်။"
          }, 400);
        }

        if (body.segments.length > 500) {
          return json({
            error:
              "တစ်ကြိမ်လျှင် segments 500 ခုအထိသာ လက်ခံပါသည်။"
          }, 413);
        }

        const segments = [];

        for (
          let i = 0;
          i < body.segments.length;
          i++
        ) {
          const segment = body.segments[i];

          if (
            !segment ||
            typeof segment !== "object" ||
            Array.isArray(segment)
          ) {
            return json({
              error:
                "segments[" + i + "] သည် object ဖြစ်ရပါမည်။"
            }, 400);
          }

          const text = String(
            segment.text ??
            segment.original ??
            ""
          ).trim();

          if (!text) {
            return json({
              error:
                "segments[" + i + "] တွင် text မရှိပါ။"
            }, 400);
          }

          const start = Number(segment.start);
          const end = Number(segment.end);

          segments.push({
            id: segment.id ?? i + 1,

            start: Number.isFinite(start)
              ? start
              : 0,

            end: Number.isFinite(end)
              ? end
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

        const lineCount =
          body.lineCount ?? "2";

        const result = [];

        for (
          let i = 0;
          i < segments.length;
          i += 20
        ) {
          const batch = segments.slice(
            i,
            i + 20
          );

          try {
            const translated =
              await translateBatch(
                batch,
                env,
                tone,
                lineCount
              );

            result.push(...translated);
          } catch (error) {
            return json({
              error:
                "Gemini translation မအောင်မြင်ပါ။",

              status:
                Number(error?.status) || 502,

              detail:
                error instanceof Error
                  ? error.message
                  : String(error),

              model:
                error?.model ||
                String(
                  env.GEMINI_MODEL ||
                  "gemini-2.5-flash"
                ),

              batch:
                Math.floor(i / 20) + 1
            }, Number(error?.status) || 502);
          }
        }

        return json({
          result,

          model: String(
            env.GEMINI_MODEL ||
            "gemini-2.5-flash"
          )
        });
      }

      return json({
        error: "Not found",
        path
      }, 404);

    } catch (error) {
      return json({
        error:
          "Worker အတွင်းပိုင်းအမှား ဖြစ်ပေါ်ခဲ့သည်။",

        detail:
          error instanceof Error
            ? error.message
            : String(error)
      }, 500);
    }
  }
};
