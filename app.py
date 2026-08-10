import os
import time
import uuid
import threading
import requests
from flask import Flask, request, redirect, render_template_string, send_from_directory, jsonify

# =========================================================
# ============  এই ৩টা ভ্যারিয়েবল বসাও  ====================
# =========================================================
CLOUDCONVERT_API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiIxIiwianRpIjoiOTQ1ODRjMjg0ZGExZjY5NzE2ZjIxMTJjNjZkOTMzMGE2YTNjNGU2ZWExNDgxZTFkM2MwZGIxN2UyNWI2MzgxNGY5M2U1YzVkZDFiMDRjM2YiLCJpYXQiOjE3ODYzNDg2MzQuNDQ4OTIsIm5iZiI6MTc4NjM0ODYzNC40NDg5MjEsImV4cCI6NDk0MjAyMjIzNC40NDAxNzYsInN1YiI6Ijc2NTczMTUxIiwic2NvcGVzIjpbInVzZXIucmVhZCIsInVzZXIud3JpdGUiLCJ0YXNrLnJlYWQiLCJ3ZWJob29rLnJlYWQiLCJ0YXNrLndyaXRlIiwid2ViaG9vay53cml0ZSIsInByZXNldC5yZWFkIiwicHJlc2V0LndyaXRlIl19.o_GpsGUNiniAcpF-MmpknLvIsQTplEk1GZIIzm0nLalLjhEzN4t2lUE9Hz8ZxcKnA4CVcO1vwyJ932bTEc2dC8VKa1JcBx1idBKA3epIHeWnhCyzKlerYZU_CI69nGY5ZSyEXhZmSyN8osgOy2UpdAZx2Tn-_DhNVbGAE7GZUabC1TOzctjO78wzWnoF7u0gkKNBJccacjR-xvlhqyz31kE0N5x7MpOrceCHdlrlbR1E8Cc2k0rKO4LB43TaOymqolNAHY5yxvpq01jTEDOgBglVyzAE09HcbbmiWtEESSxR4OBBOLAwA8jQMRJV3XZ6uBIy_yEUDsM5TULp_qopapDkpIjFZAoNuYy5HlhduZ7F9YXd2q1zsmt8ldJYM61_Y8H550imQSpvXKS4j4dL4Zzc0BIIuXIZAonpDsZ1_1s6ujELWxFus9Igu0QeQZMgjWQTuFK_eVLSHwJI_KjO3QCKGU6QSnUNhLiC36jjZm6Jsi0dc4A2dw-mKIlIHNje4XVmXu2JviVA3UnypNzm15_iw0iyG6gFNJVCiyrAc9uBCaaFEYgYhKWkJpFtHxMFleYKXBTve8kQ1NgSo_9fWy_aaZscbniVSGvezjE4AU7Cf_DH2__oHOE_6ZU4Q-ODrZGukFvr8en6GpKqM605uERW12djkU1TU2g4NeU0lOA"
TELEGRAM_BOT_TOKEN = "7685589352:AAF9FMVJmZMLiQZhgINOMn9DAt3g_alQR6Y"
# Railway থেকে পাওয়া তোমার সাইটের পাবলিক URL, যেমন: https://myapp-production.up.railway.app
WEBSITE_URL = "https://web-production-ed0a9.up.railway.app/"
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
def cloudconvert_convert_to_3gp(input_path, filename):
    headers = {"Authorization": f"Bearer {CLOUDCONVERT_API_KEY}"}

    job_payload = {
        "tasks": {
            "upload-file": {"operation": "import/upload"},
            "convert-file": {
                "operation": "convert",
                "input": "upload-file",
                "output_format": "3gp",
                "engine": "ffmpeg"
            },
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
        raise RuntimeError("CloudConvert conversion failed")

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
PAGE = """
<!doctype html>
<html>
<head><meta charset="utf-8"><title>MP4/JPG to 3GP Converter</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:30px auto;">
<h2>MP4 / JPG → 3GP কনভার্টার</h2>

<h3>নতুন ফাইল আপলোড করো</h3>
<form method="POST" action="/upload" enctype="multipart/form-data">
  <input type="file" name="file" required>
  <button type="submit">আপলোড করো</button>
</form>

<h3>Telegram থেকে সেভ হওয়া ফাইল</h3>
<ul>
{% for f in telegram_files %}
  <li>{{ f }} — <a href="/convert/telegram/{{ f }}">কনভার্ট করো</a></li>
{% else %}
  <li>কোনো ফাইল নেই</li>
{% endfor %}
</ul>

<h3>আপলোড করা ফাইল</h3>
<ul>
{% for f in uploaded_files %}
  <li>{{ f }} — <a href="/convert/upload/{{ f }}">কনভার্ট করো</a></li>
{% else %}
  <li>কোনো ফাইল নেই</li>
{% endfor %}
</ul>

<h3>কনভার্ট হওয়া 3GP ফাইল</h3>
<ul>
{% for f in converted_files %}
  <li><a href="/download/{{ f }}">{{ f }}</a></li>
{% else %}
  <li>কোনো ফাইল নেই</li>
{% endfor %}
</ul>
</body>
</html>
"""

STATUS_PAGE = """
<!doctype html>
<html>
<head><meta charset="utf-8"><meta http-equiv="refresh" content="4"><title>Converting...</title></head>
<body style="font-family:sans-serif;max-width:600px;margin:30px auto;">
{% if status == "finished" %}
  <h3>কনভার্সন শেষ!</h3>
  <a href="/download/{{ output }}">ডাউনলোড করো</a> | <a href="/">হোমে ফিরে যাও</a>
{% elif status == "error" %}
  <h3>সমস্যা হয়েছে</h3>
  <p>{{ error }}</p>
  <a href="/">হোমে ফিরে যাও</a>
{% else %}
  <h3>কনভার্ট হচ্ছে... (পেজটা এমনিতেই রিফ্রেশ হবে)</h3>
{% endif %}
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
