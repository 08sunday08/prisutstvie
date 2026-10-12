import json
import os
import csv
import io
import shutil
import socket
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).parent
DATA_FILE = ROOT / "data.json"
ARCHIVE_FILE = ROOT / "archive.json"
HOST = "0.0.0.0"
PORT = 0
LOCK = threading.Lock()
STATUS_TTL = timedelta(hours=8)

TECHNICIAN_ACCOUNTS = {
    "IgorDobro": {"password": "KompKlass20@@", "id": "igor"},
    "Ilia": {"password": "KompKlass20@@", "id": "ilia"},
}
ADMIN_ACCOUNT = {"login": "admin", "password": "Admin123!", "id": "admin", "name": "Администратор"}
DISPATCHER_ACCOUNT = {"login": "dispatcher", "password": "Dispatcher123!", "id": "dispatcher", "name": "Распределитель"}

DEFAULT_STATE = {
    "accounts": {
        "IgorDobro": {"password": "KompKlass20@@", "id": "igor"},
        "Ilia": {"password": "KompKlass20@@", "id": "ilia"},
    },
    "technicians": [
        {
            "id": "igor", "name": "Игорь Румянцев", "role": "Техник",
            "present": True, "work_status": "free", "status_text": "Готов помочь",
        },
        {
            "id": "ilia", "name": "Илья", "role": "Техник",
            "present": False, "work_status": "away", "status_text": "Буду после 14:00",
        },
    ],
    "requests": [
        {
            "id": 1, "title": "Не работает проектор", "room": "Кабинет 214",
            "author": "Елена Соколова",
            "description": "Проектор не видит сигнал от ноутбука.",
            "priority": "Обычно", "status": "new", "assignee": "",
            "created_at": "Сегодня, 09:42", "updated_at": "Сегодня, 09:42",
        },
        {
            "id": 2, "title": "Нужен доступ к принтеру", "room": "Кабинет 108",
            "author": "Игорь Павлов",
            "description": "Добавить компьютер в общий принтер.",
            "priority": "Низкий", "status": "in_progress",
            "assignee": "Игорь Румянцев",
            "created_at": "Сегодня, 09:10", "updated_at": "Сегодня, 09:24",
        },
        {
            "id": 3, "title": "Подготовить компьютер к занятию", "room": "Лаборатория 3",
            "author": "Наталья Романова",
            "description": "Проверить звук и вход в учебную платформу.",
            "priority": "Срочно", "status": "done", "assignee": "Илья",
            "created_at": "Вчера, 16:18", "updated_at": "Вчера, 16:51",
        },
    ],
    "next_id": 4,
}


def load_state():
    if not DATA_FILE.exists():
        save_state(DEFAULT_STATE)
    try:
        state = json.loads(DATA_FILE.read_text(encoding="utf-8"))
        state.setdefault("accounts", {login: dict(account) for login, account in TECHNICIAN_ACCOUNTS.items()})
        return state
    except (OSError, json.JSONDecodeError):
        return json.loads(json.dumps(DEFAULT_STATE))


def save_state(state):
    DATA_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def load_archive():
    if not ARCHIVE_FILE.exists():
        return {"requests": []}
    try:
        archive = json.loads(ARCHIVE_FILE.read_text(encoding="utf-8"))
        archive.setdefault("requests", [])
        return archive
    except (OSError, json.JSONDecodeError):
        return {"requests": []}


def archive_completed_requests(state):
    today = datetime.now().date()
    active_requests = []
    archived_requests = []
    for request in state.get("requests", []):
        normalize_request(request)
        if request.get("status") != "done":
            active_requests.append(request)
            continue
        try:
            completed_date = datetime.fromisoformat(request.get("completed_at", "")).date()
        except ValueError:
            active_requests.append(request)
            continue
        if completed_date < today:
            archived_requests.append(request)
        else:
            active_requests.append(request)

    if not archived_requests:
        return False

    archive = load_archive()
    existing_ids = {item.get("id") for item in archive["requests"]}
    archive["requests"].extend(item for item in archived_requests if item.get("id") not in existing_ids)
    ARCHIVE_FILE.write_text(json.dumps(archive, ensure_ascii=False, indent=2), encoding="utf-8")
    state["requests"] = active_requests
    return True


def now_label():
    return datetime.now().strftime("Сегодня, %H:%M")


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def normalize_technician(technician):
    technician.setdefault("schedule", {"days": ["Пн", "Вт", "Ср", "Чт", "Пт"], "from": "08:00", "to": "17:00"})
    technician.setdefault("last_status_update", "")
    if not technician["last_status_update"]:
        technician["last_status_update"] = now_iso()
    return technician


def refresh_technician_statuses(technicians):
    now = datetime.now()
    changed = False
    for technician in technicians:
        normalize_technician(technician)
        try:
            last_update = datetime.fromisoformat(technician["last_status_update"])
        except ValueError:
            last_update = now
        if now - last_update > STATUS_TTL and technician.get("present"):
            technician["present"] = False
            technician["work_status"] = "away"
            technician["status_text"] = "Статус устарел"
            changed = True
    return changed


def status_label(status):
    return {"new": "Новая", "in_progress": "В работе", "done": "Выполнено"}.get(status, status)


def normalize_request(request):
    request.setdefault("assignee", "")
    request.setdefault("completed_by", "")
    request.setdefault("completed_at", "")
    request.setdefault("comments", [])
    request.setdefault("history", [])
    return request


def request_stats(requests):
    today = datetime.now().date()
    month = today.strftime("%Y-%m")
    completed = [item for item in requests if item.get("status") == "done"]
    completed_today = sum(
        1 for item in completed
        if item.get("completed_at", "").startswith(today.isoformat())
        or item.get("updated_at", "").startswith("Сегодня")
    )
    completed_month = sum(
        1 for item in completed
        if item.get("completed_at", "").startswith(month)
    )
    return {
        "total": len(requests),
        "new": sum(item.get("status") == "new" for item in requests),
        "in_progress": sum(item.get("status") == "in_progress" for item in requests),
        "done": len(completed),
        "completed_today": completed_today,
        "completed_month": completed_month,
    }


def technician_stats(technicians, requests):
    result = []
    for technician in technicians:
        completed = [
            item for item in requests
            if item.get("status") == "done"
            and (item.get("completed_by") or item.get("assignee")) == technician["name"]
        ]
        result.append({
            "id": technician["id"],
            "name": technician["name"],
            "count": len(completed),
            "requests": [
                {
                    "id": item.get("id"),
                    "title": item.get("title", ""),
                    "room": item.get("room", ""),
                    "author": item.get("author", ""),
                    "completed_at": item.get("completed_at", ""),
                }
                for item in completed
            ],
        })
    return result


def sync_technician_work_status(technicians, requests):
    active_assignees = {
        request.get("assignee")
        for request in requests
        if request.get("status") == "in_progress" and request.get("assignee")
    }
    changed = False
    for technician in technicians:
        if technician.get("name") not in active_assignees:
            continue
        if technician.get("work_status") != "busy" or technician.get("status_text") != "Занят заявкой":
            technician["work_status"] = "busy"
            technician["status_text"] = "Занят заявкой"
            technician["last_status_update"] = now_iso()
            changed = True
    return changed


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/export.csv":
            with LOCK:
                state = load_state()
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow([
                    "ID", "Тема", "Кабинет", "Автор", "Приоритет",
                    "Статус", "Исполнитель", "Создана", "Обновлена",
                ])
                for item in state["requests"]:
                    writer.writerow([
                        item.get("id", ""), item.get("title", ""), item.get("room", ""),
                        item.get("author", ""), item.get("priority", ""),
                        status_label(item.get("status", "")), item.get("assignee", ""),
                        item.get("created_at", ""), item.get("updated_at", ""),
                    ])
                body = ("\ufeff" + output.getvalue()).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", "attachment; filename=requests.csv")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        if path == "/api/state":
            with LOCK:
                state = load_state()
                archive_completed_requests(state)
                if refresh_technician_statuses(state["technicians"]):
                    save_state(state)
                else:
                    save_state(state)
                state["technicians"] = [normalize_technician(item) for item in state["technicians"]]
                for technician in state["technicians"]:
                    technician["login"] = next(
                        (login for login, account in state.get("accounts", {}).items()
                         if account.get("id") == technician["id"]),
                        "",
                    )
                state["requests"] = [normalize_request(item) for item in state["requests"]]
                if sync_technician_work_status(state["technicians"], state["requests"]):
                    save_state(state)
                state["stats"] = request_stats(state["requests"])
                state["technician_stats"] = technician_stats(state["technicians"], state["requests"])
                self.send_json(state)
            return
        if path in ("/", "/index.html"):
            self.serve_file(ROOT / "index.html", "text/html; charset=utf-8")
            return
        if path == "/dispatcher.html":
            self.serve_file(ROOT / "dispatcher.html", "text/html; charset=utf-8")
            return
        if path == "/styles.css":
            self.serve_file(ROOT / "styles.css", "text/css; charset=utf-8")
            return
        if path == "/app.js":
            self.serve_file(ROOT / "app.js", "application/javascript; charset=utf-8")
            return
        if path == "/dispatcher.js":
            self.serve_file(ROOT / "dispatcher.js", "application/javascript; charset=utf-8")
            return
        if path == "/dispatcher.css":
            self.serve_file(ROOT / "dispatcher.css", "text/css; charset=utf-8")
            return
        self.send_json({"error": "Не найдено"}, 404)

    def serve_file(self, path, content_type):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_json({"error": "Файл не найден"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            payload = self.read_json()
            with LOCK:
                state = load_state()
                if archive_completed_requests(state):
                    save_state(state)
                if path == "/api/login":
                    if payload.get("login") == ADMIN_ACCOUNT["login"] and payload.get("password") == ADMIN_ACCOUNT["password"]:
                        self.send_json({"id": ADMIN_ACCOUNT["id"], "name": ADMIN_ACCOUNT["name"], "role": "admin"})
                        return
                    if payload.get("login") == DISPATCHER_ACCOUNT["login"] and payload.get("password") == DISPATCHER_ACCOUNT["password"]:
                        self.send_json({"id": DISPATCHER_ACCOUNT["id"], "name": DISPATCHER_ACCOUNT["name"], "role": "dispatcher"})
                        return
                    account = state.get("accounts", {}).get(payload.get("login")) or TECHNICIAN_ACCOUNTS.get(payload.get("login"))
                    if not account or account["password"] != payload.get("password"):
                        self.send_json({"error": "Неверный логин или пароль"}, 401)
                        return
                    technician = next(item for item in state["technicians"] if item["id"] == account["id"])
                    self.send_json({"id": technician["id"], "name": technician["name"], "role": "tech"})
                    return
                if path == "/api/status":
                    technician = normalize_technician(next(item for item in state["technicians"] if item["id"] == payload["id"]))
                    technician["present"] = bool(payload.get("present", technician["present"]))
                    technician["work_status"] = payload.get("work_status", technician["work_status"])
                    technician["status_text"] = payload.get("status_text", technician["status_text"])
                    technician["last_status_update"] = now_iso()
                    save_state(state)
                    self.send_json(state)
                    return
                if path == "/api/admin/technician":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    name = str(payload.get("name", "")).strip()
                    login = str(payload.get("login", "")).strip()
                    password = str(payload.get("password", "")).strip()
                    if not name or not login or not password:
                        self.send_json({"error": "Заполните имя, логин и пароль"}, 400)
                        return
                    technician_id = login.lower().replace(" ", "-")
                    if any(item["id"] == technician_id for item in state["technicians"]):
                        self.send_json({"error": "Такой логин уже используется"}, 409)
                        return
                    state["technicians"].append({
                        "id": technician_id, "name": name, "role": "Техник",
                        "present": False, "work_status": "away",
                        "status_text": "Не на месте",
                        "schedule": {
                            "days": ["Пн", "Вт", "Ср", "Чт", "Пт"],
                            "from": "08:00", "to": "17:00",
                        },
                        "last_status_update": now_iso(),
                    })
                    state.setdefault("accounts", {})[login] = {"password": password, "id": technician_id}
                    save_state(state)
                    self.send_json(state, 201)
                    return
                if path == "/api/admin/technician/delete":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    technician = next(item for item in state["technicians"] if item["id"] == payload["id"])
                    if len(state["technicians"]) <= 1:
                        self.send_json({"error": "Нельзя удалить последнего техника"}, 400)
                        return
                    state["technicians"].remove(technician)
                    for login, account in list(state.get("accounts", {}).items()):
                        if account["id"] == technician["id"]:
                            del state["accounts"][login]
                    save_state(state)
                    self.send_json(state)
                    return
                if path == "/api/admin/technician/update":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    technician = next(item for item in state["technicians"] if item["id"] == payload["id"])
                    old_name = technician.get("name", "")
                    name = str(payload.get("name", "")).strip()
                    login = str(payload.get("login", "")).strip()
                    password = str(payload.get("password", "")).strip()
                    if not name or not login:
                        self.send_json({"error": "Имя и логин обязательны"}, 400)
                        return
                    duplicate = any(
                        account_login.lower() == login.lower() and account.get("id") != technician["id"]
                        for account_login, account in state.get("accounts", {}).items()
                    )
                    if duplicate:
                        self.send_json({"error": "Такой логин уже используется"}, 409)
                        return
                    old_login, account = next(
                        (account_login, account)
                        for account_login, account in state.get("accounts", {}).items()
                        if account.get("id") == technician["id"]
                    )
                    technician["name"] = name
                    if old_login != login:
                        del state["accounts"][old_login]
                        state["accounts"][login] = account
                    if password:
                        state["accounts"][login]["password"] = password
                    for request in state["requests"]:
                        if request.get("assignee") == old_name:
                            request["assignee"] = name
                        if request.get("completed_by") == old_name:
                            request["completed_by"] = name
                    save_state(state)
                    self.send_json({"ok": True})
                    return
                if path == "/api/admin/password":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    account_login, account = next((login, account) for login, account in state.get("accounts", {}).items() if account["id"] == payload["id"])
                    password = str(payload.get("password", ""))
                    if not password:
                        self.send_json({"error": "Пароль не может быть пустым"}, 400)
                        return
                    state["accounts"][account_login]["password"] = password
                    save_state(state)
                    self.send_json({"ok": True})
                    return
                if path == "/api/admin/schedule":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    technician = normalize_technician(next(item for item in state["technicians"] if item["id"] == payload["id"]))
                    technician["schedule"] = {"days": payload.get("days", []), "from": payload.get("from", "08:00"), "to": payload.get("to", "17:00")}
                    save_state(state)
                    self.send_json({"ok": True})
                    return
                if path == "/api/admin/backup":
                    if payload.get("admin_id") != ADMIN_ACCOUNT["id"]:
                        self.send_json({"error": "Недостаточно прав"}, 403)
                        return
                    backup = DATA_FILE.with_name(f"data-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
                    shutil.copy2(DATA_FILE, backup)
                    self.send_json({"file": backup.name})
                    return
                if path == "/api/requests":
                    request = {
                        "id": state["next_id"], "title": payload.get("title", "Новая заявка"),
                        "room": payload.get("room", ""), "author": payload.get("author", "Преподаватель"),
                        "description": payload.get("description", ""), "priority": payload.get("priority", "Обычно"),
                        "status": "new", "assignee": "", "completed_by": "", "completed_at": "",
                        "created_at": now_label(), "updated_at": now_label(),
                        "comments": [], "history": [{"at": now_iso(), "text": "Заявка создана", "by": payload.get("author", "Преподаватель")}],
                    }
                    state["next_id"] += 1
                    state["requests"].insert(0, request)
                    save_state(state)
                    self.send_json(request, 201)
                    return
                if path == "/api/requests/update":
                    request = normalize_request(next(item for item in state["requests"] if item["id"] == payload["id"]))
                    previous_status = request["status"]
                    previous_assignee = request.get("assignee", "")
                    actor = payload.get("actor", "Техник")
                    if "assignee" in payload and actor not in ("Распределитель", "Администратор"):
                        self.send_json({"error": "Назначать исполнителя может только распределитель"}, 403)
                        return
                    if "status" in payload and actor not in ("Распределитель", "Администратор"):
                        if request.get("assignee") != actor:
                            self.send_json({"error": "Изменять статус может только назначенный техник"}, 403)
                            return
                    if "status" in payload:
                        request["status"] = payload["status"]
                    if "assignee" in payload:
                        request["assignee"] = payload["assignee"]
                    assigned_technician = next(
                        (
                            technician for technician in state["technicians"]
                            if technician.get("name") == request.get("assignee")
                        ),
                        None,
                    )
                    if request["status"] == "in_progress" and assigned_technician:
                        assigned_technician["work_status"] = "busy"
                        assigned_technician["status_text"] = "Занят заявкой"
                        assigned_technician["last_status_update"] = now_iso()
                    if request["status"] == "done":
                        request["completed_by"] = payload.get("completed_by") or request.get("assignee", "")
                        request["completed_at"] = now_iso()
                        if assigned_technician:
                            assigned_technician["work_status"] = "free"
                            assigned_technician["status_text"] = "Готов помочь"
                            assigned_technician["last_status_update"] = now_iso()
                    else:
                        request["completed_by"] = ""
                        request["completed_at"] = ""
                    request["updated_at"] = now_label()
                    if previous_status != request["status"]:
                        request["history"].append({"at": now_iso(), "text": f"Статус: {status_label(request['status'])}", "by": actor})
                    if previous_assignee != request.get("assignee", ""):
                        assignee = request.get("assignee") or "не назначен"
                        request["history"].append({"at": now_iso(), "text": f"Назначен исполнитель: {assignee}", "by": actor})
                    save_state(state)
                    self.send_json(request)
                    return
                if path == "/api/requests/comment":
                    request = normalize_request(next(item for item in state["requests"] if item["id"] == payload["id"]))
                    text = str(payload.get("text", "")).strip()
                    if not text:
                        self.send_json({"error": "Комментарий не может быть пустым"}, 400)
                        return
                    comment = {"text": text, "at": now_iso(), "by": payload.get("author", "Техник")}
                    request["comments"].append(comment)
                    request["history"].append({"at": comment["at"], "text": "Добавлен комментарий", "by": comment["by"]})
                    request["updated_at"] = now_label()
                    save_state(state)
                    self.send_json(request)
                    return
        except (KeyError, StopIteration, TypeError, json.JSONDecodeError):
            self.send_json({"error": "Некорректные данные"}, 400)
            return
        self.send_json({"error": "Не найдено"}, 404)


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as error:
        print(f"Не удалось запустить сервер: {error}")
        raise SystemExit(1)

    PORT = server.server_address[1]
    local_ips = sorted({
        address[4][0]
        for address in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        if not address[4][0].startswith("127.")
    })
    print(f"Сервис запущен: http://localhost:{PORT}")
    if local_ips:
        print("Для коллег в сети откройте один из адресов:")
        for local_ip in local_ips:
            print(f"  http://{local_ip}:{PORT}")
    else:
        print(f"IP компьютера не найден. Используйте ipconfig и порт {PORT}.")
    print("Окно сервера должно оставаться открытым. Для остановки нажмите Ctrl+C.")
    server.serve_forever()