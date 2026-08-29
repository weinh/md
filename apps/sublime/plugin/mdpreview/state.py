"""Global plugin state: settings handle and the set of tracked preview buffers."""

import os
import threading
import time

import sublime

SETTINGS_FILE = 'MdPreview.sublime-settings'


def debug_log(message):
    """Append to the cache debug.log when the "debug" setting is on."""
    current = _state
    if current is None or not current.settings.get('debug', False):
        return
    try:
        os.makedirs(os.path.dirname(current.debug_path), exist_ok=True)
        with open(current.debug_path, 'a', encoding='utf-8') as handle:
            handle.write('%s %s\n' % (time.strftime('%H:%M:%S'), message))
    except OSError:
        pass


class MdPreviewState(object):
    """Tracks which buffers have an open preview.

    ``tracked`` maps buffer_id -> {'url_path': str, 'rev': int}. Guarded by a
    lock because it is touched from main and worker threads.
    """

    def __init__(self):
        self.settings = sublime.load_settings(SETTINGS_FILE)
        self.debug_path = os.path.join(sublime.cache_path(), 'MdPreview', 'debug.log')
        self._lock = threading.Lock()
        self._tracked = {}

    def track(self, buffer_id, url_path, rev):
        with self._lock:
            self._tracked[buffer_id] = {'url_path': url_path, 'rev': rev}

    def untrack(self, buffer_id):
        with self._lock:
            return self._tracked.pop(buffer_id, None)

    def is_tracked(self, buffer_id):
        with self._lock:
            return buffer_id in self._tracked

    def tracked_ids(self):
        with self._lock:
            return list(self._tracked.keys())

    def shutdown(self):
        # worker thread — HTTP and process control never happen on the main thread
        from mdpreview.server import server_manager
        server_manager().shutdown()


_state = None


def state():
    global _state
    if _state is None:
        _state = MdPreviewState()
    return _state


def plugin_loaded():
    # cheap: just warm the settings handle; the sidecar starts lazily on first preview
    state()


def plugin_unloaded():
    global _state
    current = _state
    _state = None
    if current is not None:
        sublime.set_timeout_async(current.shutdown)
