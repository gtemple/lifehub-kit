import json
import time
import urllib.request

from django.conf import settings

OLLAMA_URL = 'http://localhost:11434'
PICK_S = 30  # how long a choice of Ollama stands before it is checked again
GEMINI_MODELS = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key={key}'
# Open-Meteo: free, no key
WEATHER = 'https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m'
TIMEOUT = 3


def get_json(url):
    with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
        return json.load(r)


def up(url):
    try:
        get_json(url)
        return True
    except Exception:
        return False


def ollama_hosts():
    """The Ollama to use. Its model stays loaded: loading on a CPU is slow."""
    cfg = settings.LIFEHUB
    return [{'where': 'mac', 'url': cfg.get('ollama_url', OLLAMA_URL).rstrip('/'), 'model': cfg.get('ollama_model', 'qwen3.5:4b'),
             'keep_alive': '10m', 'timeout': 600}]


_picked = {'at': -PICK_S, 'host': None}


def ollama():
    """The Ollama to use right now: the scheduled one, or the other when it's away. Checked at most every 30 s."""
    if time.monotonic() - _picked['at'] < PICK_S and _picked['host']:
        return _picked['host']
    hosts = ollama_hosts()
    host = next((h for h in hosts if up(h['url'] + '/api/tags')), hosts[0])
    _picked.update(at=time.monotonic(), host=host)
    return host


def ollama_up():
    return up(ollama()['url'] + '/api/tags')


def gemini_private():
    """Settings > Allow Gemini for private data, and a key to use it with."""
    from hub.models import Setting
    return bool(Setting.get('gemini_private', False)) and bool(settings.LIFEHUB.get('gemini_api_key'))


def private_up():
    """Can private data (mail, notes, calendar) be worked on right now?"""
    return gemini_private() or ollama_up()


def agent_status():
    cfg = settings.LIFEHUB
    ollama = ollama_up()
    key = cfg.get('gemini_api_key')
    gemini = bool(key) and up(GEMINI_MODELS.format(key=key))
    # local first: Ollama is free and keeps private data home; Gemini only when Ollama is away
    active = 'ollama' if ollama else 'gemini' if gemini else 'none'
    return {
        'online': ollama or gemini,
        'activeModel': active,
        'ollamaUp': ollama,
        'geminiUp': gemini,
    }


def weather():
    w = settings.LIFEHUB['weather']
    temp = get_json(WEATHER.format(lat=w['lat'], lon=w['lon']))['current']['temperature_2m']
    return {'city': w['city'], 'tempC': temp}
