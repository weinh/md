"""Save-triggered re-render for tracked buffers."""

import sublime
import sublime_plugin

from mdpreview import render as render_mod
from mdpreview.commands import render_and_open
from mdpreview.state import debug_log, state


class MdPreviewEventListener(sublime_plugin.EventListener):
    def on_post_save_async(self, view):
        """Worker thread — hop to the main thread before touching the view."""
        debug_log('on_post_save_async: %s' % (view.file_name() or view.buffer_id()))
        sublime.set_timeout(lambda: self._handle_save(view), 0)

    def _handle_save(self, view):
        # main thread — all view access happens here
        st = state()
        buffer_id = view.buffer_id()
        if not st.settings.get('auto_re_render_on_save', True):
            return
        if not view.is_valid():
            return
        if not st.is_tracked(buffer_id):
            debug_log('save skipped: buffer %s not tracked (tracked: %s)' % (buffer_id, st.tracked_ids()))
            return
        if not render_mod.is_markdown_view(view):
            return
        debug_log('save triggers re-render for buffer %s' % buffer_id)
        snapshot = render_mod.capture_snapshot(view)
        sublime.set_timeout_async(lambda: render_and_open(snapshot, False), 0)

    def on_pre_close(self, view):
        state().untrack(view.buffer_id())
