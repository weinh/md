"""Md Preview — plugin entry module.

This is the only top-level .py file in the package. It puts the package
directory on ``sys.path`` (works both for unpacked folders and zipped
``.sublime-package`` installs via zipimporter) and re-exports the command and
listener classes so Sublime's plugin host can discover them.

Keep this file dependency-free; everything substantial lives in mdpreview/.
"""

import os
import sys

_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
if _PACKAGE_DIR not in sys.path:
    sys.path.insert(0, _PACKAGE_DIR)

from mdpreview.commands import (  # noqa: E402
    MdPreviewCloseCommand,
    MdPreviewCopyHtmlCommand,
    MdPreviewOpenCommand,
    MdPreviewOpenKeymapCommand,
    MdPreviewOpenSettingsCommand,
    MdPreviewRestartServerCommand,
)
from mdpreview.commands import render_and_open  # noqa: E402
from mdpreview.listener import MdPreviewEventListener  # noqa: E402
from mdpreview.state import plugin_loaded, plugin_unloaded, state  # noqa: E402

__all__ = [
    'MdPreviewCloseCommand',
    'MdPreviewCopyHtmlCommand',
    'MdPreviewOpenCommand',
    'MdPreviewOpenKeymapCommand',
    'MdPreviewOpenSettingsCommand',
    'MdPreviewRestartServerCommand',
    'MdPreviewEventListener',
    'render_and_open',
    'plugin_loaded',
    'plugin_unloaded',
    'state',
]
