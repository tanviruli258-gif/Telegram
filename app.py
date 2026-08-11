import os
import time
import uuid
import json
import hmac
import hashlib
import threading
import urllib.parse
import requests
from flask import (
    Flask, request, redirect, render_template_string, send_from_directory,
    url_for, jsonify, session, Response, send_file
)

# =========================================================
# এই ৩টা ভ্যারিয়েবল Railway ড্যাশবোর্ড -> Variables ট্যাবে বসাও
# =========================================================
CLOUDCONVERT_API_KEY = os.environ.get("CLOUDCONVERT_API_KEY", "PASTE_YOUR_CLOUDCONVERT_API_KEY_HERE")
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE")
WEBSITE_URL = os.environ.get("WEBSITE_URL", "PASTE_YOUR_RAILWAY_PUBLIC_URL_HERE")
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", uuid.uuid4().hex)
# =========================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
TELEGRAM_ROOT = os.path.join(DATA_DIR, "telegram")   # data/telegram/<uid>/*.mp4
UPLOAD_ROOT = os.path.join(DATA_DIR, "uploads")       # data/uploads/<uid>/*.mp4
CONVERTED_ROOT = os.path.join(DATA_DIR, "converted")  # data/converted/<uid>/*.3gp|mp3
for folder in (TELEGRAM_ROOT, UPLOAD_ROOT, CONVERTED_ROOT):
    os.makedirs(folder, exist_ok=True)

app = Flask(__name__)
app.secret_key = FLASK_SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB আপলোড লিমিট

VIDEO_EXTS = (".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".wmv", ".m4v", ".3gp", ".3g2", ".ts", ".mpg", ".mpeg")
ALLOWED_FORMATS = ("3gp", "mp3")

TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024   # টেলিগ্রাম Bot API-এর ফাইল-ডাউনলোড সীমা
TELEGRAM_MAX_UPLOAD = 50 * 1024 * 1024     # টেলিগ্রাম Bot API-এর ফাইল-আপলোড (বটে ফেরত পাঠানো) সীমা

# ---------------------------------------------------------
# --------------------- ইন-মেমোরি স্টোর ----------------------
# ---------------------------------------------------------
JOBS = {}              # job_id -> {status, error, result}
PENDING = {}            # pending_id -> {file_id, name, chat_id, message_id, size}
HISTORY = {}            # uid -> [ {id, filename, format, source_name, size, created, sent_to_bot}, ... ]
DOWNLOAD_INDEX = {}      # download_id -> absolute file path
PROFILE_CACHE = {}       # telegram user id (int) -> {photo_bytes, fetched_at}

HISTORY_LOCK = threading.Lock()


# ---------------------------------------------------------
# ------------------------ হেল্পার --------------------------
# ---------------------------------------------------------
def safe_name(name):
    """পাথ-ট্র্যাভার্সাল ঠেকাতে ও সেভ-সেফ রাখতে ফাইলনেইম ক্লিন করা (বাংলা নাম অক্ষত রেখে)"""
    name = os.path.basename((name or "").strip()) or f"file_{uuid.uuid4().hex[:8]}"
    name = name.replace("/", "_").replace("\\", "_")
    return name


def human_size(num_bytes):
    if num_bytes >= 1024 * 1024:
        return f"{num_bytes / (1024*1024):.1f} MB"
    return f"{max(num_bytes, 0) / 1024:.0f} KB"


def uid_folder(root, uid):
    path = os.path.join(root, uid)
    os.makedirs(path, exist_ok=True)
    return path


def list_with_sizes(folder):
    items = []
    if not os.path.isdir(folder):
        return items
    for name in sorted(os.listdir(folder)):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            items.append({"name": name, "size": human_size(os.path.getsize(path))})
    return items


def relative_time(ts):
    diff = int(time.time() - ts)
    if diff < 60:
        return "এইমাত্র"
    if diff < 3600:
        return f"{diff // 60} মিনিট আগে"
    if diff < 86400:
        return f"{diff // 3600} ঘণ্টা আগে"
    return f"{diff // 86400} দিন আগে"


def add_history(uid, entry):
    with HISTORY_LOCK:
        HISTORY.setdefault(uid, []).insert(0, entry)
        DOWNLOAD_INDEX[entry["id"]] = entry["_path"]


def remove_history(uid, entry_id):
    with HISTORY_LOCK:
        entries = HISTORY.get(uid, [])
        target = next((e for e in entries if e["id"] == entry_id), None)
        if not target:
            return False
        entries.remove(target)
        DOWNLOAD_INDEX.pop(entry_id, None)
        try:
            if os.path.exists(target["_path"]):
                os.remove(target["_path"])
        except OSError:
            pass
        return True


# ---------------------------------------------------------
# ---------- Telegram Mini App initData ভেরিফিকেশন -----------
# ---------------------------------------------------------
# ডকুমেন্টেশন: https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
def verify_telegram_init_data(init_data):
    if not init_data or "PASTE_YOUR" in TELEGRAM_BOT_TOKEN:
        return None
    try:
        parsed = dict(urllib.parse.parse_qsl(init_data, strict_parsing=True))
        received_hash = parsed.pop("hash", None)
        if not received_hash:
            return None
        check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", TELEGRAM_BOT_TOKEN.encode(), hashlib.sha256).digest()
        computed_hash = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed_hash, received_hash):
            return None
        user_json = parsed.get("user")
        if not user_json:
            return None
        return json.loads(user_json)
    except Exception:
        return None


def current_uid():
    """হেডার থেকে Telegram initData যাচাই করে uid রিটার্ন করে; না থাকলে ব্রাউজার সেশন uid ব্যবহার হয়"""
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    user = verify_telegram_init_data(init_data)
    if user and user.get("id"):
        session["tg_user"] = user
        return f"tg_{user['id']}"
    if "web_uid" not in session:
        session["web_uid"] = f"web_{uuid.uuid4().hex[:14]}"
    return session["web_uid"]


def telegram_chat_id_for(uid):
    if uid.startswith("tg_"):
        try:
            return int(uid.split("_", 1)[1])
        except ValueError:
            return None
    return None


# ---------------------------------------------------------
# ------------------- CloudConvert অংশ ---------------------
# ---------------------------------------------------------
# CloudConvert-এর সাধারণ "convert" অপারেশন output_format=3gp সাপোর্ট করে না
# (INVALID_CONVERSION_TYPE এরর দেয়)। তাই "command" অপারেশনে সরাসরি ffmpeg
# চালানো হয় — এটা format-matrix-এর সীমার বাইরে, তাই 3GP ও MP3 দুটোই নিশ্চিতভাবে কাজ করে।
def build_ffmpeg_args(filename, fmt, out_filename):
    src = f"/input/upload-file/{filename}"
    if fmt == "3gp":
        return (
            f"-i {src} -vf scale=176:144 -vcodec h263 -b:v 128k -r 15 "
            f"-acodec aac -ar 8000 -ac 1 -b:a 32k -y /output/{out_filename}"
        )
    if fmt == "mp3":
        return f"-i {src} -vn -acodec libmp3lame -ar 44100 -b:a 128k -y /output/{out_filename}"
    raise ValueError("অসমর্থিত ফরম্যাট")


def cloudconvert_convert(input_path, filename, fmt):
    if fmt not in ALLOWED_FORMATS:
        raise ValueError("অসমর্থিত ফরম্যাট")
    if not CLOUDCONVERT_API_KEY or "PASTE_YOUR" in CLOUDCONVERT_API_KEY:
        raise RuntimeError("CLOUDCONVERT_API_KEY সেট করা হয়নি (Railway Variables-এ যোগ করো)")

    headers = {"Authorization": f"Bearer {CLOUDCONVERT_API_KEY}"}
    safe_stem = os.path.splitext(filename)[0] or "file"
    out_filename = f"{safe_stem}_{uuid.uuid4().hex[:6]}.{fmt}"
    ffmpeg_args = build_ffmpeg_args(filename, fmt, out_filename)

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
            "export-file": {"operation": "export/url", "input": "convert-file"},
        }
    }

    r = requests.post("https://api.cloudconvert.com/v2/jobs", json=job_payload, headers=headers, timeout=60)
    r.raise_for_status()
    job = r.json()["data"]

    upload_task = next(t for t in job["tasks"] if t["name"] == "upload-file")
    upload_url = upload_task["result"]["form"]["url"]
    upload_params = upload_task["result"]["form"]["parameters"]

    with open(input_path, "rb") as f:
        up = requests.post(upload_url, data=upload_params, files={"file": (filename, f)}, timeout=600)
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
        failed = [t for t in job["tasks"] if t["status"] == "error"]
        if failed:
            t = failed[0]
            reason = t.get("message") or "অজানা কারণ"
            code = t.get("code")
            raise RuntimeError(f"({t['name']}{' / ' + code if code else ''}) {reason}")
        raise RuntimeError("CloudConvert job ব্যর্থ হয়েছে, কারণ পাওয়া যায়নি")

    export_task = next(t for t in job["tasks"] if t["name"] == "export-file")
    result_files = export_task["result"]["files"]
    if not result_files:
        raise RuntimeError("কনভার্সন হয়েছে কিন্তু আউটপুট ফাইল পাওয়া যায়নি")
    file_info = result_files[0]
    out_name = safe_name(file_info.get("filename", out_filename))

    dl = requests.get(file_info["url"], timeout=600)
    dl.raise_for_status()
    return out_name, dl.content


def background_convert(job_id, uid, input_path, filename, fmt, source_label):
    try:
        JOBS[job_id]["status"] = "processing"
        out_name, content = cloudconvert_convert(input_path, filename, fmt)

        out_dir = uid_folder(CONVERTED_ROOT, uid)
        out_path = os.path.join(out_dir, out_name)
        with open(out_path, "wb") as f:
            f.write(content)

        entry_id = uuid.uuid4().hex
        entry = {
            "id": entry_id,
            "filename": out_name,
            "format": fmt,
            "source_name": filename,
            "source": source_label,
            "size": human_size(len(content)),
            "size_bytes": len(content),
            "created": time.time(),
            "sent_to_bot": False,
            "_path": out_path,
        }

        sent = False
        chat_id = telegram_chat_id_for(uid)
        if chat_id:
            sent = send_document_to_telegram(chat_id, out_path)
        entry["sent_to_bot"] = sent

        add_history(uid, entry)

        JOBS[job_id]["status"] = "finished"
        JOBS[job_id]["result"] = {
            "id": entry_id,
            "filename": out_name,
            "format": fmt,
            "size": entry["size"],
            "sent_to_bot": sent,
            "download_url": f"/dl/{entry_id}",
        }
    except Exception as e:
        JOBS[job_id]["status"] = "error"
        JOBS[job_id]["error"] = str(e)


# ---------------------------------------------------------
# -------------------- Telegram বট অংশ ------------------------
# ---------------------------------------------------------
TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


def set_menu_button():
    try:
        requests.post(f"{TG_API}/setChatMenuButton", json={
            "menu_button": {"type": "web_app", "text": "Open App", "web_app": {"url": WEBSITE_URL}}
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
        if os.path.getsize(filepath) > TELEGRAM_MAX_UPLOAD:
            send_message(chat_id, "⚠️ কনভার্ট হওয়া ফাইলটি ৫০MB-র বেশি, তাই বটে পাঠানো যায়নি। অ্যাপ থেকে সরাসরি ডাউনলোড করো।")
            return False
        with open(filepath, "rb") as f:
            r = requests.post(f"{TG_API}/sendDocument", data={"chat_id": chat_id},
                               files={"document": f}, timeout=300)
        ok = r.json().get("ok", False)
        if not ok:
            send_message(chat_id, "⚠️ কনভার্ট হওয়া ফাইলটি বটে পাঠাতে সমস্যা হয়েছে। অ্যাপ থেকে ডাউনলোড করে নাও।")
        return ok
    except Exception:
        return False


def download_telegram_file(file_id, save_path):
    r = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=30)
    data = r.json()
    if not data.get("ok"):
        desc = data.get("description", "")
        if "too big" in desc.lower():
            raise RuntimeError(
                "ফাইলটি ২০MB-র বেশি — টেলিগ্রামের স্ট্যান্ডার্ড Bot API দিয়ে এত বড় ফাইল "
                "ডাউনলোড করা যায় না (এটা টেলিগ্রামের নিজস্ব সীমা)। ভিডিওটা কমপ্রেস করে পাঠাও।"
            )
        raise RuntimeError(f"getFile ব্যর্থ: {desc or 'অজানা কারণ'}")
    file_path = data["result"]["file_path"]
    file_url = f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}"
    dl = requests.get(file_url, timeout=300)
    dl.raise_for_status()
    with open(save_path, "wb") as f:
        f.write(dl.content)


def handle_incoming_video(chat_id, file_id, orig_name, file_size):
    if file_size and file_size > TELEGRAM_MAX_DOWNLOAD:
        mb = round(file_size / (1024 * 1024), 1)
        send_message(chat_id, f"⚠️ ভিডিওটি {mb}MB — টেলিগ্রামের স্ট্যান্ডার্ড বট API দিয়ে ২০MB-র বেশি ফাইল "
                               f"ডাউনলোড করা যায় না। ভিডিওটা কমপ্রেস করে বা ছোট রেজোলিউশনে পাঠাও।")
        return

    pending_id = uuid.uuid4().hex[:10]
    PENDING[pending_id] = {"file_id": file_id, "name": orig_name, "chat_id": chat_id, "size": file_size}
    keyboard = {"inline_keyboard": [[
        {"text": "✅ সেভ করুন", "callback_data": f"save:{pending_id}"},
        {"text": "🗑 ডিলিট করুন", "callback_data": f"del:{pending_id}"},
    ]]}
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
            uid = f"tg_{entry['chat_id']}"
            save_name = safe_name(entry["name"])
            save_path = os.path.join(uid_folder(TELEGRAM_ROOT, uid), save_name)
            download_telegram_file(entry["file_id"], save_path)
            text = f"✅ সেভ হয়েছে: {save_name}\nঅ্যাপ থেকে গিয়ে কনভার্ট করো:\n{WEBSITE_URL}"
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
                    handle_callback(callback)
                    continue

                msg = update.get("message")
                if not msg:
                    continue
                chat_id = msg["chat"]["id"]

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
                        send_message(chat_id, "শুধুমাত্র ভিডিও ফাইল সাপোর্টেড।")
                elif "text" in msg and msg["text"] == "/start":
                    send_message(chat_id, f"স্বাগতম! ভিডিও ফরওয়ার্ড করো, সেভ করো, তারপর অ্যাপ খুলে কনভার্ট করো:\n{WEBSITE_URL}")

                if file_id:
                    handle_incoming_video(chat_id, file_id, orig_name, file_size)
        except Exception:
            time.sleep(5)


# ---------------------------------------------------------
# ------------------------- API রুট --------------------------
# ---------------------------------------------------------
@app.route("/api/profile")
def api_profile():
    uid = current_uid()
    tg_user = session.get("tg_user")
    if not tg_user:
        return jsonify({"is_telegram": False})

    conv_count = len(HISTORY.get(uid, []))
    return jsonify({
        "is_telegram": True,
        "id": tg_user.get("id"),
        "first_name": tg_user.get("first_name", ""),
        "last_name": tg_user.get("last_name", ""),
        "username": tg_user.get("username", ""),
        "photo_url": f"/api/profile-photo/{tg_user.get('id')}",
        "conversions": conv_count,
    })


@app.route("/api/profile-photo/<int:user_id>")
def api_profile_photo(user_id):
    cached = PROFILE_CACHE.get(user_id)
    if cached and time.time() - cached["fetched_at"] < 3600:
        return Response(cached["photo_bytes"], mimetype="image/jpeg")
    try:
        r = requests.get(f"{TG_API}/getUserProfilePhotos", params={"user_id": user_id, "limit": 1}, timeout=15)
        photos = r.json().get("result", {}).get("photos", [])
        if not photos:
            return "", 404
        file_id = photos[0][-1]["file_id"]
        fr = requests.get(f"{TG_API}/getFile", params={"file_id": file_id}, timeout=15)
        file_path = fr.json()["result"]["file_path"]
        img = requests.get(f"https://api.telegram.org/file/bot{TELEGRAM_BOT_TOKEN}/{file_path}", timeout=30)
        PROFILE_CACHE[user_id] = {"photo_bytes": img.content, "fetched_at": time.time()}
        return Response(img.content, mimetype="image/jpeg")
    except Exception:
        return "", 404


@app.route("/api/my-videos")
def api_my_videos():
    uid = current_uid()
    telegram_files = list_with_sizes(uid_folder(TELEGRAM_ROOT, uid))
    uploaded_files = list_with_sizes(uid_folder(UPLOAD_ROOT, uid))
    for f in telegram_files:
        f["source"] = "telegram"
    for f in uploaded_files:
        f["source"] = "upload"
    return jsonify({"videos": telegram_files + uploaded_files})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    uid = current_uid()
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "কোনো ফাইল পাওয়া যায়নি"}), 400
    fname = safe_name(f.filename)
    save_path = os.path.join(uid_folder(UPLOAD_ROOT, uid), fname)
    f.save(save_path)
    return jsonify({"filename": fname, "size": human_size(os.path.getsize(save_path))})


@app.route("/api/convert", methods=["POST"])
def api_convert():
    uid = current_uid()
    data = request.get_json(force=True, silent=True) or {}
    source = data.get("source")
    filename = safe_name(data.get("filename", ""))
    fmt = data.get("format")

    if fmt not in ALLOWED_FORMATS:
        return jsonify({"error": "ফরম্যাট শুধু 3GP অথবা MP3 হতে পারে"}), 400
    if source == "telegram":
        input_path = os.path.join(uid_folder(TELEGRAM_ROOT, uid), filename)
        source_label = "Telegram"
    elif source == "upload":
        input_path = os.path.join(uid_folder(UPLOAD_ROOT, uid), filename)
        source_label = "Upload"
    else:
        return jsonify({"error": "অবৈধ সোর্স"}), 400

    if not os.path.exists(input_path):
        return jsonify({"error": "ফাইল খুঁজে পাওয়া যায়নি"}), 404

    job_id = uuid.uuid4().hex
    JOBS[job_id] = {"status": "queued", "error": None, "result": None}
    thread = threading.Thread(target=background_convert, args=(job_id, uid, input_path, filename, fmt, source_label))
    thread.start()
    return jsonify({"job_id": job_id})


@app.route("/api/status/<job_id>")
def api_status(job_id):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "জব খুঁজে পাওয়া যায়নি"}), 404
    return jsonify(job)


@app.route("/api/history")
def api_history():
    uid = current_uid()
    entries = HISTORY.get(uid, [])
    out = [{
        "id": e["id"], "filename": e["filename"], "format": e["format"],
        "source": e["source"], "size": e["size"], "sent_to_bot": e["sent_to_bot"],
        "when": relative_time(e["created"]), "download_url": f"/dl/{e['id']}",
    } for e in entries]
    return jsonify({"history": out})


@app.route("/api/history/<entry_id>", methods=["DELETE"])
def api_history_delete(entry_id):
    uid = current_uid()
    ok = remove_history(uid, entry_id)
    return jsonify({"deleted": ok})


@app.route("/dl/<download_id>")
def download_file(download_id):
    path = DOWNLOAD_INDEX.get(download_id)
    if not path or not os.path.exists(path):
        return "ফাইল খুঁজে পাওয়া যায়নি বা ডিলিট হয়ে গেছে", 404
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


# ---------------------------------------------------------
# ---------------------- মূল পেজ (SPA) ------------------------
# ---------------------------------------------------------
PAGE = r"""
<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>3GP/MP3 Converter</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#07080c; --panel:#12141c; --panel2:#171a24; --border:#242838;
    --accent:#7c9bff; --accent2:#b56bff; --accent3:#4fd9c4;
    --text:#f4f6fb; --muted:#8b90a6; --ok:#33d99a; --err:#ff5f7e;
    --navh:64px;
  }
  *{box-sizing:border-box; -webkit-tap-highlight-color:transparent}
  html,body{margin:0;padding:0}
  body{
    color:var(--text); min-height:100vh;
    font-family:'Inter','Hind Siliguri',-apple-system,sans-serif;
    background:
      radial-gradient(900px 480px at 15% -10%, rgba(124,155,255,.20), transparent 55%),
      radial-gradient(800px 460px at 105% 5%, rgba(181,107,255,.16), transparent 55%),
      radial-gradient(700px 400px at 50% 110%, rgba(79,217,196,.10), transparent 55%),
      var(--bg);
    background-attachment:fixed;
    padding-bottom:calc(var(--navh) + 18px);
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

  .wrap{max-width:520px;margin:0 auto;padding:18px 16px 0}
  .view{display:none; animation:fade .2s ease}
  .view.active{display:block}
  @keyframes fade{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none}}

  .hero{
    position:relative; overflow:hidden; border-radius:22px;
    padding:24px 22px 22px; margin-bottom:18px;
    background:linear-gradient(150deg,#1c2140,#241a3d 55%,#12141c);
    border:1px solid var(--border);
  }
  .hero::before{content:""; position:absolute; inset:0;
    background:radial-gradient(circle at 85% -20%, rgba(124,155,255,.35), transparent 55%);}
  .hero *{position:relative}
  .hero .pill{display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600;
    color:var(--accent3); background:rgba(79,217,196,.12); border:1px solid rgba(79,217,196,.3);
    padding:4px 10px; border-radius:999px; margin-bottom:12px;}
  .hero h1{margin:0 0 6px; font-size:21px; font-weight:800; letter-spacing:-.2px}
  .hero p{margin:0; font-size:13px; color:var(--muted); line-height:1.5}

  .stat-row{display:flex; gap:10px; margin-bottom:18px}
  .stat-card{flex:1; background:var(--panel); border:1px solid var(--border); border-radius:16px;
    padding:14px; text-align:center;}
  .stat-card .n{font-size:20px; font-weight:800; color:var(--accent)}
  .stat-card .l{font-size:11px; color:var(--muted); margin-top:2px}

  h2.section{font-size:12.5px;text-transform:uppercase;letter-spacing:.08em;
    color:var(--muted);margin:22px 4px 10px;font-weight:700; display:flex; align-items:center; justify-content:space-between}

  /* -------- Tools flow -------- */
  .steps{display:flex; flex-direction:column; gap:16px}
  .step{background:var(--panel); border:1px solid var(--border); border-radius:18px; padding:16px}
  .step-head{display:flex; align-items:center; gap:10px; margin-bottom:12px}
  .step-num{width:24px;height:24px;border-radius:50%;background:var(--panel2);border:1px solid var(--border);
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:var(--accent);flex:none}
  .step-title{font-weight:700; font-size:14px}

  .source-row{display:flex; gap:10px; margin-bottom:12px}
  .source-btn{flex:1; background:var(--panel2); border:1px solid var(--border); border-radius:14px;
    padding:14px 8px; text-align:center; font-size:12.5px; font-weight:700; cursor:pointer; color:var(--text)}
  .source-btn.active{background:linear-gradient(135deg,var(--accent),var(--accent2)); border-color:transparent; color:#fff}
  .source-btn .ic{font-size:20px; display:block; margin-bottom:4px}

  .dropzone{border:1.5px dashed #38405a; border-radius:16px; padding:20px 14px; text-align:center; cursor:pointer}
  .dropzone.drag{border-color:var(--accent); background:rgba(124,155,255,.06)}
  .dropzone input[type=file]{display:none}
  .dz-icon{font-size:24px; margin-bottom:4px}
  .dz-title{font-weight:700; font-size:13px}
  .dz-sub{font-size:11.5px; color:var(--muted); margin-top:2px}

  .picked-tag{display:none; font-size:12px; background:var(--panel2); border:1px solid var(--border);
    border-radius:10px; padding:10px 12px; margin-top:10px; align-items:center; justify-content:space-between; gap:8px}
  .picked-tag.show{display:flex}
  .picked-tag .x{cursor:pointer; color:var(--err); font-weight:800; flex:none}

  .video-pick-list{display:flex; flex-direction:column; gap:8px; max-height:260px; overflow-y:auto}
  .video-pick-item{display:flex; align-items:center; justify-content:space-between; gap:8px;
    background:var(--panel2); border:1px solid var(--border); border-radius:12px; padding:10px 12px; cursor:pointer}
  .video-pick-item.sel{border-color:var(--accent); background:rgba(124,155,255,.08)}

  .fmt-row{display:flex; gap:10px}
  .fmt-btn{flex:1; background:var(--panel2); border:1px solid var(--border); border-radius:14px;
    padding:16px 8px; text-align:center; cursor:pointer}
  .fmt-btn.active{background:linear-gradient(135deg,var(--accent),var(--accent2)); border-color:transparent}
  .fmt-btn .ic{font-size:22px; display:block; margin-bottom:4px}
  .fmt-btn .t{font-weight:800; font-size:13px}
  .fmt-btn .s{font-size:10.5px; color:var(--muted); margin-top:2px}
  .fmt-btn.active .s{color:rgba(255,255,255,.85)}

  .btn{background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; border:none;
    padding:13px 20px; border-radius:14px; font-size:14px; font-weight:700; text-decoration:none;
    white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:6px; cursor:pointer;
    box-shadow:0 8px 20px rgba(124,155,255,.28); width:100%;}
  .btn:disabled{opacity:.4; cursor:not-allowed; box-shadow:none}
  .btn.dl{background:linear-gradient(135deg,var(--ok),#1fb583); box-shadow:0 8px 20px rgba(51,217,154,.25)}
  .btn.sm{width:auto; padding:9px 16px; font-size:12.5px; border-radius:11px}
  .btn.ghost{background:transparent; border:1px solid var(--border); box-shadow:none; color:var(--muted)}

  .progress-card{text-align:center; padding:30px 16px}
  .spinner{width:36px;height:36px;margin:0 auto 14px;border-radius:50%;
    border:3px solid var(--border); border-top-color:var(--accent); animation:spin .85s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .result-card{text-align:center; padding:22px 16px}
  .result-card .ic{font-size:38px; margin-bottom:8px}
  .err-box{background:#241019; color:var(--text); border-radius:12px; padding:12px 14px;
    font-size:12.5px; text-align:left; white-space:pre-wrap; margin-bottom:12px}

  /* -------- History -------- */
  .hist-card{background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:13px 14px;
    margin-bottom:9px; display:flex; align-items:center; justify-content:space-between; gap:10px}
  .hist-left{display:flex; align-items:center; gap:10px; min-width:0}
  .hist-ico{width:38px;height:38px;border-radius:11px;flex:none; display:flex;align-items:center;justify-content:center;
    font-size:16px; background:var(--panel2)}
  .hist-name{font-size:13px; font-weight:600; word-break:break-all}
  .hist-meta{font-size:11px; color:var(--muted); margin-top:2px; display:flex; gap:6px; flex-wrap:wrap}
  .hist-actions{display:flex; gap:6px; flex:none}
  .icon-btn{width:34px;height:34px;border-radius:10px;border:1px solid var(--border); background:var(--panel2);
    color:var(--muted); display:flex;align-items:center;justify-content:center; cursor:pointer; font-size:14px}
  .icon-btn.danger:hover{color:var(--err); border-color:var(--err)}
  .badge-sent{font-size:10px; color:var(--ok); background:rgba(51,217,154,.12); padding:2px 6px; border-radius:6px}

  .empty{color:var(--muted); font-size:12.5px; padding:30px 10px; text-align:center;
    border:1px dashed var(--border); border-radius:16px; background:var(--panel)}
  .empty .e-ico{font-size:26px; display:block; margin-bottom:6px; opacity:.6}

  /* -------- Profile -------- */
  .profile-card{background:var(--panel); border:1px solid var(--border); border-radius:20px; padding:26px 20px; text-align:center}
  .avatar{width:78px;height:78px;border-radius:50%; margin:0 auto 12px; object-fit:cover;
    border:3px solid var(--accent); background:var(--panel2); display:flex; align-items:center; justify-content:center; font-size:30px}
  .p-name{font-size:17px; font-weight:800}
  .p-username{font-size:12.5px; color:var(--muted); margin-top:2px}
  .p-stats{display:flex; justify-content:center; gap:26px; margin-top:18px}
  .p-stat b{display:block; font-size:18px; color:var(--accent)}
  .p-stat span{font-size:11px; color:var(--muted)}

  /* -------- Bottom nav -------- */
  .navbar{
    position:fixed; left:0; right:0; bottom:0; height:var(--navh); z-index:30;
    background:rgba(10,11,16,.92); backdrop-filter:blur(16px); border-top:1px solid var(--border);
    display:flex; padding-bottom:env(safe-area-inset-bottom);
  }
  .nav-item{flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:3px; color:var(--muted); font-size:10.5px; font-weight:700; cursor:pointer}
  .nav-item .ic{font-size:19px}
  .nav-item.active{color:var(--accent)}

  .toast{position:fixed; left:50%; bottom:calc(var(--navh) + 14px); transform:translateX(-50%);
    background:var(--panel2); border:1px solid var(--border); color:var(--text); padding:10px 18px;
    border-radius:12px; font-size:12.5px; z-index:50; opacity:0; pointer-events:none; transition:opacity .2s ease}
  .toast.show{opacity:1}

  .footer{text-align:center; margin-top:30px; padding:20px 0 6px; color:var(--muted); font-size:11.5px}
  .footer .badge{display:inline-flex; align-items:center; gap:6px; margin-top:8px; padding:6px 14px; border-radius:999px;
    background:linear-gradient(135deg,var(--accent),var(--accent2)); color:#fff; font-weight:800; font-size:11px}
</style>
</head>
<body>

<div class="topbar">
  <div class="logo">🎬</div>
  <div>
    <div class="title">Video Converter</div>
    <div class="sub">3GP · MP3 · Telegram integrated</div>
  </div>
</div>

<div class="wrap">

  <!-- ================= HOME ================= -->
  <div class="view active" id="view-home">
    <div class="hero">
      <div class="pill">⚡ ffmpeg powered</div>
      <h1>ভিডিও কনভার্টার</h1>
      <p>যেকোনো ভিডিওকে বাটন-ফোন উপযোগী 3GP অথবা MP3-তে রূপান্তর করো। গ্যালারি থেকে আপলোড করো, অথবা টেলিগ্রাম বটে ফরওয়ার্ড করে সরাসরি অ্যাপ থেকে কনভার্ট করো।</p>
    </div>
    <div class="stat-row">
      <div class="stat-card"><div class="n" id="home-myvideos">0</div><div class="l">আমার ভিডিও</div></div>
      <div class="stat-card"><div class="n" id="home-history">0</div><div class="l">কনভার্ট হিস্টোরি</div></div>
    </div>
    <button class="btn" onclick="goTab('tools')">🚀 এখনই কনভার্ট শুরু করো</button>

    <h2 class="section">📌 লিমিট</h2>
    <div class="hist-card"><div class="hist-left"><span class="hist-ico">📁</span><div><div class="hist-name">আপলোড</div><div class="hist-meta">সর্বোচ্চ 1 GB</div></div></div></div>
    <div class="hist-card"><div class="hist-left"><span class="hist-ico">📥</span><div><div class="hist-name">Telegram থেকে সেভ</div><div class="hist-meta">সর্বোচ্চ 20 MB</div></div></div></div>
    <div class="hist-card"><div class="hist-left"><span class="hist-ico">🤖</span><div><div class="hist-name">বটে ফেরত পাঠানো</div><div class="hist-meta">সর্বোচ্চ 50 MB</div></div></div></div>

    <div class="footer">Smart video tools for feature phones<div class="badge">✨ Developed by TANVIR SIYAM</div></div>
  </div>

  <!-- ================= TOOLS ================= -->
  <div class="view" id="view-tools">
    <div class="steps">
      <div class="step">
        <div class="step-head"><div class="step-num">1</div><div class="step-title">ভিডিও বাছাই করো</div></div>
        <div class="source-row">
          <div class="source-btn active" id="src-upload" onclick="selectSource('upload')"><span class="ic">📤</span>ডিভাইস থেকে</div>
          <div class="source-btn" id="src-myvideos" onclick="selectSource('myvideos')"><span class="ic">📥</span>আমার ভিডিও</div>
        </div>

        <div id="panel-src-upload">
          <div class="dropzone" id="dropzone">
            <div class="dz-icon">📤</div>
            <div class="dz-title">ট্যাপ করো বা ড্র্যাগ করো</div>
            <div class="dz-sub">সর্বোচ্চ 1 GB</div>
            <input type="file" id="fileInput" accept="video/*">
          </div>
          <div class="picked-tag" id="pickedTag"><span id="pickedTagText"></span><span class="x" onclick="clearPicked(event)">✕</span></div>
        </div>

        <div id="panel-src-myvideos" style="display:none">
          <div class="video-pick-list" id="videoPickList"><div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div></div>
        </div>
      </div>

      <div class="step">
        <div class="step-head"><div class="step-num">2</div><div class="step-title">আউটপুট ফরম্যাট</div></div>
        <div class="fmt-row">
          <div class="fmt-btn active" id="fmt-3gp" onclick="selectFormat('3gp')"><span class="ic">📱</span><div class="t">3GP</div><div class="s">বাটন ফোন ভিডিও</div></div>
          <div class="fmt-btn" id="fmt-mp3" onclick="selectFormat('mp3')"><span class="ic">🎵</span><div class="t">MP3</div><div class="s">শুধু অডিও</div></div>
        </div>
      </div>

      <button class="btn" id="convertBtn" disabled onclick="startConvert()">🚀 কনভার্ট করো</button>

      <div class="step" id="progressCard" style="display:none">
        <div class="progress-card" id="progressInner">
          <div class="spinner"></div>
          <div style="font-weight:700;margin-bottom:4px">কনভার্ট হচ্ছে...</div>
          <div style="color:var(--muted);font-size:12.5px">একটু অপেক্ষা করো, ফাইলের সাইজ অনুযায়ী সময় লাগতে পারে</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ================= HISTORY ================= -->
  <div class="view" id="view-history">
    <h2 class="section" style="margin-top:4px">✅ কনভার্ট হিস্টোরি <span id="hist-count" style="color:var(--muted);font-weight:600"></span></h2>
    <div id="historyList"><div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div></div>
    <div class="footer">টেম্প মেমোরিতে সংরক্ষিত — ডিলিট না করা পর্যন্ত ডাউনলোড করা যাবে</div>
  </div>

  <!-- ================= PROFILE ================= -->
  <div class="view" id="view-profile">
    <h2 class="section" style="margin-top:4px">👤 প্রোফাইল</h2>
    <div id="profileBox"><div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div></div>
    <div class="footer">Smart video tools for feature phones<div class="badge">✨ Developed by TANVIR SIYAM</div></div>
  </div>

</div>

<div class="navbar">
  <div class="nav-item active" data-tab="home" onclick="goTab('home')"><span class="ic">🏠</span>Home</div>
  <div class="nav-item" data-tab="tools" onclick="goTab('tools')"><span class="ic">🛠️</span>Tools</div>
  <div class="nav-item" data-tab="history" onclick="goTab('history')"><span class="ic">📚</span>History</div>
  <div class="nav-item" data-tab="profile" onclick="goTab('profile')"><span class="ic">👤</span>Profile</div>
</div>

<div class="toast" id="toast"></div>

<script>
  // ---------- Telegram Mini App bootstrap ----------
  let TG_INIT_DATA = "";
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg) { tg.ready(); tg.expand(); TG_INIT_DATA = tg.initData || ""; }
  } catch(e) {}

  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers || {}, {"X-Telegram-Init-Data": TG_INIT_DATA});
    return fetch(url, opts);
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'), 2200);
  }

  // ---------- Tab navigation ----------
  function goTab(tab) {
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active', n.dataset.tab===tab));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+tab).classList.add('active');
    if (tab === 'history') loadHistory();
    if (tab === 'profile') loadProfile();
    if (tab === 'home') loadHomeStats();
    if (tab === 'tools' && currentSource === 'myvideos') loadMyVideos();
  }

  // ---------- Tools: source + format state ----------
  let currentSource = 'upload';
  let currentFormat = '3gp';
  let pickedFile = null;       // {type:'upload', file:File} or {type:'telegram'|'upload', filename:...}

  function selectSource(src) {
    currentSource = src;
    document.getElementById('src-upload').classList.toggle('active', src==='upload');
    document.getElementById('src-myvideos').classList.toggle('active', src==='myvideos');
    document.getElementById('panel-src-upload').style.display = src==='upload' ? 'block' : 'none';
    document.getElementById('panel-src-myvideos').style.display = src==='myvideos' ? 'block' : 'none';
    pickedFile = null;
    updateConvertBtn();
    if (src === 'myvideos') loadMyVideos();
  }

  function selectFormat(fmt) {
    currentFormat = fmt;
    document.getElementById('fmt-3gp').classList.toggle('active', fmt==='3gp');
    document.getElementById('fmt-mp3').classList.toggle('active', fmt==='mp3');
  }

  function updateConvertBtn() {
    document.getElementById('convertBtn').disabled = !pickedFile;
  }

  // drag & drop / file pick
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  dz.addEventListener('click', ()=>fileInput.click());
  fileInput.addEventListener('change', ()=>{ if(fileInput.files[0]) setUploadFile(fileInput.files[0]); });
  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev, e=>{e.preventDefault(); dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev, e=>{e.preventDefault(); dz.classList.remove('drag');}));
  dz.addEventListener('drop', e=>{ const f=e.dataTransfer.files[0]; if(f) setUploadFile(f); });

  function setUploadFile(file) {
    pickedFile = {type:'pending-upload', file: file};
    const tag = document.getElementById('pickedTag');
    document.getElementById('pickedTagText').textContent = '🎬 ' + file.name + ' (' + (file.size/1024/1024).toFixed(1) + ' MB)';
    tag.classList.add('show');
    updateConvertBtn();
  }
  function clearPicked(e) {
    e.stopPropagation();
    pickedFile = null;
    fileInput.value = '';
    document.getElementById('pickedTag').classList.remove('show');
    updateConvertBtn();
  }

  function loadMyVideos() {
    const list = document.getElementById('videoPickList');
    list.innerHTML = '<div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div>';
    apiFetch('/api/my-videos').then(r=>r.json()).then(data=>{
      document.getElementById('home-myvideos').textContent = data.videos.length;
      if (!data.videos.length) {
        list.innerHTML = '<div class="empty"><span class="e-ico">📭</span>কোনো ভিডিও নেই — টেলিগ্রাম বটে ফরওয়ার্ড করো অথবা ডিভাইস থেকে আপলোড করো</div>';
        return;
      }
      list.innerHTML = '';
      data.videos.forEach(v=>{
        const item = document.createElement('div');
        item.className = 'video-pick-item';
        item.innerHTML = `<div style="min-width:0"><div style="font-weight:600;font-size:12.5px;word-break:break-all">${v.source==='telegram'?'📥':'🎞️'} ${v.name}</div><div style="font-size:11px;color:var(--muted)">${v.size}</div></div>`;
        item.onclick = ()=>{
          document.querySelectorAll('.video-pick-item').forEach(i=>i.classList.remove('sel'));
          item.classList.add('sel');
          pickedFile = {type: v.source, filename: v.name};
          updateConvertBtn();
        };
        list.appendChild(item);
      });
    });
  }

  async function startConvert() {
    if (!pickedFile) return;
    const btn = document.getElementById('convertBtn');
    btn.disabled = true;
    document.getElementById('progressCard').style.display = 'block';
    document.getElementById('progressCard').scrollIntoView({behavior:'smooth', block:'center'});

    try {
      let source, filename;
      if (pickedFile.type === 'pending-upload') {
        const fd = new FormData();
        fd.append('file', pickedFile.file);
        const upRes = await apiFetch('/api/upload', {method:'POST', body: fd});
        const upData = await upRes.json();
        if (upData.error) throw new Error(upData.error);
        source = 'upload'; filename = upData.filename;
      } else {
        source = pickedFile.type; filename = pickedFile.filename;
      }

      const res = await apiFetch('/api/convert', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({source, filename, format: currentFormat})
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      pollStatus(data.job_id);
    } catch (e) {
      showProgressError(e.message || 'একটি সমস্যা হয়েছে');
    }
  }

  function pollStatus(jobId) {
    const iv = setInterval(async ()=>{
      const r = await apiFetch('/api/status/' + jobId);
      const job = await r.json();
      if (job.status === 'finished') {
        clearInterval(iv);
        showProgressResult(job.result);
      } else if (job.status === 'error') {
        clearInterval(iv);
        showProgressError(job.error);
      }
    }, 2500);
  }

  function showProgressResult(result) {
    const el = document.getElementById('progressInner');
    el.innerHTML = `
      <div class="result-card">
        <div class="ic">✅</div>
        <div style="font-weight:800;margin-bottom:4px">কনভার্সন শেষ!</div>
        <div style="color:var(--muted);font-size:12.5px;margin-bottom:16px">
          ${result.filename} (${result.size})${result.sent_to_bot ? ' — টেলিগ্রাম বটেও পাঠানো হয়েছে ✓' : ''}
        </div>
        <a class="btn dl" href="${result.download_url}">⬇️ ডাউনলোড করো</a>
      </div>`;
    resetPicker();
    loadHomeStats();
  }

  function showProgressError(msg) {
    const el = document.getElementById('progressInner');
    el.innerHTML = `<div class="result-card"><div class="ic">⚠️</div>
      <div style="font-weight:800;color:var(--err);margin-bottom:8px">কনভার্সন ব্যর্থ হয়েছে</div>
      <div class="err-box">${msg}</div></div>`;
    document.getElementById('convertBtn').disabled = false;
  }

  function resetPicker() {
    pickedFile = null;
    fileInput.value = '';
    document.getElementById('pickedTag').classList.remove('show');
    document.querySelectorAll('.video-pick-item').forEach(i=>i.classList.remove('sel'));
    updateConvertBtn();
  }

  // ---------- History ----------
  function loadHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = '<div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div>';
    apiFetch('/api/history').then(r=>r.json()).then(data=>{
      document.getElementById('hist-count').textContent = data.history.length ? `(${data.history.length})` : '';
      document.getElementById('home-history').textContent = data.history.length;
      if (!data.history.length) {
        list.innerHTML = '<div class="empty"><span class="e-ico">📦</span>এখনো কোনো কনভার্সন নেই</div>';
        return;
      }
      list.innerHTML = '';
      data.history.forEach(h=>{
        const card = document.createElement('div');
        card.className = 'hist-card';
        card.innerHTML = `
          <div class="hist-left">
            <span class="hist-ico">${h.format==='mp3'?'🎵':'📱'}</span>
            <div>
              <div class="hist-name">${h.filename}</div>
              <div class="hist-meta"><span>${h.size}</span><span>·</span><span>${h.when}</span>${h.sent_to_bot?'<span class="badge-sent">বটে পাঠানো ✓</span>':''}</div>
            </div>
          </div>
          <div class="hist-actions">
            <a class="icon-btn" href="${h.download_url}" title="ডাউনলোড">⬇️</a>
            <div class="icon-btn danger" title="ডিলিট" onclick="deleteHistory('${h.id}', this)">🗑</div>
          </div>`;
        list.appendChild(card);
      });
    });
  }

  function deleteHistory(id, el) {
    if (!confirm('এই ফাইলটি স্থায়ীভাবে ডিলিট করতে চাও?')) return;
    apiFetch('/api/history/' + id, {method:'DELETE'}).then(r=>r.json()).then(d=>{
      if (d.deleted) { showToast('ডিলিট করা হয়েছে'); loadHistory(); }
    });
  }

  // ---------- Profile ----------
  function loadProfile() {
    const box = document.getElementById('profileBox');
    box.innerHTML = '<div class="empty"><span class="e-ico">⏳</span>লোড হচ্ছে...</div>';
    apiFetch('/api/profile').then(r=>r.json()).then(p=>{
      if (!p.is_telegram) {
        box.innerHTML = `<div class="profile-card">
          <div class="avatar">👤</div>
          <div class="p-name">গেস্ট ইউজার</div>
          <div class="p-username" style="margin-top:8px">টেলিগ্রাম বট থেকে অ্যাপটি খুললে তোমার প্রোফাইল এখানে অটোমেটিক দেখা যাবে</div>
        </div>`;
        return;
      }
      const fullName = (p.first_name + ' ' + (p.last_name||'')).trim();
      box.innerHTML = `<div class="profile-card">
        <img class="avatar" src="${p.photo_url}" onerror="this.outerHTML='<div class=avatar>👤</div>'">
        <div class="p-name">${fullName}</div>
        <div class="p-username">${p.username ? '@'+p.username : ''}</div>
        <div class="p-stats">
          <div class="p-stat"><b>${p.conversions}</b><span>কনভার্সন</span></div>
        </div>
      </div>`;
    });
  }

  function loadHomeStats() {
    apiFetch('/api/my-videos').then(r=>r.json()).then(d=>document.getElementById('home-myvideos').textContent = d.videos.length);
    apiFetch('/api/history').then(r=>r.json()).then(d=>document.getElementById('home-history').textContent = d.history.length);
  }

  loadHomeStats();
</script>
</body>
</html>
"""


@app.route("/")
def home():
    return render_template_string(PAGE)


if __name__ == "__main__":
    bot_thread = threading.Thread(target=telegram_polling_loop, daemon=True)
    bot_thread.start()

    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
