"""Settings -> render-options mapping, buffer snapshots, markdown detection."""

import os

import sublime

SETTINGS_FILE = 'MdPreview.sublime-settings'

# Mirrors MdPreview.sublime-settings; also the fallback for missing keys.
DEFAULTS = {
    'node_binary': '',
    'min_node_version': '20.0.0',
    'browser': '',
    'debug': False,
    'auto_re_render_on_save': True,
    'markdown_file_extensions': ['md', 'markdown', 'mdx'],
    'max_render_bytes': 2097152,
    'poll_interval_ms': 800,
    'preview_width': 'adaptive',
    'server_idle_timeout_seconds': 1800,
    'theme': 'default',
    'primary_color': '#0F4C81',
    'font_family': '-apple-system-font,BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB , Microsoft YaHei UI , Microsoft YaHei ,Arial,sans-serif',
    'font_size': '16px',
    'legend': 'alt',
    'code_block_theme': 'https://cdn-doocs.oss-cn-shenzhen.aliyuncs.com/npm/highlightjs/11.11.1/styles/github-dark.min.css',
    'is_mac_code_block': True,
    'is_show_line_number': False,
    'cite_status': False,
    'count_status': False,
    'theme_mode': 'light',
    'is_use_indent': False,
    'is_use_justify': False,
    'heading_styles': {},
    'custom_css': '',
    'inline_styles': False,
}

# snake_case (Sublime settings) -> camelCase (sidecar render options)
_OPTION_MAP = (
    ('theme', 'theme'),
    ('primary_color', 'primaryColor'),
    ('font_family', 'fontFamily'),
    ('font_size', 'fontSize'),
    ('legend', 'legend'),
    ('code_block_theme', 'codeBlockTheme'),
    ('is_mac_code_block', 'isMacCodeBlock'),
    ('is_show_line_number', 'isShowLineNumber'),
    ('cite_status', 'citeStatus'),
    ('count_status', 'countStatus'),
    ('theme_mode', 'themeMode'),
    ('is_use_indent', 'isUseIndent'),
    ('is_use_justify', 'isUseJustify'),
    ('inline_styles', 'inlineStyles'),
)

MAX_CUSTOM_CSS_BYTES = 100 * 1024

_HEADING_LEVELS = ('h1', 'h2', 'h3', 'h4', 'h5', 'h6')


def setting(settings, key):
    return settings.get(key, DEFAULTS.get(key))


def collect_options(settings):
    """Build the sidecar options payload. The server re-validates everything;
    being typed here only produces friendlier errors."""
    options = {}
    for snake, camel in _OPTION_MAP:
        value = setting(settings, snake)
        if value is not None:
            options[camel] = value

    heading_styles = setting(settings, 'heading_styles')
    if isinstance(heading_styles, dict):
        cleaned = {
            level: style
            for level, style in heading_styles.items()
            if level in _HEADING_LEVELS and isinstance(style, str)
        }
        if cleaned:
            options['headingStyles'] = cleaned

    custom_css = setting(settings, 'custom_css')
    if isinstance(custom_css, str):
        trimmed = custom_css.strip()
        if trimmed and len(trimmed.encode('utf-8')) <= MAX_CUSTOM_CSS_BYTES:
            options['customCSS'] = trimmed

    return options


def preview_width_value(settings):
    """'adaptive' (PC-width layout) or a positive int for a fixed px column
    (e.g. 375 = the WeChat phone article width). Anything invalid falls back
    to 'adaptive'."""
    value = setting(settings, 'preview_width')
    if value == 'adaptive':
        return 'adaptive'
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 'adaptive'
    if number < 200 or number > 4096:
        return 'adaptive'
    return number


def is_markdown_view(view):
    """Extension allow-list first (fast), syntax selector as the fallback."""
    file_name = view.file_name()
    if file_name:
        extension = os.path.splitext(file_name)[1].lstrip('.').lower()
        extensions = setting(_load_settings(), 'markdown_file_extensions')
        if isinstance(extensions, list) and extension in [str(e).lower() for e in extensions]:
            return True
    return bool(view.match_selector(0, 'text.html.markdown'))


def _load_settings():
    return sublime.load_settings(SETTINGS_FILE)


def capture_snapshot(view):
    """Main-thread only — reads the buffer text before hopping to a worker."""
    file_name = view.file_name()
    if file_name:
        title = os.path.splitext(os.path.basename(file_name))[0]
    else:
        title = view.name() or 'Untitled'
    return {
        'id': str(view.buffer_id()),
        'markdown': view.substr(sublime.Region(0, view.size())),
        'title': title,
        'file_name': file_name or '',
    }
