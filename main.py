import os
import json
import uuid
import shutil
import subprocess
from pathlib import Path
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import yt_dlp
from groq import Groq
import google.generativeai as genai

app = FastAPI(title="Myanmar SRT Studio")

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
FONTS_DIR = BASE_DIR / "fonts"
TEMPLATES_DIR = BASE_DIR / "templates"

for d in [UPLOAD_DIR, OUTPUT_DIR, FONTS_DIR, TEMPLATES_DIR]:
    d.mkdir(parents=True, exist_ok=True)

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_DIR)), name="outputs")
app.mount("/fonts", StaticFiles(directory=str(FONTS_DIR)), name="fonts")

JOBS: Dict[str, Dict[str, Any]] = {}

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")


def update_job(job_id: str, step: str, progress: int, message: str, status: str = "processing", data: Any = None):
    JOBS[job_id] = {
        "job_id": job_id,
        "step": step,
        "progress": progress,
        "message": message,
        "status": status,
        "data": data
    }


def hex_to_ass_color(hex_color: str, opacity: float = 1.0) -> str:
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        hex_color = "FFFFFF"
    r = hex_color[0:2]
    g = hex_color[2:4]
    b = hex_color[4:6]
    alpha = int((1.0 - max(0.0, min(1.0, opacity))) * 255)
    alpha_hex = f"{alpha:02X}"
    return f"&H{alpha_hex}{b}{g}{r}"


def seconds_to_ass_time(seconds: float) -> str:
    hrs = int(seconds // 3600)
    mins = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    centisecs = int(round((seconds - int(seconds)) * 100))
    if centisecs >= 100:
        centisecs = 99
    return f"{hrs}:{mins:02d}:{secs:02d}.{centisecs:02d}"


def get_font_family_name(font_path: Path) -> str:
    try:
        res = subprocess.run(
            ["fc-scan", "--format", "%{family}", str(font_path)],
            capture_output=True, text=True, check=True
        )
        family = res.stdout.strip().split(",")[0]
        return family if family else "Noto Sans Myanmar"
    except Exception:
        return "Noto Sans Myanmar"


@app.get("/", response_class=HTMLResponse)
async def index():
    # templates/index.html သို့မဟုတ် root ရှိ index.html ကို တိုက်ရိုက်ဖတ်ပေးခြင်း (Jinja2 error လုံးဝမတက်စေရန်)
    html_file = TEMPLATES_DIR / "index.html"
    if not html_file.exists():
        html_file = BASE_DIR / "index.html"
    if html_file.exists():
        return HTMLResponse(content=html_file.read_text(encoding="utf-8"), status_code=200)
    return HTMLResponse(content="<h3>index.html ဖိုင် မတွေ့ပါ။ templates/index.html ကို စစ်ဆေးပေးပါ။</h3>", status_code=404)


@app.get("/api/job/{job_id}")
async def get_job_status(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(status_code=404, detail="Job not found")
    return JSONResponse(JOBS[job_id])


@app.post("/api/upload-font")
async def upload_font(font_file: UploadFile = File(...)):
    if not font_file.filename.lower().endswith((".ttf", ".otf")):
        raise HTTPException(status_code=400, detail="Only .ttf or .otf files allowed")
    
    font_id = f"custom_{uuid.uuid4().hex[:8]}_{font_file.filename}"
    font_path = FONTS_DIR / font_id
    with open(font_path, "wb") as f:
        shutil.copyfileobj(font_file.file, f)
    
    sys_font_dir = Path("/usr/share/fonts/truetype/custom")
    sys_font_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(str(font_path), str(sys_font_dir / font_id))
    subprocess.run(["fc-cache", "-f"], check=False)
    
    family_name = get_font_family_name(font_path)
    return {
        "font_id": font_id,
        "font_url": f"/fonts/{font_id}",
        "family_name": family_name
    }


@app.post("/api/upload-logo")
async def upload_logo(logo_file: UploadFile = File(...)):
    logo_id = f"logo_{uuid.uuid4().hex[:8]}_{logo_file.filename}"
    logo_path = UPLOAD_DIR / logo_id
    with open(logo_path, "wb") as f:
        shutil.copyfileobj(logo_file.file, f)
    return {"logo_id": logo_id, "logo_url": f"/uploads/{logo_id}"}


def process_pipeline_task(job_id: str, video_path: Path, groq_key: str, gemini_key: str):
    try:
        update_job(job_id, "Audio Extraction", 15, "ဗီဒီယိုထဲမှ အသံဖိုင် (Audio) ကို ခွဲထုတ်နေပါသည်...")
        audio_path = UPLOAD_DIR / f"{job_id}.mp3"
        cmd_audio = [
            "ffmpeg", "-y", "-i", str(video_path),
            "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
            str(audio_path)
        ]
        subprocess.run(cmd_audio, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

        update_job(job_id, "Groq Speech-to-Text", 40, "Groq AI (Whisper) ဖြင့် English စာသားနှင့် အချိန်မှတ်များ ထုတ်ယူနေပါသည်...")
        g_client = Groq(api_key=groq_key)
        with open(audio_path, "rb") as af:
            transcription = g_client.audio.transcriptions.create(
                file=(audio_path.name, af.read()),
                model="whisper-large-v3",
                response_format="verbose_json",
            )

        segments = getattr(transcription, "segments", [])
        if not segments and isinstance(transcription, dict):
            segments = transcription.get("segments", [])

        subtitles = []
        for idx, seg in enumerate(segments):
            s_start = seg.get("start", 0.0) if isinstance(seg, dict) else getattr(seg, "start", 0.0)
            s_end = seg.get("end", 0.0) if isinstance(seg, dict) else getattr(seg, "end", 0.0)
            s_text = (seg.get("text", "") if isinstance(seg, dict) else getattr(seg, "text", "")).strip()
            if s_text:
                subtitles.append({
                    "id": idx + 1,
                    "start": round(float(s_start), 2),
                    "end": round(float(s_end), 2),
                    "en": s_text,
                    "my": ""
                })

        update_job(job_id, "Gemini Translation", 70, "Gemini AI ဖြင့် English စာသားများကို မြန်မာဘာသာသို့ ပြန်ဆိုနေပါသည်...")
        genai.configure(api_key=gemini_key)
        model = genai.GenerativeModel("gemini-1.5-flash")

        batch_size = 40
        for i in range(0, len(subtitles), batch_size):
            batch = subtitles[i:i + batch_size]
            input_payload = [{"id": item["id"], "en": item["en"]} for item in batch]
            prompt = (
                "You are a professional English-to-Myanmar video subtitle translator.\n"
                "Translate the following JSON array of English subtitle lines into natural, accurate spoken Burmese (Myanmar Unicode).\n"
                "Return ONLY a valid JSON array with objects containing 'id' and 'my'. Do not include markdown blocks.\n\n"
                f"Input: {json.dumps(input_payload, ensure_ascii=False)}"
            )
            resp = model.generate_content(prompt)
            raw_text = resp.text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            try:
                translated_list = json.loads(raw_text)
                trans_map = {item["id"]: item["my"] for item in translated_list if "id" in item and "my" in item}
                for item in batch:
                    item["my"] = trans_map.get(item["id"], item["en"])
            except Exception:
                for item in batch:
                    item["my"] = item["en"]

            pct = 70 + int(((i + len(batch)) / max(1, len(subtitles))) * 25)
            update_job(job_id, "Gemini Translation", min(95, pct), f"မြန်မာဘာသာပြန်ဆိုနေသည် ({i + len(batch)}/{len(subtitles)})...")

        if audio_path.exists():
            audio_path.unlink()

        update_job(
            job_id, "Completed", 100, "စာတန်းထိုး ထုတ်ယူမှု အောင်မြင်ပါပြီ။",
            status="completed",
            data={
                "video_url": f"/uploads/{video_path.name}",
                "video_filename": video_path.name,
                "subtitles": subtitles
            }
        )
    except Exception as e:
        update_job(job_id, "Error", 0, f"အမှားအယွင်း ဖြစ်ပေါ်ပါသည်: {str(e)}", status="error")


@app.post("/api/process-media")
async def start_process_media(
    background_tasks: BackgroundTasks,
    video_file: Optional[UploadFile] = File(None),
    youtube_url: Optional[str] = Form(None),
    custom_groq_key: Optional[str] = Form(None),
    custom_gemini_key: Optional[str] = Form(None)
):
    groq_key = custom_groq_key or GROQ_API_KEY
    gemini_key = custom_gemini_key or GEMINI_API_KEY

    if not groq_key or not gemini_key:
        raise HTTPException(status_code=400, detail="Groq API Key နှင့် Gemini API Key လိုအပ်ပါသည်။")

    job_id = uuid.uuid4().hex[:10]
    video_path = UPLOAD_DIR / f"vid_{job_id}.mp4"

    if video_file and video_file.filename:
        update_job(job_id, "Uploading Video", 5, "ဖုန်းထဲမှ ဗီဒီယိုဖိုင်ကို လက်ခံနေပါသည်...")
        with open(video_path, "wb") as f:
            shutil.copyfileobj(video_file.file, f)
        background_tasks.add_task(process_pipeline_task, job_id, video_path, groq_key, gemini_key)
    elif youtube_url:
        update_job(job_id, "YouTube Download", 5, "YouTube မှ ဗီဒီယိုနှင့် အသံကို ဒေါင်းလုဒ်ဆွဲနေပါသည်...")

        def dl_and_process():
            try:
                ydl_opts = {
                    "format": "best[ext=mp4][height<=720]/bestvideo[height<=720]+bestaudio/best",
                    "outtmpl": str(video_path),
                    "merge_output_format": "mp4",
                    "noplaylist": True,
                    "quiet": True,
                    "extractor_args": {
                        "youtube": {
                            "player_client": ["android", "ios", "web"]
                        }
                    }
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([youtube_url])
                process_pipeline_task(job_id, video_path, groq_key, gemini_key)
            except Exception as e:
                update_job(
                    job_id, "Error", 0,
                    f"YouTube Server Block ဖြစ်နေပါသည် (ဖုန်းထဲမှ Video File တိုက်ရိုက်ရွေးတင်ပေးပါ): {str(e)}",
                    status="error"
                )

        background_tasks.add_task(dl_and_process)
    else:
        raise HTTPException(status_code=400, detail="ဗီဒီယိုဖိုင် သို့မဟုတ် YouTube URL ထည့်ပေးပါ။")

    return {"job_id": job_id}


class RenderRequest(BaseModel):
    video_filename: str
    aspect_ratio: str
    vid_scale: float = 1.0
    vid_offset_x: float = 0.0
    vid_offset_y: float = 0.0
    font_family: str = "Noto Sans Myanmar"
    subtitles: List[Dict[str, Any]]
    en_style: Dict[str, Any]
    my_style: Dict[str, Any]
    title_config: Dict[str, Any]
    logo_config: Optional[Dict[str, Any]] = None


def render_video_task(job_id: str, req: RenderRequest):
    try:
        update_job(job_id, "Preparing Render", 10, "ဗီဒီယို အချိုးအစားနှင့် စာတန်းထိုး ဒီဇိုင်းများ ပြင်ဆင်နေပါသည်...")
        input_video = UPLOAD_DIR / req.video_filename
        if not input_video.exists():
            raise FileNotFoundError("မူရင်း ဗီဒီယိုဖိုင် မရှိတော့ပါ။")

        if req.aspect_ratio == "9:16":
            out_w, out_h = 720, 1280
        elif req.aspect_ratio == "1:1":
            out_w, out_h = 720, 720
        else:
            out_w, out_h = 1280, 720

        ass_path = UPLOAD_DIR / f"sub_{job_id}.ass"
        font_name = req.font_family or "Noto Sans Myanmar"

        en_s = req.en_style
        my_s = req.my_style
        ti_s = req.title_config

        en_color = hex_to_ass_color(en_s.get("color", "#FFFFFF"), 1.0)
        en_bg = hex_to_ass_color(en_s.get("bg_color", "#000000"), float(en_s.get("bg_opacity", 0.6)))
        en_size = int(en_s.get("size", 28))

        my_color = hex_to_ass_color(my_s.get("color", "#FFFF00"), 1.0)
        my_bg = hex_to_ass_color(my_s.get("bg_color", "#000000"), float(my_s.get("bg_opacity", 0.6)))
        my_size = int(my_s.get("size", 32))

        ti_color = hex_to_ass_color(ti_s.get("color", "#FFFFFF"), 1.0)
        ti_bg = hex_to_ass_color(ti_s.get("bg_color", "#E50914"), float(ti_s.get("bg_opacity", 0.8)))
        ti_size = int(ti_s.get("size", 38))

        ass_content = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {out_w}
PlayResY: {out_h}
WrapStyle: 1

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: EngStyle,{font_name},{en_size},{en_color},{en_color},{en_bg},{en_bg},0,0,0,0,100,100,0,0,3,6,0,5,10,10,10,1
Style: MyStyle,{font_name},{my_size},{my_color},{my_color},{my_bg},{my_bg},0,0,0,0,100,100,0,0,3,6,0,5,10,10,10,1
Style: TitleStyle,{font_name},{ti_size},{ti_color},{ti_color},{ti_bg},{ti_bg},-1,0,0,0,100,100,0,0,3,10,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
        en_x = int(float(en_s.get("x_pct", 0.5)) * out_w)
        en_y = int(float(en_s.get("y_pct", 0.78)) * out_h)

        my_x = int(float(my_s.get("x_pct", 0.5)) * out_w)
        my_y = int(float(my_s.get("y_pct", 0.88)) * out_h)

        title_text = (ti_s.get("text") or "").strip()
        if title_text:
            ti_x = int(float(ti_s.get("x_pct", 0.5)) * out_w)
            ti_y = int(float(ti_s.get("y_pct", 0.10)) * out_h)
            safe_title = title_text.replace("\n", "\\N")
            ass_content += f"Dialogue: 2,0:00:00.00,9:59:59.00,TitleStyle,,0,0,0,,{{\\pos({ti_x},{ti_y})}}{safe_title}\n"

        for sub in req.subtitles:
            st = seconds_to_ass_time(float(sub.get("start", 0)))
            et = seconds_to_ass_time(float(sub.get("end", 0)))
            en_txt = (sub.get("en") or "").strip().replace("\n", "\\N")
            my_txt = (sub.get("my") or "").strip().replace("\n", "\\N")

            if en_txt and en_s.get("show", True):
                ass_content += f"Dialogue: 1,{st},{et},EngStyle,,0,0,0,,{{\\pos({en_x},{en_y})}}{en_txt}\n"
            if my_txt and my_s.get("show", True):
                ass_content += f"Dialogue: 1,{st},{et},MyStyle,,0,0,0,,{{\\pos({my_x},{my_y})}}{my_txt}\n"

        with open(ass_path, "w", encoding="utf-8") as f:
            f.write(ass_content)

        update_job(job_id, "FFmpeg Rendering", 45, "FFmpeg ဖြင့် ဗီဒီယိုထဲသို့ စာတန်းထိုး၊ Logo နှင့် ဒီဇိုင်းများ မြှုပ်နှံနေပါသည်...")

        scale_factor = max(0.2, min(4.0, float(req.vid_scale)))
        scaled_w = int(out_w * scale_factor)
        scaled_h = int(out_h * scale_factor)
        scaled_w += scaled_w % 2
        scaled_h += scaled_h % 2

        pan_x = int(float(req.vid_offset_x) * out_w)
        pan_y = int(float(req.vid_offset_y) * out_h)

        output_filename = f"final_{job_id}.mp4"
        output_path = OUTPUT_DIR / output_filename

        ass_escaped = str(ass_path).replace("\\", "/").replace(":", "\\:")
        fonts_dir_escaped = str(FONTS_DIR).replace("\\", "/").replace(":", "\\:")

        vf_chain = (
            f"color=c=black:s={out_w}x{out_h}[bg];"
            f"[0:v]scale={scaled_w}:{scaled_h}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2+({pan_x}):(H-h)/2+({pan_y}):shortest=1[canvas]"
        )

        inputs = ["-i", str(input_video)]
        last_node = "[canvas]"

        if req.logo_config and req.logo_config.get("logo_id"):
            logo_file = UPLOAD_DIR / req.logo_config["logo_id"]
            if logo_file.exists():
                inputs.extend(["-i", str(logo_file)])
                logo_w = int(float(req.logo_config.get("size_pct", 0.18)) * out_w)
                logo_x = int(float(req.logo_config.get("x_pct", 0.85)) * out_w - (logo_w / 2))
                logo_y = int(float(req.logo_config.get("y_pct", 0.10)) * out_h - (logo_w / 2))
                vf_chain += f";[1:v]scale={logo_w}:-1[logo];{last_node}[logo]overlay={logo_x}:{logo_y}[with_logo]"
                last_node = "[with_logo]"

        vf_chain += f";{last_node}ass='{ass_escaped}':fontsdir='{fonts_dir_escaped}'[outv]"

        cmd_render = [
            "ffmpeg", "-y",
            *inputs,
            "-filter_complex", vf_chain,
            "-map", "[outv]",
            "-map", "0:a?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            str(output_path)
        ]

        subprocess.run(cmd_render, check=True)

        if ass_path.exists():
            ass_path.unlink()

        update_job(
            job_id, "Render Completed", 100,
            "ဗီဒီယို Render ပြုလုပ်ခြင်း အောင်မြင်ပါပြီ။ ဖုန်းထဲသို့ ဒေါင်းလုဒ်ဆွဲနိုင်ပါပြီ။",
            status="completed",
            data={"download_url": f"/outputs/{output_filename}"}
        )

    except Exception as e:
        update_job(job_id, "Render Error", 0, f"Render အမှားအယွင်း: {str(e)}", status="error")


@app.post("/api/render-video")
async def start_render_video(req: RenderRequest, background_tasks: BackgroundTasks):
    job_id = uuid.uuid4().hex[:10]
    update_job(job_id, "Starting Render", 5, "ဗီဒီယို Render လုပ်ငန်းစဉ် စတင်နေပါသည်...")
    background_tasks.add_task(render_video_task, job_id, req)
    return {"job_id": job_id}
