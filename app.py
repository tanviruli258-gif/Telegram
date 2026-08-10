import os
import time
import uuid
import threading
import requests
from flask import Flask, request, redirect, render_template_string, send_from_directory

# =========================================================
# এই ৩টা ভ্যারিয়েবল Railway ড্যাশবোর্ড -> Variables ট্যাবে বসাও
# (কোডে হার্ডকোড করলে GitHub-এ চলে গেলে key leak হয়ে যায়)
# =========================================================
CLOUDCONVERT_API_KEY = os.environ.get("CLOUDCONVERT_API_KEY", "PASTE_YOUR_CLOUDCONVERT_API_KEY_HERE")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE")
# Railway থেকে পাওয়া তোমার সাইটের পাবলিক URL, যেমন: https://myapp-production.up.railway.app
WEBSITE_URL = os.environ.get("WEBSITE_URL", "PASTE_YOUR_RAILWAY_PUBLIC_URL_HERE")
# =========================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
TELEGRAM_FOLDER = os.path.join(BASE_DIR, "from_telegram")
CONVERTED_FOLDER = os.path.join(BASE_DIR, "converted")
for folder in (UPLOAD_FOLDER, TELEGRAM_FOLDER, CONVERTED_FOLDER):
    os.makedirs(folder, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB আপলোড লিমিট

JOBS = {}  # job_id -> {"status": "...", "output": "filename বা None", "error": "..."}
LAST_CHAT_ID = {"id": None}  # শেষ যে ইউজার বটে মেসেজ পাঠিয়েছে তার chat_id (সিঙ্গেল-ইউজার সিস্টেম বলে ধরে নেওয়া হচ্ছে)
PENDING = {}  # pending_id -> {"file_id":..., "name":..., "chat_id":..., "message_id":...}

VIDEO_EXTS = (".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".3gp", ".3g2", ".ts", ".mpg", ".mpeg")

# ---------------------------------------------------------
# ------------------- CloudConvert অংশ ---------------------
# ---------------------------------------------------------
# CloudConvert এখন সরাসরি "convert" অপারেশনে output_format=3gp সাপোর্ট করে না
# (এই কারণেই "INVALID_CONVERSION_TYPE" এরর আসছিল)। তাই আমরা "command" অপারেশন
# ব্যবহার করে সরাসরি ffmpeg কমান্ড চালাচ্ছি — এটা যেকোনো ভিডিও থেকে আসল 3GP
# (H.263 ভিডিও + AAC অডিও, ছোট রেজোলিউশন) বানাতে পারে, বাটন ফোনের জন্য উপযুক্ত।


def cloudconvert_convert_to_3gp(input_path, filename):
    if not CLOUDCONVERT_API_KEY or "PASTE_YOUR" in CLOUDCONVERT_API_KEY:
        raise RuntimeError("CLOUDCONVERT_API_KEY সেট করা হয়নি (Railway Variables-এ যোগ করো)")

    headers = {"Authorization": f"Bearer {CLOUDCONVERT_API_KEY}"}
    safe_stem = os.path.splitext(filename)[0] or "video"
    out_filename = f"{safe_stem}_{uuid.uuid4().hex[:6]}.3gp"

    ffmpeg_args = (
        f"-i /input/upload-file/{filename} "
        f"-vf scale=176:144 -vcodec h263 -b:v 128k -r 15 "
        f"-acodec aac -ar 8000 -ac 1 -b:a 32k "
        f"-y /output/{out_filename}"
    )

    job_payload = {
        "tasks": {
            "upload-file": {"operation": "import/upload"},
            "convert-file": {
                "operation": "command",
                "input": "upload-file",
                "engine": "ffmpeg",
                "command": "ffmpeg",
                "arguments": ffmpeg_args,
            },
            "export-file": {
                "operation": "export/url",
                "input": "convert-file",
            },
        }
    }

    r = requests.post("https://api.cloudconvert.com/v2/jobs", json=job_payload, headers=headers, timeout=60)
    r.raise_for_status()
    job = r.json()["data"]

    upload_task = next(t for t in job["tasks"] if t["name"] == "upload-file")
    upload_url = upload_task["result"]["form"]["url"]
    upload_params = upload_task["result"]["form"]["parameters"]

    with open(input_path, "rb") as f:
        files = {"file": (filename, f)}
        up = requests.post(upload_url, data=upload_params, files=files, timeout=600)
        up.raise_for_status()

    job_id = job["id"]
    while True:
        time.sleep(4)
        r = requests.get(f"https://api.cloudconvert.com/v2/jobs/{job_id}", headers=headers, timeout=30)
        r.raise_for_status()
        job = r.json()["data"]
        if job["status"] in ("finished", "error"):
            break

    if job["status"] == "error":
        failed_tasks = [t for t in job["tasks"] if t["status"] == "error"]
        if failed_tasks:
            t = failed_tasks[0]
            reason = t.get("message") or "অজানা কারণ"
            code = t.get("code")
            raise RuntimeError(f"({t['name']}{' / ' + code if code else ''}) {reason}")
        raise RuntimeError("CloudConvert job ব্যর্থ হয়েছে, কিন্তু কারণ পাওয়া যায়নি")

    export_task = next(t for t in job["tasks"] if t["name"] == "export-file")
    result_files = export_task["result"]["files"]
    if not result_files:
        raise RuntimeError("কনভার্সন হয়েছে কিন্তু কোনো আউটপুট ফাইল পাওয়া যায়নি")
    file_info = result_files[0]
    file_url = file_info["url"]
    out_name = file_info.get("filename", out_filename)

    output_path = os.path.join(CONVERTED_FOLDER, out_name)
    dl = requests.get(file_url, timeout=600)
    dl.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(dl.content)

    return out_name


def background_convert(job_id, input_path, filename, send_to_telegram):
    try:
        JOBS[job_id]["status"] = "processing"
        out_filename = cloudconvert_convert_to_3gp(input_path, filename)
        JOBS[job_id]["status"] = "finished"
        JOBS[job_id]["output"] = out_filename

        if send_to_telegram and LAST_CHAT_ID["id"]:
            send_document_to_telegram(LAST_CHAT_ID["id"], os.path.join(CONVERTED_FOLDER, out_filename))
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)


# ---------------------------------------------------------
# -------------------- Telegram অংশ ------------------------
# ---------------------------------------------------------
TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


def set_menu_button():
    try:
        requests.post(f"{TG_API}/setChatMenuButton", json={
            "menu_button": {
                "type": "web_app",
                "text": "Open Website",
                "web_app": {"url": WEBSITE_URL}
            }
        }, timeout=15)
    except Exception:
        pass


def send_message(chat_id, text, reply_markup=None):
    try:
        payload = {"chat_id": chat_id, "text": text}
        if reply_markup:
            payload["reply_markup"] = reply_markup
        r = requests.post(f"{TG_API}/sendMessage", json=payload, timeout=15)
        return r.json().get("result")
    except Exception:
        return None


def edit_message(chat_id, message_id, text):
    try:
        requests.post(f"{TG_API}/editMessageText", json={
            "chat_id": chat_id, "message_id": message_id, "text": text
        }, timeout=15)
    except Exception:
        pass


def answer_callback_query(callback_id, text=None):
    try:
        payload = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text
        requests.post(f"{TG_API}/answerCallbackQuery", json=payload, timeout=15)
    except Exception:
        pass


def send_document_to_telegram(chat_id, filepath):
    try:
        with open(filepath, "rb") as f:
            requests.post(f"{TG_API}/sendDocument",
                           data={"chat_id": chat_id},
                           files={"document": f},
                           timeout=300)
    except Exception:
        pass


def download_telegram_file(file_id, save_as):
    r = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=30)
    r.raise_for_status()
    file_path = r.json()["result"]["file_path"]
    file_url = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
    dl = requests.get(file_url, timeout=300)
    dl.raise_for_status()
    save_path = os.path.join(TELEGRAM_FOLDER, save_as)
    with open(save_path, "wb") as f:
        f.write(dl.content)
    return save_path


def handle_incoming_video(chat_id, file_id, orig_name):
    pending_id = uuid.uuid4().hex[:10]
    PENDING[pending_id] = {"file_id": file_id, "name": orig_name, "chat_id": chat_id}
    keyboard = {
        "inline_keyboard": [[
            {"text": "✅ সেভ করুন", "callback_data": f"save:{pending_id}"},
            {"text": "🗑 ডিলিট করুন", "callback_data": f"del:{pending_id}"},
        ]]
    }
    msg = send_message(chat_id, f"🎬 ভিডিও পাওয়া গেছে: {orig_name}\nসেভ করবে নাকি ডিলিট করবে?", reply_markup=keyboard)
    if msg:
        PENDING[pending_id]["message_id"] = msg.get("message_id")


def handle_callback(callback):
    cq_id = callback["id"]
    data = callback.get("data", "")
    msg = callback.get("message") or {}
    chat_id = msg.get("chat", {}).get("id")
    message_id = msg.get("message_id")

    if ":" not in data:
        answer_callback_query(cq_id)
        return

    action, pending_id = data.split(":", 1)
    entry = PENDING.pop(pending_id, None)

    if not entry:
        answer_callback_query(cq_id, "এই রিকোয়েস্টের মেয়াদ শেষ হয়ে গেছে")
        return

    target_chat_id = chat_id or entry["chat_id"]
    target_message_id = message_id or entry.get("message_id")

    if action == "save":
        try:
            download_telegram_file(entry["file_id"], entry["name"])
            text = f"✅ সেভ হয়েছে: {entry['name']}\nওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}"
        except Exception as e:
            text = f"⚠️ সেভ করতে সমস্যা হয়েছে: {e}"
    else:
        text = f"🗑 ডিলিট করা হয়েছে: {entry['name']}"

    if target_message_id:
        edit_message(target_chat_id, target_message_id, text)
    else:
        send_message(target_chat_id, text)
    answer_callback_query(cq_id)


def telegram_polling_loop():
    set_menu_button()
    offset = None
    while True:
        try:
            params = {"timeout": 30}
            if offset:
                params["offset"] = offset
            r = requests.get(f"{TG_API}/getUpdates", params=params, timeout=40)
            data = r.json()
            for update in data.get("result", []):
                offset = update["update_id"] + 1

                callback = update.get("callback_query")
                if callback:
                    chat_id = callback.get("message", {}).get("chat", {}).get("id")
                    if chat_id:
                        LAST_CHAT_ID["id"] = chat_id
                    handle_callback(callback)
                    continue

                msg = update.get("message")
                if not msg:
                    continue
                chat_id = msg["chat"]["id"]
                LAST_CHAT_ID["id"] = chat_id

                file_id = None
                orig_name = None
                if "video" in msg:
                    file_id = msg["video"]["file_id"]
                    orig_name = msg["video"].get("file_name") or f"video_{uuid.uuid4().hex[:8]}.mp4"
                elif "document" in msg:
                    doc = msg["document"]
                    mime = doc.get("mime_type", "")
                    fname = doc.get("file_name", "")
                    if mime.startswith("video/") or fname.lower().endswith(VIDEO_EXTS):
                        file_id = doc["file_id"]
                        orig_name = fname or f"video_{uuid.uuid4().hex[:8]}.mp4"
                    else:
                        send_message(chat_id, "শুধুমাত্র ভিডিও ফাইল সাপোর্টেড। অন্য কোনো ফাইল গ্রহণযোগ্য নয়।")
                elif "text" in msg and msg["text"] == "/start":
                    send_message(chat_id, f"স্বাগতম! একটি ভিডিও ফরওয়ার্ড করো, তারপর সেভ করে ওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}")

                if file_id:
                    handle_incoming_video(chat_id, file_id, orig_name)
        except Exception:
            time.sleep(5)


# ---------------------------------------------------------
# ---------------------- Web রুট -----------------------------
# ---------------------------------------------------------
BASE_STYLE = """
<style>
  :root{
    --bg:#0b0d12; --bg2:#0f1218; --card:#151922; --card-border:#232838;
    --accent:#6c8dff; --accent2:#a76bff; --text:#f2f4fa; --muted:#8a90a8;
    --ok:#2fd189; --err:#ff5c7a; --warn:#f5b942;
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:22px 14px 40px; color:var(--text);
    background:
      radial-gradient(1200px 500px at 20% -10%, rgba(108,141,255,.16), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, rgba(167,107,255,.14), transparent 55%),
      var(--bg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    min-height:100vh;
  }
  .wrap{max-width:480px;margin:0 auto}
  .hero{
    position:relative; overflow:hidden;
    background:linear-gradient(135deg,var(--accent),var(--accent2));
    border-radius:20px; padding:22px 22px 20px; margin-bottom:22px;
    box-shadow:0 12px 32px rgba(108,141,255,.28);
  }
  .hero::after{
    content:""; position:absolute; right:-30px; top:-30px; width:140px; height:140px;
    background:rgba(255,255,255,.12); border-radius:50%;
  }
  .hero .icon{font-size:30px; margin-bottom:6px; display:block}
  .hero h1{margin:0 0 4px;font-size:21px; letter-spacing:.2px}
  .hero p{margin:0;font-size:13px;opacity:.92}
  h2.section{font-size:12.5px;text-transform:uppercase;letter-spacing:.08em;
    color:var(--muted);margin:24px 4px 10px;font-weight:700}
  .card{
    background:var(--card); border:1px solid var(--card-border);
    border-radius:15px; padding:14px 16px; margin-bottom:10px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    transition:border-color .15s ease, transform .15s ease;
  }
  .card:hover{border-color:var(--accent); transform:translateY(-1px)}
  .fname{font-size:13.5px; word-break:break-all; line-height:1.4; display:flex; align-items:center; gap:8px}
  .fname .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none}
  .empty{color:var(--muted); font-size:13px; padding:14px 4px; text-align:center;
    border:1px dashed var(--card-border); border-radius:14px}
  .btn{
    background:var(--accent); color:#fff; border:none; padding:9px 16px;
    border-radius:10px; font-size:13px; text-decoration:none; white-space:nowrap;
    display:inline-block; cursor:pointer; font-weight:700;
  }
  .btn.dl{background:var(--ok)}
  form.upload{
    background:linear-gradient(180deg, var(--card), var(--bg2));
    border:1px dashed var(--card-border);
    border-radius:16px; padding:18px; text-align:center; margin-bottom:8px;
  }
  form.upload .hint{font-size:12px;color:var(--muted);margin-bottom:10px}
  input[type=file]{color:var(--muted); font-size:12px; width:100%; margin-bottom:12px}
  .status-box{
    text-align:center; padding:44px 18px; background:var(--card);
    border:1px solid var(--card-border); border-radius:18px; margin-top:10px;
  }
  .spinner{
    width:38px;height:38px;margin:0 auto 16px;border-radius:50%;
    border:3px solid var(--card-border); border-top-color:var(--accent);
    animation:spin 0.9s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-box h3{margin:0 0 6px;font-size:17px}
  .status-box p{color:var(--muted);font-size:13px;margin:0 0 18px}
  .status-box.err h3{color:var(--err)}
  .status-box.err p{color:var(--text); background:#2a1620; padding:10px 12px;
    border-radius:10px; text-align:left; word-break:break-word; font-size:12.5px}
  .status-box.ok h3{color:var(--ok)}
  .back{display:block;text-align:center;margin-top:16px;color:var(--muted);font-size:13px;text-decoration:none}
  .footer{
    text-align:center; margin-top:34px; padding-top:16px;
    border-top:1px solid var(--card-border); color:var(--muted); font-size:12px;
  }
  .footer .badge{
    display:inline-block; margin-top:6px; padding:5px 12px; border-radius:999px;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff;
    font-weight:700; font-size:11.5px; letter-spacing:.3px;
  }
</style>
"""

PAGE = """
<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>3GP Video Converter</title>
""" + BASE_STYLE + """
</head>
<body>
<div class="wrap">
  <div class="hero">
    <span class="icon">🎬</span>
    <h1>MP4 → 3GP Converter</h1>
    <p>বাটন ফোনে চালানোর জন্য ভিডিও কনভার্ট করো — দ্রুত ও স্মার্ট</p>
  </div>

  <form class="upload" method="POST" action="/upload" enctype="multipart/form-data">
    <div class="hint">গ্যালারি থেকে যেকোনো ভিডিও ফাইল বেছে নাও</div>
    <input type="file" name="file" accept="video/*" required>
    <button class="btn" type="submit" style="width:100%">⬆️ নতুন ভিডিও আপলোড করো</button>
  </form>

  <h2 class="section">📥 Telegram থেকে সেভ হওয়া ভিডিও</h2>
  {% for f in telegram_files %}
    <div class="card">
      <span class="fname"><span class="dot"></span>{{ f }}</span>
      <a class="btn" href="/convert/telegram/{{ f }}">কনভার্ট</a>
    </div>
  {% else %}
    <div class="empty">এখনো কোনো ভিডিও নেই — বটে ভিডিও ফরওয়ার্ড করে "সেভ করুন" চাপো</div>
  {% endfor %}

  <h2 class="section">🗂️ আপলোড করা ভিডিও</h2>
  {% for f in uploaded_files %}
    <div class="card">
      <span class="fname"><span class="dot"></span>{{ f }}</span>
      <a class="btn" href="/convert/upload/{{ f }}">কনভার্ট</a>
    </div>
  {% else %}
    <div class="empty">কোনো ভিডিও নেই</div>
  {% endfor %}

  <h2 class="section">✅ কনভার্ট হওয়া 3GP ফাইল</h2>
  {% for f in converted_files %}
    <div class="card">
      <span class="fname"><span class="dot"></span>{{ f }}</span>
      <a class="btn dl" href="/download/{{ f }}">ডাউনলোড</a>
    </div>
  {% else %}
    <div class="empty">কোনো ফাইল নেই</div>
  {% endfor %}

  <div class="footer">
    Smart video tools for feature phones
    <div class="badge">Developed by TANVIR SIYAM</div>
  </div>
</div>
</body>
</html>
"""

STATUS_PAGE = """
<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  {% if status not in ("finished", "error") %}<meta http-equiv="refresh" content="3">{% endif %}
  <title>কনভার্ট হচ্ছে...</title>
""" + BASE_STYLE + """
</head>
<body>
<div class="wrap">
  {% if status == "finished" %}
    <div class="status-box ok">
      <div style="font-size:40px;margin-bottom:10px">✅</div>
      <h3>কনভার্সন শেষ!</h3>
      <p>তোমার 3GP ফাইল তৈরি হয়ে গেছে</p>
      <a class="btn dl" href="/download/{{ output }}">⬇️ ডাউনলোড করো</a>
    </div>
  {% elif status == "error" %}
    <div class="status-box err">
      <div style="font-size:40px;margin-bottom:10px">⚠️</div>
      <h3>কনভার্সন ব্যর্থ হয়েছে</h3>
      <p>{{ error }}</p>
    </div>
  {% else %}
    <div class="status-box">
      <div class="spinner"></div>
      <h3>কনভার্ট হচ্ছে...</h3>
      <p>পেজটা এমনিতেই রিফ্রেশ হবে, একটু অপেক্ষা করো</p>
    </div>
  {% endif %}
  <a class="back" href="/">← হোমে ফিরে যাও</a>
  <div class="footer">
    <div class="badge">Developed by TANVIR SIYAM</div>
  </div>
</div>
</body>
</html>
"""


@app.route("/")
def home():
    return render_template_string(
        PAGE,
        telegram_files=os.listdir(TELEGRAM_FOLDER),
        uploaded_files=os.listdir(UPLOAD_FOLDER),
        converted_files=os.listdir(CONVERTED_FOLDER),
    )


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files["file"]
    save_path = os.path.join(UPLOAD_FOLDER, f.filename)
    f.save(save_path)
    return redirect("/")


@app.route("/convert/<source>/<path:filename>")
def convert(source, filename):
    folder = TELEGRAM_FOLDER if source == "telegram" else UPLOAD_FOLDER
    input_path = os.path.join(folder, filename)
    if not os.path.exists(input_path):
        return "ফাইল খুঁজে পাওয়া যায়নি", 404

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "queued", "output": None, "error": None}

    send_to_tg = (source == "telegram")
    thread = threading.Thread(target=background_convert, args=(job_id, input_path, filename, send_to_tg))
    thread.start()

    return redirect(f"/status/{job_id}")


@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return "জব খুঁজে পাওয়া যায়নি", 404
    return render_template_string(STATUS_PAGE, status=job["status"], output=job["output"], error=job["error"])


@app.route("/download/<path:filename>")
def download(filename):
    return send_from_directory(CONVERTED_FOLDER, filename, as_attachment=True)


if __name__ == "__main__":
    bot_thread = threading.Thread(target=telegram_polling_loop, daemon=True)
    bot_thread.start()

    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
