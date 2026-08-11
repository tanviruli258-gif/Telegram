import os
import time
import uuid
import threading
import requests
from flask import Flask, request, redirect, render_template_string, send_from_directory, url_for

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

# টেলিগ্রাম বট API (Local Bot API সার্ভার সেটআপ না করলে) দিয়ে ২০ এমবি-র বেশি
# ফাইল ডাউনলোড করা যায় না — এটা কোডের বাগ না, টেলিগ্রামের নিজস্ব সীমা।
TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024


def safe_name(name):
    """পাথ-ট্র্যাভার্সাল ঠেকাতে এবং সেভ-সেফ রাখতে ফাইলনেইম ক্লিন করা (বাংলা নাম ঠিক রেখেই)"""
    name = os.path.basename((name or "").strip()) or f"file_{uuid.uuid4().hex[:8]}"
    name = name.replace("/", "_").replace("\\", "_")
    return name


def human_size(num_bytes):
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024*1024):.1f} MB"
    return f"{num_bytes / 1024:.0f} KB"


def list_with_sizes(folder):
    items = []
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            items.append({"name": name, "size": human_size(os.path.getsize(path))})
    return items


# ---------------------------------------------------------
# ------------------- CloudConvert অংশ ---------------------
# ---------------------------------------------------------
# CloudConvert এখন সরাসরি "convert" অপারেশনে output_format=3gp সাপোর্ট করে না
# (এই কারণেই আগে "INVALID_CONVERSION_TYPE" এরর আসছিল)। তাই "command" অপারেশন
# ব্যবহার করে সরাসরি ffmpeg কমান্ড চালানো হচ্ছে — H.263 ভিডিও + AAC অডিও,
# ছোট রেজোলিউশন — আসল 3GP ফাইল, বাটন ফোনের উপযোগী।


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
    out_name = safe_name(file_info.get("filename", out_filename))

    output_path = os.path.join(CONVERTED_FOLDER, out_name)
    dl = requests.get(file_url, timeout=600)
    dl.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(dl.content)

    return out_name


def background_convert(job_id, input_path, filename):
    try:
        JOBS[job_id]["status"] = "processing"
        out_filename = cloudconvert_convert_to_3gp(input_path, filename)
        JOBS[job_id]["status"] = "finished"
        JOBS[job_id]["output"] = out_filename

        # সোর্স যাই হোক (Telegram বা গ্যালারি আপলোড) — কনভার্ট শেষ হলে সবসময়
        # শেষ যে চ্যাটে বট ব্যবহার হয়েছে সেখানে ফাইলটা পাঠিয়ে দেওয়া হয়।
        if LAST_CHAT_ID["id"]:
            JOBS[job_id]["sent_to_bot"] = send_document_to_telegram(
                LAST_CHAT_ID["id"], os.path.join(CONVERTED_FOLDER, out_filename)
            )
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


TELEGRAM_MAX_UPLOAD = 50 * 1024 * 1024  # বট থেকে সরাসরি ফাইল পাঠানোর ক্ষেত্রে টেলিগ্রামের সীমা


def send_document_to_telegram(chat_id, filepath):
    try:
        if os.path.getsize(filepath) > TELEGRAM_MAX_UPLOAD:
            send_message(chat_id, "⚠️ কনভার্ট হওয়া ফাইলটি ৫০MB-র বেশি, তাই বটে পাঠানো যায়নি। ওয়েবসাইট থেকে সরাসরি ডাউনলোড করো।")
            return False
        with open(filepath, "rb") as f:
            r = requests.post(f"{TG_API}/sendDocument",
                               data={"chat_id": chat_id},
                               files={"document": f},
                               timeout=300)
        ok = r.json().get("ok", False)
        if not ok:
            send_message(chat_id, "⚠️ কনভার্ট হওয়া ফাইলটি বটে পাঠাতে সমস্যা হয়েছে। ওয়েবসাইট থেকে ডাউনলোড করে নাও।")
        return ok
    except Exception:
        return False


def download_telegram_file(file_id, save_as):
    r = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=30)
    data = r.json()
    if not data.get("ok"):
        desc = data.get("description", "")
        if "too big" in desc.lower():
            raise RuntimeError(
                "ফাইলটি ২০ এমবি-র বেশি — টেলিগ্রামের স্ট্যান্ডার্ড Bot API দিয়ে এর বড় ফাইল "
                "ডাউনলোড করা যায় না (এটা টেলিগ্রামের নিজস্ব সীমা, বটের কোডের সমস্যা না)। "
                "ভিডিওটা কমপ্রেস করে বা ছোট করে পাঠাও।"
            )
        raise RuntimeError(f"getFile ব্যর্থ: {desc or 'অজানা কারণ'}")
    file_path = data["result"]["file_path"]
    file_url = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
    dl = requests.get(file_url, timeout=300)
    dl.raise_for_status()
    save_path = os.path.join(TELEGRAM_FOLDER, save_as)
    with open(save_path, "wb") as f:
        f.write(dl.content)
    return save_path


def handle_incoming_video(chat_id, file_id, orig_name, file_size):
    if file_size and file_size > TELEGRAM_MAX_DOWNLOAD:
        mb = round(file_size / (1024 * 1024), 1)
        send_message(
            chat_id,
            f"⚠️ ভিডিওটি {mb}MB — টেলিগ্রামের স্ট্যান্ডার্ড বট API দিয়ে ২০MB-র বেশি ফাইল "
            f"ডাউনলোড করা যায় না (এটা টেলিগ্রামের নিজস্ব সীমাবদ্ধতা)। ভিডিওটা কমপ্রেস করে বা "
            f"ছোট রেজোলিউশনে পাঠালে সেভ হবে।"
        )
        return

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
            save_name = safe_name(entry["name"])
            download_telegram_file(entry["file_id"], save_name)
            text = f"✅ সেভ হয়েছে: {save_name}\nওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}"
        except Exception as e:
            text = f"⚠️ সেভ করতে সমস্যা হয়েছে:\n{e}"
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
                file_size = None
                if "video" in msg:
                    file_id = msg["video"]["file_id"]
                    file_size = msg["video"].get("file_size")
                    orig_name = msg["video"].get("file_name") or f"video_{uuid.uuid4().hex[:8]}.mp4"
                elif "document" in msg:
                    doc = msg["document"]
                    mime = doc.get("mime_type", "")
                    fname = doc.get("file_name", "")
                    if mime.startswith("video/") or fname.lower().endswith(VIDEO_EXTS):
                        file_id = doc["file_id"]
                        file_size = doc.get("file_size")
                        orig_name = fname or f"video_{uuid.uuid4().hex[:8]}.mp4"
                    else:
                        send_message(chat_id, "শুধুমাত্র ভিডিও ফাইল সাপোর্টেড। অন্য কোনো ফাইল গ্রহণযোগ্য নয়।")
                elif "text" in msg and msg["text"] == "/start":
                    send_message(chat_id, f"স্বাগতম! একটি ভিডিও ফরওয়ার্ড করো, তারপর সেভ করে ওয়েবসাইটে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}")

                if file_id:
                    handle_incoming_video(chat_id, file_id, orig_name, file_size)
        except Exception:
            time.sleep(5)


# ---------------------------------------------------------
# ---------------------- Web রুট -----------------------------
# ---------------------------------------------------------
PAGE = r"""
<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3GP Video Converter</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#07080c; --panel:#12141c; --panel2:#171a24; --border:#242838;
    --accent:#7c9bff; --accent2:#b56bff; --accent3:#4fd9c4;
    --text:#f4f6fb; --muted:#8b90a6; --ok:#33d99a; --err:#ff5f7e;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    color:var(--text); min-height:100vh; padding-bottom:50px;
    font-family:'Inter','Hind Siliguri',-apple-system,sans-serif;
    background:
      radial-gradient(900px 480px at 15% -10%, rgba(124,155,255,.20), transparent 55%),
      radial-gradient(800px 460px at 105% 5%, rgba(181,107,255,.16), transparent 55%),
      radial-gradient(700px 400px at 50% 110%, rgba(79,217,196,.10), transparent 55%),
      var(--bg);
    background-attachment:fixed;
  }
  .topbar{
    position:sticky; top:0; z-index:20; backdrop-filter:blur(14px);
    background:rgba(7,8,12,.72); border-bottom:1px solid var(--border);
    padding:14px 18px; display:flex; align-items:center; gap:10px;
  }
  .topbar .logo{
    width:34px;height:34px;border-radius:10px;flex:none;
    background:linear-gradient(135deg,var(--accent),var(--accent2));
    display:flex;align-items:center;justify-content:center;font-size:17px;
    box-shadow:0 4px 14px rgba(124,155,255,.35);
  }
  .topbar .title{font-weight:800; font-size:15px; letter-spacing:.2px}
  .topbar .sub{font-size:11px; color:var(--muted)}

  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 0}

  .hero{
    position:relative; overflow:hidden; border-radius:22px;
    padding:26px 22px 24px; margin-bottom:22px;
    background:linear-gradient(150deg,#1c2140,#241a3d 55%,#12141c);
    border:1px solid var(--border);
  }
  .hero::before{
    content:""; position:absolute; inset:0;
    background:radial-gradient(circle at 85% -20%, rgba(124,155,255,.35), transparent 55%);
  }
  .hero *{position:relative}
  .hero .pill{
    display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600;
    color:var(--accent3); background:rgba(79,217,196,.12); border:1px solid rgba(79,217,196,.3);
    padding:4px 10px; border-radius:999px; margin-bottom:12px;
  }
  .hero h1{margin:0 0 6px; font-size:23px; font-weight:800; letter-spacing:-.2px}
  .hero p{margin:0; font-size:13.5px; color:var(--muted); line-height:1.5}

  .dropzone{
    border:1.5px dashed #38405a; border-radius:18px; padding:26px 18px;
    text-align:center; background:var(--panel); margin-bottom:22px;
    transition:border-color .18s ease, background .18s ease;
    cursor:pointer;
  }
  .dropzone.drag{border-color:var(--accent); background:rgba(124,155,255,.06)}
  .dropzone .dz-icon{font-size:30px; margin-bottom:6px}
  .dropzone .dz-title{font-weight:700; font-size:14.5px; margin-bottom:3px}
  .dropzone .dz-sub{font-size:12px; color:var(--muted); margin-bottom:14px}
  .dropzone input[type=file]{display:none}
  .filename-tag{
    display:none; font-size:12px; background:var(--panel2); border:1px solid var(--border);
    border-radius:10px; padding:8px 12px; margin:0 0 12px; word-break:break-all; text-align:left;
  }
  .btn{
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; border:none;
    padding:11px 20px; border-radius:12px; font-size:13.5px; font-weight:700;
    text-decoration:none; white-space:nowrap; display:inline-flex; align-items:center;
    gap:6px; cursor:pointer; box-shadow:0 6px 18px rgba(124,155,255,.25);
  }
  .btn:disabled{opacity:.5; cursor:not-allowed}
  .btn.dl{background:linear-gradient(135deg,var(--ok),#1fb583); box-shadow:0 6px 18px rgba(51,217,154,.25)}
  .btn.block{width:100%; justify-content:center}
  .btn.ghost{background:transparent; border:1px solid var(--border); box-shadow:none; color:var(--muted)}

  .tabs{display:flex; gap:6px; background:var(--panel); border:1px solid var(--border);
    padding:5px; border-radius:14px; margin-bottom:14px;}
  .tab{
    flex:1; text-align:center; padding:9px 4px; border-radius:10px; font-size:12.5px;
    font-weight:700; color:var(--muted); cursor:pointer; user-select:none;
    display:flex; align-items:center; justify-content:center; gap:5px;
  }
  .tab.active{background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff}
  .tab .count{
    font-size:10px; background:rgba(255,255,255,.15); border-radius:999px;
    padding:1px 6px; min-width:16px;
  }
  .tab.active .count{background:rgba(255,255,255,.28)}

  .panel{display:none}
  .panel.active{display:block; animation:fade .2s ease}
  @keyframes fade{from{opacity:0; transform:translateY(4px)} to{opacity:1; transform:none}}

  .card{
    background:var(--panel); border:1px solid var(--border);
    border-radius:16px; padding:13px 14px; margin-bottom:9px;
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    transition:border-color .15s ease, transform .15s ease;
  }
  .card:hover{border-color:var(--accent); transform:translateY(-1px)}
  .fname{font-size:13px; word-break:break-all; line-height:1.35; display:flex; align-items:center; gap:10px; min-width:0}
  .fname .ico{
    width:34px;height:34px;border-radius:10px;flex:none;
    background:var(--panel2); display:flex; align-items:center; justify-content:center; font-size:15px;
  }
  .fname > span{display:flex; flex-direction:column; gap:2px; min-width:0}
  .fn-name{font-weight:600}
  .fn-size{font-size:11px; color:var(--muted); font-weight:500}

  .info-bar{
    display:flex; gap:8px; margin-bottom:20px; overflow-x:auto; padding-bottom:2px;
  }
  .info-chip{
    flex:none; background:var(--panel); border:1px solid var(--border); border-radius:12px;
    padding:9px 13px; font-size:11.5px; color:var(--muted); display:flex; align-items:center; gap:6px;
    white-space:nowrap;
  }
  .info-chip b{color:var(--text); font-weight:700}
  .empty{color:var(--muted); font-size:12.5px; padding:26px 10px; text-align:center;
    border:1px dashed var(--border); border-radius:16px; background:var(--panel)}
  .empty .e-ico{font-size:26px; display:block; margin-bottom:6px; opacity:.6}

  .status-box{
    text-align:center; padding:48px 20px; background:var(--panel);
    border:1px solid var(--border); border-radius:20px; margin-top:6px;
  }
  .spinner{
    width:40px;height:40px;margin:0 auto 18px;border-radius:50%;
    border:3px solid var(--border); border-top-color:var(--accent);
    animation:spin .85s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-box h3{margin:0 0 6px;font-size:18px}
  .status-box p{color:var(--muted);font-size:13px;margin:0 0 20px}
  .status-box.err h3{color:var(--err)}
  .status-box.err p{color:var(--text); background:#241019; padding:12px 14px;
    border-radius:12px; text-align:left; word-break:break-word; font-size:12.5px; white-space:pre-wrap}
  .status-box.ok h3{color:var(--ok)}
  .back{display:block;text-align:center;margin-top:18px;color:var(--muted);font-size:13px;text-decoration:none}

  .footer{
    text-align:center; margin-top:36px; padding:22px 0 6px;
    border-top:1px solid var(--border); color:var(--muted); font-size:12px;
  }
  .footer .badge{
    display:inline-flex; align-items:center; gap:6px; margin-top:10px; padding:7px 16px; border-radius:999px;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff;
    font-weight:800; font-size:12px; letter-spacing:.3px;
    box-shadow:0 6px 16px rgba(124,155,255,.3);
  }
</style>
</head>
<body>

<div class="topbar">
  <div class="logo">🎬</div>
  <div>
    <div class="title">3GP Video Converter</div>
    <div class="sub">smart · fast · feature-phone ready</div>
  </div>
</div>

<div class="wrap">
  <div class="hero">
    <div class="pill">⚡ ffmpeg powered</div>
    <h1>MP4 → 3GP কনভার্টার</h1>
    <p>বাটন ফোনে চালানোর জন্য যেকোনো ভিডিওকে ছোট, কম্প্যাটিবল 3GP ফাইলে রূপান্তর করো — গ্যালারি থেকে আপলোড করো, অথবা টেলিগ্রাম বট থেকে সরাসরি সেভ করা ভিডিও কনভার্ট করো।</p>
  </div>

  <div class="info-bar">
    <div class="info-chip">📁 আপলোড সর্বোচ্চ <b>1 GB</b></div>
    <div class="info-chip">📥 Telegram থেকে সর্বোচ্চ <b>20 MB</b></div>
    <div class="info-chip">🤖 বটে ফেরত পাঠানো সর্বোচ্চ <b>50 MB</b></div>
  </div>

  <form id="uploadForm" class="dropzone" method="POST" action="/upload" enctype="multipart/form-data">
    <div class="dz-icon">📤</div>
    <div class="dz-title">ভিডিও ড্র্যাগ করো অথবা ট্যাপ করে বেছে নাও</div>
    <div class="dz-sub">গ্যালারি থেকে যেকোনো ভিডিও ফাইল সিলেক্ট করা যাবে</div>
    <div class="filename-tag" id="fileTag"></div>
    <label class="btn block" for="fileInput" id="pickBtn">📁 ফাইল বেছে নাও</label>
    <input type="file" name="file" id="fileInput" accept="video/*" required>
    <button class="btn block dl" type="submit" id="submitBtn" style="display:none;margin-top:10px">⬆️ আপলোড করো</button>
  </form>

  <div class="tabs">
    <div class="tab active" data-tab="tg">📥 Telegram <span class="count">{{ telegram_files|length }}</span></div>
    <div class="tab" data-tab="up">🗂️ আপলোড <span class="count">{{ uploaded_files|length }}</span></div>
    <div class="tab" data-tab="done">✅ কনভার্টেড <span class="count">{{ converted_files|length }}</span></div>
  </div>

  <div class="panel active" id="panel-tg">
    {% for f in telegram_files %}
      <div class="card">
        <span class="fname"><span class="ico">🎬</span><span><span class="fn-name">{{ f.name }}</span><span class="fn-size">{{ f.size }}</span></span></span>
        <a class="btn" href="{{ url_for('convert', source='telegram', filename=f.name) }}">কনভার্ট</a>
      </div>
    {% else %}
      <div class="empty"><span class="e-ico">📭</span>এখনো কোনো ভিডিও নেই — বটে ভিডিও ফরওয়ার্ড করে "সেভ করুন" চাপো</div>
    {% endfor %}
  </div>

  <div class="panel" id="panel-up">
    {% for f in uploaded_files %}
      <div class="card">
        <span class="fname"><span class="ico">🎞️</span><span><span class="fn-name">{{ f.name }}</span><span class="fn-size">{{ f.size }}</span></span></span>
        <a class="btn" href="{{ url_for('convert', source='upload', filename=f.name) }}">কনভার্ট</a>
      </div>
    {% else %}
      <div class="empty"><span class="e-ico">🗂️</span>কোনো ভিডিও নেই</div>
    {% endfor %}
  </div>

  <div class="panel" id="panel-done">
    {% for f in converted_files %}
      <div class="card">
        <span class="fname"><span class="ico">✅</span><span><span class="fn-name">{{ f.name }}</span><span class="fn-size">{{ f.size }}</span></span></span>
        <a class="btn dl" href="{{ url_for('download', filename=f.name) }}">ডাউনলোড</a>
      </div>
    {% else %}
      <div class="empty"><span class="e-ico">📦</span>কোনো ফাইল নেই</div>
    {% endfor %}
  </div>

  <div class="footer">
    Smart video tools for feature phones
    <div class="badge">✨ Developed by TANVIR SIYAM</div>
  </div>
</div>

<script>
  // ট্যাব সুইচিং
  document.querySelectorAll('.tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('panel-'+tab.dataset.tab).classList.add('active');
    });
  });

  // ফাইল সিলেক্ট + ড্র্যাগড্রপ
  const dz = document.getElementById('uploadForm');
  const input = document.getElementById('fileInput');
  const tag = document.getElementById('fileTag');
  const pickBtn = document.getElementById('pickBtn');
  const submitBtn = document.getElementById('submitBtn');

  function showFile(file){
    if(!file) return;
    tag.textContent = '🎬 ' + file.name + '  (' + (file.size/1024/1024).toFixed(1) + ' MB)';
    tag.style.display = 'block';
    pickBtn.textContent = '🔁 অন্য ফাইল বেছে নাও';
    submitBtn.style.display = 'flex';
  }
  input.addEventListener('change', ()=> showFile(input.files[0]));

  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev, e=>{
    e.preventDefault(); dz.classList.add('drag');
  }));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev, e=>{
    e.preventDefault(); dz.classList.remove('drag');
  }));
  dz.addEventListener('drop', e=>{
    const file = e.dataTransfer.files[0];
    if(file){ input.files = e.dataTransfer.files; showFile(file); }
  });
  dz.addEventListener('submit', ()=>{
    submitBtn.disabled = true;
    submitBtn.innerHTML = '⏳ আপলোড হচ্ছে...';
  });
</script>
</body>
</html>
"""

STATUS_PAGE = r"""
<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
{% if status not in ("finished", "error") %}<meta http-equiv="refresh" content="3">{% endif %}
<title>কনভার্ট হচ্ছে...</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#07080c; --panel:#12141c; --border:#242838;
    --accent:#7c9bff; --accent2:#b56bff; --text:#f4f6fb; --muted:#8b90a6;
    --ok:#33d99a; --err:#ff5f7e;
  }
  *{box-sizing:border-box}
  body{
    margin:0; padding:26px 16px 40px; color:var(--text); min-height:100vh;
    font-family:'Inter','Hind Siliguri',-apple-system,sans-serif;
    background:
      radial-gradient(900px 480px at 15% -10%, rgba(124,155,255,.20), transparent 55%),
      radial-gradient(800px 460px at 105% 5%, rgba(181,107,255,.16), transparent 55%),
      var(--bg);
  }
  .wrap{max-width:460px;margin:0 auto}
  .status-box{
    text-align:center; padding:48px 20px; background:var(--panel);
    border:1px solid var(--border); border-radius:22px; margin-top:20px;
  }
  .spinner{
    width:42px;height:42px;margin:0 auto 18px;border-radius:50%;
    border:3px solid var(--border); border-top-color:var(--accent);
    animation:spin .85s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
  .status-box h3{margin:0 0 6px;font-size:18px}
  .status-box p{color:var(--muted);font-size:13px;margin:0 0 20px}
  .status-box.err h3{color:var(--err)}
  .status-box.err p{color:var(--text); background:#241019; padding:12px 14px;
    border-radius:12px; text-align:left; word-break:break-word; font-size:12.5px; white-space:pre-wrap}
  .status-box.ok h3{color:var(--ok)}
  .btn{
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; border:none;
    padding:11px 20px; border-radius:12px; font-size:13.5px; font-weight:700;
    text-decoration:none; display:inline-block;
  }
  .back{display:block;text-align:center;margin-top:18px;color:var(--muted);font-size:13px;text-decoration:none}
  .footer{text-align:center;margin-top:30px;color:var(--muted);font-size:12px}
  .badge{
    display:inline-flex; align-items:center; gap:6px; margin-top:10px; padding:7px 16px; border-radius:999px;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff;
    font-weight:800; font-size:12px;
  }
</style>
</head>
<body>
<div class="wrap">
  {% if status == "finished" %}
    <div class="status-box ok">
      <div style="font-size:42px;margin-bottom:10px">✅</div>
      <h3>কনভার্সন শেষ!</h3>
      <p>তোমার 3GP ফাইল তৈরি হয়ে গেছে{% if sent_to_bot %} এবং টেলিগ্রাম বটেও পাঠানো হয়েছে ✓{% endif %}</p>
      <a class="btn" href="{{ url_for('download', filename=output) }}">⬇️ ডাউনলোড করো</a>
    </div>
  {% elif status == "error" %}
    <div class="status-box err">
      <div style="font-size:42px;margin-bottom:10px">⚠️</div>
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
  <a class="back" href="{{ url_for('home') }}">← হোমে ফিরে যাও</a>
  <div class="footer"><div class="badge">✨ Developed by TANVIR SIYAM</div></div>
</div>
</body>
</html>
"""


@app.route("/")
def home():
    return render_template_string(
        PAGE,
        telegram_files=list_with_sizes(TELEGRAM_FOLDER),
        uploaded_files=list_with_sizes(UPLOAD_FOLDER),
        converted_files=list_with_sizes(CONVERTED_FOLDER),
    )


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files["file"]
    fname = safe_name(f.filename)
    save_path = os.path.join(UPLOAD_FOLDER, fname)
    f.save(save_path)
    return redirect(url_for("home"))


@app.route("/convert/<source>/<path:filename>")
def convert(source, filename):
    folder = TELEGRAM_FOLDER if source == "telegram" else UPLOAD_FOLDER
    input_path = os.path.join(folder, filename)
    if not os.path.exists(input_path):
        return "ফাইল খুঁজে পাওয়া যায়নি", 404

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "queued", "output": None, "error": None, "sent_to_bot": False}

    thread = threading.Thread(target=background_convert, args=(job_id, input_path, filename))
    thread.start()

    return redirect(url_for("status", job_id=job_id))


@app.route("/status/<job_id>")
def status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return "জব খুঁজে পাওয়া যায়নি", 404
    return render_template_string(
        STATUS_PAGE, status=job["status"], output=job["output"], error=job["error"],
        sent_to_bot=job.get("sent_to_bot", False),
    )


@app.route("/download/<path:filename>")
def download(filename):
    return send_from_directory(CONVERTED_FOLDER, filename, as_attachment=True)


if __name__ == "__main__":
    bot_thread = threading.Thread(target=telegram_polling_loop, daemon=True)
    bot_thread.start()

    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
