"""Renderer sidecar lifecycle: node discovery, spawn, health, restart, HTTP client.

Threading model: every method here runs on a worker thread (the commands hop
off the main thread via sublime.set_timeout_async before touching this module).
"""

import glob
import http.client
import json
import os
import shutil
import subprocess
import threading
import time
import zipfile

import sublime

SETTINGS_FILE = 'MdPreview.sublime-settings'

# keep in sync with apps/sublime/package.json "version"
VERSION = '0.1.0'

STARTUP_TIMEOUT = 20.0
REQUEST_TIMEOUT = 60.0
SHUTDOWN_TIMEOUT = 3.0
MAX_RESTARTS = 3
RESTART_WINDOW = 60.0


class MdServerError(Exception):
    pass


def _settings():
    return sublime.load_settings(SETTINGS_FILE)


def _package_root():
    """Real directory when unpacked; the .sublime-package zip path when zipped."""
    import mdpreview
    return os.path.dirname(os.path.dirname(os.path.abspath(mdpreview.__file__)))


def resolve_node_binary():
    """settings node_binary -> PATH -> common install locations (incl. nvm)."""
    candidates = []
    configured = _settings().get('node_binary', '')
    if configured:
        candidates.append(configured)
    on_path = shutil.which('node')
    if on_path:
        candidates.append(on_path)
    if sublime.platform() in ('osx', 'linux'):
        candidates.extend(['/usr/local/bin/node', '/opt/homebrew/bin/node'])
        home = os.path.expanduser('~')
        # newest first, so the latest nvm-installed node wins
        candidates.extend(sorted(
            glob.glob(os.path.join(home, '.nvm', 'versions', 'node', '*', 'bin', 'node')),
            reverse=True,
        ))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _version_tuple(text):
    parts = []
    for chunk in str(text).strip().lstrip('vV').split('.'):
        digits = ''.join(c for c in chunk if c.isdigit())
        parts.append(int(digits) if digits else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def check_node_version(binary):
    """Returns (ok, error_message)."""
    minimum = _settings().get('min_node_version', '20.0.0')
    try:
        output = subprocess.run(
            [binary, '--version'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=15,
        ).stdout.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return False, 'Md Preview: could not run "%s". Set "node_binary" in the settings.' % binary
    actual = _version_tuple(output)
    if actual < _version_tuple(minimum):
        return False, (
            'Md Preview: Node.js >= %s is required, "%s" reports %s. '
            'Update Node or point "node_binary" at a newer binary.'
            % (minimum, binary, output.strip() or 'unknown')
        )
    return True, None


def _renderer_script():
    """Locate server.cjs — in the package dir when unpacked, else extracted to cache."""
    in_package = os.path.join(_package_root(), 'renderer', 'server.cjs')
    if os.path.isfile(in_package):
        return in_package

    # zipped .sublime-package install: extract renderer/ (bundle + runtime
    # node_modules) into the cache dir once per version, then run it from there
    package_root = _package_root()
    if not package_root.endswith('.sublime-package'):
        return in_package  # unpacked but missing — let the caller report it

    cache_dir = os.path.join(sublime.cache_path(), 'MdPreview')
    extracted = os.path.join(cache_dir, 'renderer', 'server.cjs')
    stamp = os.path.join(cache_dir, 'renderer.version')
    try:
        with open(stamp, 'r', encoding='utf-8') as handle:
            if handle.read().strip() == VERSION and os.path.isfile(extracted):
                return extracted
    except OSError:
        pass

    os.makedirs(cache_dir, exist_ok=True)
    with zipfile.ZipFile(package_root) as archive:
        members = [name for name in archive.namelist() if name.startswith('renderer/')]
        archive.extractall(cache_dir, members=members)
    with open(stamp, 'w', encoding='utf-8') as handle:
        handle.write(VERSION + '\n')
    return extracted


def _read_startup_line(pipe, timeout):
    """Blocking pipe reads have no timeout — race a daemon reader thread against one."""
    holder = {}

    def reader():
        try:
            holder['line'] = pipe.readline().decode('utf-8', 'replace').strip()
        except Exception:
            holder['line'] = ''

    thread = threading.Thread(target=reader)
    thread.daemon = True
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        return None
    return holder.get('line', '')


class MdServerProcess(object):
    def __init__(self):
        self._lock = threading.Lock()
        self._proc = None
        self._port = None
        self._token = None
        self._restart_times = []
        self._log_path = os.path.join(sublime.cache_path(), 'MdPreview', 'server.log')

    @property
    def port(self):
        return self._port

    def ensure_running(self):
        """Returns (ok, error_message). Worker thread only."""
        with self._lock:
            if self._healthy_locked():
                return True, None
            return self._start_locked()

    # --- internals (call with self._lock held) -------------------------------

    def _healthy_locked(self):
        if self._proc is None or self._port is None:
            return False
        if self._proc.poll() is not None:
            return False
        try:
            status, body = self._request('GET', '/health', timeout=5.0)
            return status == 200 and json.loads(body).get('ok') is True
        except Exception:
            return False

    def _start_locked(self):
        # reap any leftover process before spawning a replacement
        stale = self._proc
        if stale is not None:
            try:
                stale.terminate()
            except Exception:
                pass
        stale_handle = getattr(self, '_log_handle', None)
        if stale_handle is not None:
            try:
                stale_handle.close()
            except Exception:
                pass
            self._log_handle = None

        now = time.time()
        self._restart_times = [t for t in self._restart_times if now - t < RESTART_WINDOW]
        if len(self._restart_times) >= MAX_RESTARTS:
            return False, (
                'Md Preview: renderer server crashed %d times within %d seconds; giving up. '
                'See the log at %s'
                % (MAX_RESTARTS, int(RESTART_WINDOW), self._log_path)
            )

        node = resolve_node_binary()
        if node is None:
            return False, (
                'Md Preview: Node.js not found. Install Node.js %s or newer, or set '
                '"node_binary" in Md Preview settings.'
                % _settings().get('min_node_version', '20.0.0')
            )
        version_ok, version_error = check_node_version(node)
        if not version_ok:
            return False, version_error

        try:
            script = _renderer_script()
        except (OSError, zipfile.BadZipFile) as err:
            return False, 'Md Preview: could not extract the renderer: %s' % err
        if not os.path.isfile(script):
            return False, 'Md Preview: renderer/server.cjs is missing — reinstall the package.'

        self._restart_times.append(now)

        env = os.environ.copy()
        env['MD_IDLE_SECONDS'] = str(int(_settings().get('server_idle_timeout_seconds', 1800)))
        env.pop('NODE_OPTIONS', None)

        os.makedirs(os.path.dirname(self._log_path), exist_ok=True)
        log_handle = open(self._log_path, 'ab')
        try:
            proc = subprocess.Popen(
                [node, script],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=log_handle,
                cwd=os.path.dirname(script),
                env=env,
            )
        except OSError as err:
            log_handle.close()
            return False, 'Md Preview: failed to start the renderer: %s' % err

        line = _read_startup_line(proc.stdout, STARTUP_TIMEOUT)
        if line is None or not line.startswith('MDP1 '):
            proc.kill()
            proc.wait()
            log_handle.close()
            return False, (
                'Md Preview: renderer failed to start (no MDP1 line). '
                'See the log at %s' % self._log_path
            )

        parts = line.split()
        if len(parts) != 3 or not parts[1].isdigit():
            proc.kill()
            proc.wait()
            log_handle.close()
            return False, 'Md Preview: unexpected renderer startup line: %r' % line

        # keep draining stdout so the pipe never fills and blocks the server
        threading.Thread(target=self._drain_stdout, args=(proc,), daemon=True).start()

        self._proc = proc
        self._port = int(parts[1])
        self._token = parts[2]
        # keep a handle so the file doesn't close (and the fd be reused) while live
        self._log_handle = log_handle
        return True, None

    def _drain_stdout(self, proc):
        try:
            for chunk in iter(lambda: proc.stdout.readline(), b''):
                if _settings().get('debug', False):
                    try:
                        with open(self._log_path, 'ab') as handle:
                            handle.write(b'[stdout] ' + chunk)
                    except OSError:
                        pass
        except Exception:
            pass

    # --- client API -----------------------------------------------------------

    def _request(self, method, path, body=None, timeout=REQUEST_TIMEOUT):
        if self._port is None:
            raise MdServerError('renderer server is not running')
        payload = None
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers = {'X-MD-Token': self._token or ''}
        if payload is not None:
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = str(len(payload))
        conn = http.client.HTTPConnection('127.0.0.1', self._port, timeout=timeout)
        try:
            conn.request(method, path, body=payload, headers=headers)
            response = conn.getresponse()
            data = response.read().decode('utf-8', 'replace')
            status = response.status
        finally:
            conn.close()
        return status, data

    def render(self, payload):
        """POST /render with one transparent retry after a server death."""
        ok, error = self.ensure_running()
        if not ok:
            raise MdServerError(error)

        for _attempt in (0, 1):
            try:
                status, body = self._request('POST', '/render', body=payload)
            except (OSError, http.client.HTTPException) as err:
                status, body = None, str(err)

            if status == 200:
                try:
                    data = json.loads(body)
                except ValueError:
                    raise MdServerError('renderer returned invalid JSON')
                if data.get('ok'):
                    return data
                raise MdServerError(data.get('error') or 'render failed')

            if status is None or status == 401:
                with self._lock:
                    if status == 401 and self._proc is not None and self._proc.poll() is None:
                        ok, error = False, 'renderer rejected the session token'
                    elif self._healthy_locked():
                        # server is fine — the request itself timed out or failed
                        ok, error = False, 'renderer request failed: %s' % body
                    else:
                        ok, error = self._start_locked()
                if not ok:
                    raise MdServerError(error)
                continue

            try:
                message = json.loads(body).get('error') or body
            except ValueError:
                message = body
            raise MdServerError('renderer rejected the request: %s' % message)

        raise MdServerError('render failed after retry')

    def shutdown(self):
        with self._lock:
            proc, port, token = self._proc, self._port, self._token
            self._proc = None
            self._port = None
            self._token = None
            self._restart_times = []
        if proc is None:
            return
        try:
            if port is not None:
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=SHUTDOWN_TIMEOUT)
                try:
                    conn.request('POST', '/shutdown', headers={'X-MD-Token': token or ''})
                    conn.getresponse().read()
                finally:
                    conn.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=SHUTDOWN_TIMEOUT)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        handle = getattr(self, '_log_handle', None)
        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass
            self._log_handle = None

    def restart(self):
        self.shutdown()
        ok, error = self.ensure_running()
        return ok, error


_manager = None
_manager_lock = threading.Lock()


def server_manager():
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = MdServerProcess()
        return _manager
