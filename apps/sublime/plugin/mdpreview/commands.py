"""User-facing commands.

Threading rules (ST4): view/window API only on the main thread. run() snapshots
the buffer on the main thread, then everything else (spawn, HTTP, browser)
happens on worker threads; all UI feedback hops back via sublime.set_timeout.
"""

import webbrowser

import sublime
import sublime_plugin

from mdpreview import render as render_mod
from mdpreview.server import MdServerError, server_manager
from mdpreview.state import debug_log, state


def _on_main(fn, *args):
    sublime.set_timeout(lambda: fn(*args), 0)


def _open_browser(url):
    settings = state().settings
    browser = settings.get('browser', '')
    try:
        if browser:
            webbrowser.get(browser).open(url)
        else:
            webbrowser.open(url)
    except Exception:
        _on_main(sublime.status_message, 'Md Preview: could not open browser — %s' % url)


def render_and_open(snapshot, reveal):
    """Worker thread: POST the markdown to the sidecar, then open/reload the preview.

    ``reveal=True`` opens (or re-focuses) the browser tab — used by the explicit
    open command. ``reveal=False`` (save-triggered re-render) relies on the
    in-page poller to reload, so no tab juggling.
    """
    st = state()
    settings = st.settings

    max_bytes = int(render_mod.setting(settings, 'max_render_bytes'))
    if len(snapshot['markdown'].encode('utf-8')) > max_bytes:
        _on_main(
            sublime.status_message,
            'Md Preview: document exceeds max_render_bytes (%d)' % max_bytes,
        )
        return

    payload = {
        'id': snapshot['id'],
        'markdown': snapshot['markdown'],
        'title': snapshot['title'],
        'pollMs': int(render_mod.setting(settings, 'poll_interval_ms')),
        'previewWidth': render_mod.preview_width_value(settings),
        'options': render_mod.collect_options(settings),
    }
    debug_log('render_and_open: id=%s title=%s reveal=%s bytes=%d'
              % (snapshot['id'], snapshot['title'], reveal, len(snapshot['markdown'])))

    manager = server_manager()
    try:
        result = manager.render(payload)
    except MdServerError as err:
        _on_main(sublime.error_message, str(err))
        return
    except Exception as err:  # noqa: BLE001 — surface unexpected failures instead of a silent console-only traceback
        _on_main(sublime.error_message, 'Md Preview: unexpected error: %s' % err)
        return

    st.track(int(snapshot['id']), result.get('url'), result.get('rev', 0))

    for warning in result.get('warnings') or []:
        _on_main(sublime.status_message, 'Md Preview: %s' % warning)

    if reveal:
        _open_browser('http://127.0.0.1:%d%s' % (manager.port, result.get('url', '')))
    else:
        _on_main(sublime.status_message, 'Md Preview: updated (rev %d)' % result.get('rev', 0))


def _render_copy_async(snapshot):
    st = state()
    settings = st.settings
    payload = {
        'id': snapshot['id'],
        'markdown': snapshot['markdown'],
        'title': snapshot['title'],
        'returnHtml': True,
        'options': dict(render_mod.collect_options(settings), inlineStyles=True),
    }
    manager = server_manager()
    try:
        result = manager.render(payload)
    except MdServerError as err:
        _on_main(sublime.error_message, str(err))
        return
    except Exception as err:  # noqa: BLE001 — surface unexpected failures instead of a silent console-only traceback
        _on_main(sublime.error_message, 'Md Preview: unexpected error: %s' % err)
        return

    html = result.get('html')
    if not html:
        _on_main(sublime.status_message, 'Md Preview: renderer returned no HTML')
        return

    def put_clipboard():
        sublime.set_clipboard(html)
        sublime.status_message('Md Preview: WeChat-ready HTML copied to clipboard')
    _on_main(put_clipboard)


class MdPreviewOpenCommand(sublime_plugin.TextCommand):
    """md_preview_open — open (or refresh) the browser preview for this view."""

    def run(self, edit):
        debug_log('md_preview_open on %s' % (self.view.file_name() or self.view.buffer_id()))
        if not render_mod.is_markdown_view(self.view):
            sublime.status_message('Md Preview: not a Markdown view')
            return
        snapshot = render_mod.capture_snapshot(self.view)
        sublime.set_timeout_async(lambda: render_and_open(snapshot, True), 0)


class MdPreviewCloseCommand(sublime_plugin.TextCommand):
    """md_preview_close — stop re-rendering this buffer on save."""

    def run(self, edit):
        removed = state().untrack(self.view.buffer_id())
        if removed is not None:
            sublime.status_message('Md Preview: preview detached (browser tab may stay open)')
        else:
            sublime.status_message('Md Preview: no preview attached to this view')


class MdPreviewCopyHtmlCommand(sublime_plugin.TextCommand):
    """md_preview_copy_html — WeChat-ready, juice-inlined HTML to the clipboard."""

    def run(self, edit):
        if not render_mod.is_markdown_view(self.view):
            sublime.status_message('Md Preview: not a Markdown view')
            return
        snapshot = render_mod.capture_snapshot(self.view)
        sublime.set_timeout_async(lambda: _render_copy_async(snapshot), 0)


class MdPreviewRestartServerCommand(sublime_plugin.ApplicationCommand):
    """md_preview_restart_server — kill and respawn the renderer sidecar."""

    def run(self):
        def restart_async():
            ok, error = server_manager().restart()
            if not ok:
                _on_main(sublime.error_message, error)
            else:
                _on_main(sublime.status_message, 'Md Preview: renderer server restarted')
        sublime.set_timeout_async(restart_async, 0)


class MdPreviewOpenSettingsCommand(sublime_plugin.WindowCommand):
    """md_preview_open_settings — open the package settings via edit_settings."""

    def run(self):
        self.window.run_command('edit_settings', {
            'base_file': '${packages}/MdPreview/MdPreview.sublime-settings',
        })


class MdPreviewOpenKeymapCommand(sublime_plugin.WindowCommand):
    """md_preview_open_keymap — open the user key bindings for this package."""

    def run(self):
        self.window.run_command('edit_settings', {
            'base_file': '${packages}/MdPreview/Default (%s).sublime-keymap' % sublime.platform(),
        })
