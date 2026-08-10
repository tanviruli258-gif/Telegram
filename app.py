import os
import time
import uuid
import threading
import requests
from flask import Flask, request, redirect, render_template_string, send_from_directory, jsonify

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

# ---------------------------------------------------------
# ------------------- CloudConvert অংশ ---------------------
# ---------------------------------------------------------
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif")


def cloudconvert_convert_to_3gp(input_path, filename):
    if not CLOUDCONVERT_API_KEY or "PASTE_YOUR" in CLOUDCONVERT_API_KEY:
        raise RuntimeError("CLOUDCONVERT_API_KEY সেট করা হয়নি (Railway Variables-এ যোগ করো)")

    headers = {"Authorization": f"Bearer {CLOUDCONVERT_API_KEY}"}
    ext = os.path.splitext(filename)[1].lower()
    is_image = ext in IMAGE_EXTS

    convert_task = {
        "operation": "convert",
        "input": "upload-file",
        "output_format": "3gp",
        "engine": "ffmpeg",
    }
    if is_image:
        # ছবি থেকে ভিডিও বানাতে হলে input_format ও duration (সেকেন্ড) লাগবে,
        # নাহলে CloudConvert টাস্কটা error দিয়ে ফেল করায়
        convert_task["input_format"] = ext.lstrip(".")
        convert_task["duration"] = 5

    job_payload = {
        "tasks": {
            "upload-file": {"operation": "import/upload"},
            "convert-file": convert_task,
            "export-file": {
                "operation": "export/url",
                "input": "convert-file"
            }
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
        # আসল কারণটা বের করে আনা — কোন টাস্ক কেন ব্যর্থ হলো, CloudConvert নিজেই তা বলে দেয়
        failed_tasks = [t for t in job["tasks"] if t["status"] == "error"]
        if failed_tasks:
            t = failed_tasks[0]
            reason = t.get("message") or "অজানা কারণ"
            code = t.get("code")
            raise RuntimeError(f"({t['name']}{' / ' + code if code else ''}) {reason}")
        raise RuntimeError("CloudConvert job ব্যর্থ হয়েছে, কিন্তু কারণ পাওয়া যায়নি")

    export_task = next(t for t in job["tasks"] if t["name"] == "export-file")
    file_info = export_task["result"]["files"][0]
    file_url = file_info["url"]
    out_filename = file_info["filename"]

    output_path = os.path.join(CONVERTED_FOLDER, out_filename)
    dl = requests.get(file_url, timeout=600)
    dl.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(dl.content)

    return out_filename


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


def send_message(chat_id, text):
    try:
        requests.post(f"{TG_API}/sendMessage", json={"chat_id": chat_id, "text": text}, timeout=15)
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
                msg = update.get("message")
                if not msg:
                    continue
                chat_id = msg["chat"]["id"]
                LAST_CHAT_ID["id"] = chat_id

                file_id = None
                orig_name = None
                if "video" in msg:
                    file_id = msg["video"]["file_id"]
                    orig_name = f"video_{uuid.uuid4().hex[:8]}.mp4"
                elif "document" in msg:
                    file_id = msg["document"]["file_id"]
                    orig_name = msg["document"].get("file_name", f"doc_{uuid.uuid4().hex[:8]}")
                elif "photo" in msg:
                    file_id = msg["photo"][-1]["file_id"]
                    orig_name = f"photo_{uuid.uuid4().hex[:8]}.jpg"
                elif "text" in msg and msg["text"] == "/start":
                    send_message(chat_id, f"স্বাগতম! ফাইল ফরওয়ার্ড করো, তারপর ওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}")

                if file_id:
                    try:
                        download_telegram_file(file_id, orig_name)
                        send_message(chat_id, f"ফাইল সেভ হয়েছে: {orig_name}\nওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}")
                    except Exception as e:
                        send_message(chat_id, f"ফাইল সেভ করতে সমস্যা হয়েছে: {e}")
        except Exception:
            time.sleep(5)


# ---------------------------------------------------------
# ---------------------- Web রুট -----------------------------
# ---------------------------------------------------------
BASE_STYLE = """
<style>
  :root{
    --bg:#0f1115; --card:#171a21; --card-border:#262b36;
    --accent:#5b8def; --accent2:#7c5cff; --text:#eef1f7; --muted:#8a90a2;
    --ok:#35c98d; --err:#ff5c7a; --warn:#f5a623;
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:20px 14px 60px; background:var(--bg); color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  .wrap{max-width:480px;margin:0 auto}
  .hero{
    background:linear-gradient(135deg,var(--accent),var(--accent2));
    border-radius:16px; padding:18px 20px; margin-bottom:20px;
    box-shadow:0 8px 24px rgba(91,141,239,.25);
  }
  .hero h1{margin:0 0 4px;font-size:20px}
  .hero p{margin:0;font-size:13px;opacity:.9}
  h2.section{font-size:13px;text-transform:uppercase;letter-spacing:.06em;
    color:var(--muted);margin:22px 2px 8px;font-weight:600}
  .card{
    background:var(--card); border:1px solid var(--card-border);
    border-radius:14px; padding:14px 16px; margin-bottom:10px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
  }
  .fname{font-size:14px; word-break:break-all; line-height:1.4}
  .empty{color:var(--muted); font-size:13px; padding:10px 4px}
  .btn{
    background:var(--accent); color:#fff; border:none; padding:9px 16px;
    border-radius:9px; font-size:13px; text-decoration:none; white-space:nowrap;
    display:inline-block; cursor:pointer; font-weight:600;
  }
  .btn.dl{background:var(--ok)}
  .btn.ghost{background:transparent;border:1px solid var(--card-border);color:var(--text)}
  form.upload{
    background:var(--card); border:1px dashed var(--card-border);
    border-radius:14px; padding:16px; text-align:center; margin-bottom:8px;
  }
  input[type=file]{color:var(--muted); font-size:12px; width:100%; margin-bottom:10px}
  .status-box{
    text-align:center; padding:40px 16px; background:var(--card);
    border:1px solid var(--card-border); border-radius:16px; margin-top:10px;
  }
  .spinner{
    width:36px;height:36px;margin:0 auto 16px;border-radius:50%;
    border:3px solid var(--card-border); border-top-color:var(--accent);
    animation:spin 0.9s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-box h3{margin:0 0 6px;font-size:17px}
  .status-box p{color:var(--muted);font-size:13px;margin:0 0 18px}
  .status-box.err h3{color:var(--err)}
  .status-box.err p{color:var(--text); background:#2a1620; padding:10px 12px;
    border-radius:8px; text-align:left; word-break:break-word; font-size:12.5px}
  .status-box.ok h3{color:var(--ok)}
  .back{display:block;text-align:center;margin-top:16px;color:var(--muted);font-size:13px;text-decoration:none}
</style>
"""

PAGE = """
<!doctype html>
<html lang="bn">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>3GP Converter</title>
""" + BASE_STYLE + """
</head>
<body>
<div class="wrap">
  <div class="hero">
    <h1>📼 MP4 / JPG → 3GP</h1>
    <p>বাটন ফোনে চালানোর জন্য ভিডিও/ছবি কনভার্ট করো</p>
  </div>

  <form class="upload" method="POST" action="/upload" enctype="multipart/form-data">
    <input type="file" name="file" accept="video/*,image/*" required>
    <button class="btn" type="submit" style="width:100%">⬆️ নতুন ফাইল আপলোড করো</button>
  </form>

  <h2 class="section">📥 Telegram থেকে সেভ হওয়া ফাইল</h2>
  {% for f in telegram_files %}
    <div class="card">
      <span class="fname">{{ f }}</span>
      <a class="btn" href="/convert/telegram/{{ f }}">কনভার্ট</a>
    </div>
  {% else %}
    <div class="empty">এখনো কোনো ফাইল নেই — বটে ভিডিও/ছবি ফরওয়ার্ড করো</div>
  {% endfor %}

  <h2 class="section">🗂️ আপলোড করা ফাইল</h2>
  {% for f in uploaded_files %}
    <div class="card">
      <span class="fname">{{ f }}</span>
      <a class="btn" href="/convert/upload/{{ f }}">কনভার্ট</a>
    </div>
  {% else %}
    <div class="empty">কোনো ফাইল নেই</div>
  {% endfor %}

  <h2 class="section">✅ কনভার্ট হওয়া 3GP ফাইল</h2>
  {% for f in converted_files %}
    <div class="card">
      <span class="fname">{{ f }}</span>
      <a class="btn dl" href="/download/{{ f }}">ডাউনলোড</a>
    </div>
  {% else %}
    <div class="empty">কোনো ফাইল নেই</div>
  {% endfor %}
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