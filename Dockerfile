FROM python:3.10-slim

# FFmpeg, fontconfig နှင့် အခြေခံ Linux tools များ သွင်းခြင်း
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    fonts-noto-core \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python packages များ သွင်းခြင်း
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Fonts, Uploads, Temp ဖိုင်များ သိမ်းဆည်းမည့် Folders ပြင်ဆင်ခြင်း
RUN mkdir -p /app/fonts /app/templates /app/static /app/uploads /app/outputs

# အပလီကေးရှင်း ကုဒ်များ ကူးယူခြင်း
COPY . .

# Font cache update ပြုလုပ်ခြင်း
RUN fc-cache -f -v

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
