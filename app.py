"""YouTube Music 좋아요 목록을 한 화면에 보여주는 로컬 웹앱.

실행: python app.py  (기본 주소 http://127.0.0.1:8765)
"""

import json
import re
import shlex
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from ytmusicapi import YTMusic, setup
from ytmusicapi.exceptions import YTMusicUserError

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
AUTH_FILE = DATA_DIR / "browser.json"
CACHE_FILE = DATA_DIR / "liked.json"
HOST = "127.0.0.1"
PORT = 8765

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
refresh_lock = threading.Lock()


def read_cache() -> dict | None:
    try:
        return json.loads(CACHE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_cache(data: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(CACHE_FILE)


def short(err: Exception, limit: int = 300) -> str:
    text = str(err).strip() or type(err).__name__
    return text if len(text) <= limit else text[:limit] + "…"


def pick_thumb(thumbs: list[dict] | None) -> str | None:
    """40px 썸네일(레티나 2배)에 충분한 가장 작은 이미지를 고른다."""
    if not thumbs:
        return None
    big_enough = [t for t in thumbs if (t.get("width") or 0) >= 80]
    return min(big_enough, key=lambda t: t["width"])["url"] if big_enough else thumbs[-1]["url"]


def parse_duration(track: dict) -> int:
    if track.get("duration_seconds"):
        return int(track["duration_seconds"])
    seconds = 0
    for part in (track.get("duration") or "").split(":"):
        if not part.isdigit():
            return 0
        seconds = seconds * 60 + int(part)
    return seconds


def normalize(tracks: list[dict]) -> list[dict]:
    """ytmusicapi 트랙을 화면에 필요한 필드만 남긴 형태로 줄인다. i=0이 가장 최근에 좋아요한 곡."""
    songs = []
    for i, track in enumerate(tracks):
        album = track.get("album") or {}
        songs.append({
            "i": i,
            "id": track.get("videoId"),
            "title": track.get("title") or "(제목 없음)",
            "artists": [a["name"] for a in track.get("artists") or [] if a.get("name")],
            "album": album.get("name"),
            "dur": parse_duration(track),
            "thumb": pick_thumb(track.get("thumbnails")),
            "ok": bool(track.get("videoId")) and track.get("isAvailable") is not False,
            "explicit": bool(track.get("isExplicit")),
        })
    return songs


@app.get("/api/status")
def status():
    cache = read_cache()
    return {
        "authed": AUTH_FILE.exists(),
        "count": len(cache["tracks"]) if cache else 0,
        "fetchedAt": cache["fetchedAt"] if cache else None,
    }


@app.get("/api/liked")
def liked():
    return read_cache() or {"fetchedAt": None, "tracks": []}


@app.post("/api/refresh")
def refresh():
    if not AUTH_FILE.exists():
        raise HTTPException(401, "YouTube Music 연결 정보가 없어요. 먼저 연결해 주세요.")
    if not refresh_lock.acquire(blocking=False):
        raise HTTPException(409, "이미 목록을 불러오는 중이에요.")
    try:
        raw = YTMusic(str(AUTH_FILE)).get_liked_songs(limit=None)
        data = {"fetchedAt": time.time(), "tracks": normalize(raw.get("tracks") or [])}
        write_cache(data)
        return data
    except Exception as e:
        raise HTTPException(
            502,
            "YouTube Music에서 목록을 불러오지 못했어요. 로그인이 만료됐다면 설정에서 다시 연결해 주세요.\n"
            f"({short(e)})",
        )
    finally:
        refresh_lock.release()


class AuthBody(BaseModel):
    headers: str


def curl_to_raw_headers(command: str) -> str:
    """크롬의 'Copy as cURL (bash)' 결과에서 헤더와 쿠키만 뽑아 'name: value' 줄로 바꾼다."""
    command = command.replace("\\\r\n", " ").replace("\\\n", " ")
    # 요청 본문(--data-raw $'…')은 shlex가 못 읽는 bash 전용 따옴표를 쓸 수 있다. 크롬은 본문을 헤더 뒤에 두므로 잘라낸다.
    command = re.split(r"\s--data(?:-raw|-binary|-ascii)?\s", command, maxsplit=1)[0]
    args = shlex.split(command)
    lines = []
    for flag, value in zip(args, args[1:]):
        if flag in ("-H", "--header"):
            lines.append(value)
        elif flag in ("-b", "--cookie"):  # 최신 크롬은 쿠키를 -H가 아니라 -b로 넣는다
            lines.append(f"cookie: {value}")
    return "\n".join(lines)


@app.post("/api/auth")
def connect(body: AuthBody):
    raw = body.headers.strip().replace("\r\n", "\n")
    if raw.startswith("curl "):
        if '^"' in raw:
            raise HTTPException(400, "Windows cmd용 cURL이에요. Copy as cURL (bash)로 다시 복사해 주세요.")
        try:
            raw = curl_to_raw_headers(raw)
        except ValueError as e:
            raise HTTPException(400, f"cURL 명령을 읽지 못했어요. 끝까지 복사됐는지 확인해 주세요.\n({short(e)})")

    DATA_DIR.mkdir(exist_ok=True)
    tmp = DATA_DIR / "browser.tmp.json"
    try:
        setup(filepath=str(tmp), headers_raw=raw)
    except YTMusicUserError:
        tmp.unlink(missing_ok=True)
        raise HTTPException(
            400,
            "헤더에 cookie 또는 x-goog-authuser 항목이 없어요. "
            "Network 탭의 browse 요청에서 복사했는지, 로그인된 상태인지 확인해 주세요.",
        )
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, f"헤더를 읽지 못했어요. 복사한 내용을 다시 확인해 주세요.\n({short(e)})")

    # ytmusicapi는 authorization에 SAPISIDHASH가 있어야 브라우저 인증으로 인식한다.
    saved = {k.lower(): v for k, v in json.loads(tmp.read_text(encoding="utf-8")).items()}
    if "SAPISIDHASH" not in saved.get("authorization", ""):
        tmp.unlink(missing_ok=True)
        raise HTTPException(
            400,
            "헤더에 authorization(SAPISIDHASH …) 항목이 없어요. "
            "Network 탭에서 browse 요청(POST)의 헤더를 복사했는지 확인해 주세요.",
        )

    # 헤더 형식만 맞고 로그인이 안 된 경우를 걸러내기 위해 실제로 한 곡을 요청해 본다.
    try:
        YTMusic(str(tmp)).get_liked_songs(limit=1)
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise HTTPException(
            400,
            "헤더는 읽었지만 YouTube Music 로그인 확인에 실패했어요. "
            f"로그인된 상태에서 새로 복사해 주세요.\n({short(e)})",
        )
    tmp.replace(AUTH_FILE)
    return {"ok": True}


@app.delete("/api/auth")
def disconnect():
    AUTH_FILE.unlink(missing_ok=True)
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    print(f"좋아요 목록 뷰어: {url}  (종료: Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, webbrowser.open, args=[url]).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
