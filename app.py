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
FAV_FILE = DATA_DIR / "favorites.json"
# 즐겨찾기는 내 YouTube Music 계정의 비공개 재생목록에 저장한다. 다른 PC에서도 이 제목으로 찾는다.
FAV_TITLE = "즐겨찾기 (좋아요 뷰어)"
FAV_DESCRIPTION = "좋아요 뷰어 앱의 즐겨찾기예요. 앱에서 별을 누르면 여기에 추가되고 빠져요."
HOST = "127.0.0.1"
PORT = 8765

SESSION_EXPIRED = (
    "YouTube Music 로그인이 풀렸어요. 크롬(엣지)에서 복사한 연결은 크롬 보안 기능(DBSC) 때문에 "
    "10분쯤 뒤 끊겨요. 파이어폭스에서 로그인한 뒤 헤더를 복사해 다시 연결해 주세요."
)
CHROME_WARNING = (
    "연결됐지만, 크롬(엣지)에서 복사한 연결은 크롬 보안 기능 때문에 10분쯤 뒤 끊겨요. "
    "오래 쓰려면 파이어폭스에서 복사해 다시 연결해 주세요."
)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
refresh_lock = threading.Lock()
fav_lock = threading.Lock()  # 추가/삭제가 겹쳐서 즐겨찾기 파일을 덮어쓰지 않도록 한 번에 하나씩 처리한다


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


def is_signed_out(err: Exception) -> bool:
    # 로그인이 풀리면 YouTube Music이 'Sign in' 안내 화면을 돌려줘서 ytmusicapi 파싱이 실패한다.
    text = str(err)
    return "signInEndpoint" in text or "Sign in" in text


def yt_error(err: Exception, what: str) -> HTTPException:
    if isinstance(err, HTTPException):
        return err
    if is_signed_out(err):
        return HTTPException(401, SESSION_EXPIRED)
    return HTTPException(502, f"{what}\n({short(err)})")


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
        if is_signed_out(e):
            raise HTTPException(401, SESSION_EXPIRED)
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
    # 크롬 계열(엣지 포함)은 user-agent에 Chrome/이 들어 있다. 파이어폭스는 DBSC가 없어서 오래 유지된다.
    user_agent = saved.get("user-agent", "")
    return {"ok": True, "warning": CHROME_WARNING if "Chrome/" in user_agent and "Firefox/" not in user_agent else None}


@app.delete("/api/auth")
def disconnect():
    AUTH_FILE.unlink(missing_ok=True)
    return {"ok": True}


# ---------- 즐겨찾기 ----------
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def read_favs() -> dict:
    """playlistId: 즐겨찾기 재생목록 ID, items: {videoId: setVideoId(재생목록에서 뺄 때 필요)}"""
    try:
        favs = json.loads(FAV_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        favs = {}
    return {"playlistId": favs.get("playlistId"), "items": favs.get("items") or {}}


def write_favs(favs: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    tmp = FAV_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(favs, ensure_ascii=False), encoding="utf-8")
    tmp.replace(FAV_FILE)


def fav_response(favs: dict) -> dict:
    return {"ids": list(favs["items"]), "playlistId": favs["playlistId"]}


def yt_client() -> YTMusic:
    if not AUTH_FILE.exists():
        raise HTTPException(401, "YouTube Music 연결 정보가 없어요. 먼저 연결해 주세요.")
    return YTMusic(str(AUTH_FILE))


def pull_favs(yt: YTMusic, favs: dict) -> dict:
    """YouTube Music의 즐겨찾기 재생목록을 다시 읽는다. 다른 PC에서 바꾼 내용도 여기서 들어온다."""
    playlist_id, playlist = favs["playlistId"], None
    if playlist_id:
        try:
            playlist = yt.get_playlist(playlist_id, limit=None)
        except Exception as e:
            if is_signed_out(e):
                raise
            playlist_id = None  # 재생목록을 지웠거나 접근할 수 없으면 제목으로 다시 찾는다
    if not playlist_id:
        playlist_id = next(
            (p["playlistId"] for p in yt.get_library_playlists(limit=None) if p.get("title") == FAV_TITLE), None
        )
        playlist = yt.get_playlist(playlist_id, limit=None) if playlist_id else None
    tracks = (playlist or {}).get("tracks") or []
    return {"playlistId": playlist_id, "items": {t["videoId"]: t.get("setVideoId") for t in tracks if t.get("videoId")}}


def check_video_id(video_id: str) -> None:
    if not VIDEO_ID.fullmatch(video_id):
        raise HTTPException(400, "잘못된 곡 ID예요.")


@app.get("/api/favorites")
def favorites():
    return fav_response(read_favs())


@app.post("/api/favorites/sync")
def sync_favorites():
    with fav_lock:
        try:
            favs = pull_favs(yt_client(), read_favs())
        except Exception as e:
            raise yt_error(e, "즐겨찾기를 불러오지 못했어요.") from e
        write_favs(favs)
        return fav_response(favs)


def ensure_playlist(yt: YTMusic, favs: dict) -> dict:
    if not favs["playlistId"]:
        favs = pull_favs(yt, favs)  # 다른 PC에서 이미 만들었을 수 있다
    if not favs["playlistId"]:
        playlist_id = yt.create_playlist(FAV_TITLE, FAV_DESCRIPTION, privacy_status="PRIVATE")
        if not isinstance(playlist_id, str):
            raise RuntimeError(f"재생목록을 만들지 못했어요: {str(playlist_id)[:200]}")
        favs = {"playlistId": playlist_id, "items": {}}
    return favs


def add_video(yt: YTMusic, favs: dict, video_id: str) -> None:
    # duplicates=True면 이미 들어 있는 곡은 건너뛴다(다른 PC에서 먼저 추가한 경우).
    result = yt.add_playlist_items(favs["playlistId"], [video_id], duplicates=True)
    if not isinstance(result, dict) or "SUCCEEDED" not in str(result.get("status")):
        raise RuntimeError(f"YouTube Music 응답: {str(result)[:200]}")
    added = next((r for r in result.get("playlistEditResults") or [] if r and r.get("videoId") == video_id), None)
    favs["items"][video_id] = added.get("setVideoId") if added else None


def remove_video(yt: YTMusic, favs: dict, video_id: str) -> None:
    set_video_id = favs["items"].get(video_id)
    if favs["playlistId"] and set_video_id:
        result = yt.remove_playlist_items(favs["playlistId"], [{"videoId": video_id, "setVideoId": set_video_id}])
        if "SUCCEEDED" not in str(result):
            raise RuntimeError(f"YouTube Music 응답: {str(result)[:200]}")
    favs["items"].pop(video_id, None)


@app.put("/api/favorites/{video_id}")
def add_favorite(video_id: str):
    check_video_id(video_id)
    with fav_lock:
        favs = read_favs()
        try:
            yt = yt_client()
            favs = ensure_playlist(yt, favs)
            if video_id not in favs["items"]:
                try:
                    add_video(yt, favs, video_id)
                except Exception as e:
                    if is_signed_out(e):
                        raise
                    # 다른 PC나 휴대폰에서 재생목록을 지웠을 수 있다. 다시 찾아보고 한 번 더 시도한다.
                    favs = ensure_playlist(yt, pull_favs(yt, favs))
                    if video_id not in favs["items"]:
                        add_video(yt, favs, video_id)
        except Exception as e:
            raise yt_error(e, "즐겨찾기에 추가하지 못했어요.") from e
        write_favs(favs)
        return fav_response(favs)


@app.delete("/api/favorites/{video_id}")
def remove_favorite(video_id: str):
    check_video_id(video_id)
    with fav_lock:
        favs = read_favs()
        try:
            yt = yt_client()
            if favs["playlistId"] and not favs["items"].get(video_id):
                favs = pull_favs(yt, favs)  # 다른 PC에서 추가한 곡이면 setVideoId를 아직 모른다
            try:
                remove_video(yt, favs, video_id)
            except Exception as e:
                if is_signed_out(e):
                    raise
                # 재생목록이나 곡이 다른 곳에서 이미 지워졌을 수 있다. 최신 상태로 다시 시도한다.
                favs = pull_favs(yt, favs)
                remove_video(yt, favs, video_id)
        except Exception as e:
            raise yt_error(e, "즐겨찾기에서 빼지 못했어요.") from e
        write_favs(favs)
        return fav_response(favs)


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
